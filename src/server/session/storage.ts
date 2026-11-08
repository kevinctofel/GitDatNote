/**
 * SQLite session storage implementation (task 3.1, design.md A-04).
 *
 * `better-sqlite3` is synchronous and single-connection, which is correct
 * for a single-user tool. The whole module lives inside the server
 * boundary: no frontend code may import it, and no raw SQL or token values
 * cross the public API surface — only the `SessionStorage` interface and
 * stable error codes do.
 *
 * Failure handling: every SQLite failure (open, schema, prepare, statement,
 * runtime) is mapped to a stable `SessionStorageError` with code `DB_ERROR`
 * and a fixed message — never SQL text, database paths, or raw SQLite error
 * text. Typed session errors raised by this module itself (for example
 * `DECRYPTION_FAILED`, `STORAGE_NOT_OPEN`) are preserved unchanged.
 *
 * File security (POSIX): the database file is kept private to the current
 * user (mode 0600) and any session-storage directory segments created here
 * are private (mode 0700). Existing files are re-secured (content untouched)
 * and existing directories are never chmod'ed. On platforms without
 * meaningful permission bits (e.g. Windows) these checks are skipped.
 *
 * Schema (all timestamps are epoch milliseconds):
 *
 *   sessions (
 *     session_id            TEXT PRIMARY KEY,  -- 64 random hex chars
 *     user_login            TEXT NOT NULL,
 *     user_name             TEXT NOT NULL,
 *     user_avatar_url       TEXT NOT NULL,
 *     csrf_token            TEXT NOT NULL,     -- 64 random hex chars
 *     token_encrypted       TEXT NOT NULL,     -- AES-256-GCM v1 payload
 *     refresh_token_encrypted TEXT NOT NULL,   -- AES-256-GCM v1 payload
 *     token_expires_at      INTEGER NOT NULL,
 *     refresh_expires_at    INTEGER NOT NULL,
 *     created_at            INTEGER NOT NULL
 *   )
 *
 * Session expiration is enforced here (storage layer): a session whose
 * `created_at` plus the configured maximum age is in the past is rejected
 * as `expired` on lookup — it is not left to cookie expiry alone — and
 * credential rotation on an expired session is refused before any write.
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, statSync } from 'node:fs';

import Database from 'better-sqlite3';

import { ensureSessionDbParent, IS_POSIX, maxAgeMs, type SessionConfig } from './config.js';
import { openSecret, sealSecret } from './crypto.js';
import {
  SessionStorageError,
  type CreateSessionInput,
  type SessionLookupResult,
  type SessionStorage,
  type SessionCredentials,
  type StoredSession,
} from './types.js';

/** Session IDs: 32 random bytes -> 64 hex characters. */
const SESSION_ID_BYTES = 32;
/** CSRF values: 32 random bytes -> 64 hex characters. */
const CSRF_TOKEN_BYTES = 32;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  user_login TEXT NOT NULL,
  user_name TEXT NOT NULL,
  user_avatar_url TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  token_expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`;

interface SessionRow {
  session_id: string;
  user_login: string;
  user_name: string;
  user_avatar_url: string;
  csrf_token: string;
  token_encrypted: string;
  refresh_token_encrypted: string;
  token_expires_at: number;
  refresh_expires_at: number;
  created_at: number;
}

interface SealedCredentials {
  tokenEncrypted: string;
  refreshTokenEncrypted: string;
  tokenExpiresAt: number;
  refreshExpiresAt: number;
}

type RotateOutcome =
  | { kind: 'missing' }
  | { kind: 'expired' }
  | { kind: 'rotated' };

type DatabaseHandle = InstanceType<typeof Database>;

/**
 * Stable, outward-safe error for SQLite failures. The message is a fixed
 * string: it never carries SQL text, database paths, or raw SQLite error
 * text, and the code is always `DB_ERROR`.
 */
function dbError(message: string): SessionStorageError {
  return new SessionStorageError('DB_ERROR', message);
}

/**
 * Run a database operation, mapping any non-`SessionStorageError` failure
 * (SQLite runtime error, I/O error, constraint error, ...) to a stable
 * `DB_ERROR`. Typed session errors raised inside the operation (for example
 * `DECRYPTION_FAILED`) are rethrown unchanged.
 */
function guard<T>(message: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof SessionStorageError) throw err;
    throw dbError(message);
  }
}

/** Best-effort close used while unwinding a failed initialization. */
function closeQuietly(db: DatabaseHandle): void {
  try {
    db.close();
  } catch {
    // Unwind path: a secondary close failure must not mask the original.
  }
}

/**
 * Keep the session database file private on POSIX systems. The file holds
 * encrypted credentials, so:
 * - a newly created file (which SQLite creates with the process umask,
 *   typically world-readable 0644) is made 0600;
 * - an existing file is re-secured to 0600 (its content is never modified);
 * - if the file cannot be made private, initialization fails closed with a
 *   stable `DB_ERROR` rather than storing credentials in a readable file.
 * On platforms without meaningful permission bits (e.g. Windows) the check
 * is skipped.
 */
function secureSessionDbFile(path: string): void {
  if (!IS_POSIX) return;
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    throw dbError('Could not secure the session database file.');
  }
  if ((mode & 0o777) === 0o600) return;
  try {
    chmodSync(path, 0o600);
    mode = statSync(path).mode;
  } catch {
    throw dbError('Could not secure the session database file.');
  }
  if ((mode & 0o777) !== 0o600) {
    throw dbError('Session database file is not private.');
  }
}

/** Open (and initialize, if needed) session storage for a resolved config. */
export function openSessionStorage(config: SessionConfig): SessionStorage {
  ensureSessionDbParent(config.dbPath);

  let db: DatabaseHandle;
  try {
    db = new Database(config.dbPath);
  } catch {
    throw dbError('Could not open the session database.');
  }

  // The file may have just been created (umask 0644 by default) or already
  // existed with drifted permissions; secure it before any data is written.
  // If securing fails, close the handle we just opened before propagating
  // the stable SessionStorageError — no live connection may outlive a failed
  // initialization.
  try {
    secureSessionDbFile(config.dbPath);
  } catch (err) {
    closeQuietly(db);
    throw err;
  }

  try {
    db.exec(SCHEMA);
  } catch {
    closeQuietly(db);
    throw dbError('Could not initialize the session database schema.');
  }

  let stmts: {
    insert: Database.Statement;
    select: Database.Statement;
    update: Database.Statement;
    remove: Database.Statement;
    purge: Database.Statement;
  };
  try {
    stmts = {
      insert: db.prepare(
        `INSERT INTO sessions (
           session_id, user_login, user_name, user_avatar_url, csrf_token,
           token_encrypted, refresh_token_encrypted,
           token_expires_at, refresh_expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      select: db.prepare(`SELECT * FROM sessions WHERE session_id = ?`),
      update: db.prepare(
        `UPDATE sessions
           SET token_encrypted = ?,
               refresh_token_encrypted = ?,
               token_expires_at = ?,
               refresh_expires_at = ?
         WHERE session_id = ?`,
      ),
      remove: db.prepare(`DELETE FROM sessions WHERE session_id = ?`),
      purge: db.prepare(`DELETE FROM sessions WHERE created_at + ? <= ?`),
    };
  } catch {
    closeQuietly(db);
    throw dbError('Could not prepare the session database statements.');
  }

  // The stored encrypted token pair and both expiry timestamps are replaced
  // by a single statement inside a transaction: refresh rotation is
  // all-or-nothing. The expiration check reads `created_at` inside that same
  // transaction, so the check and the update cannot interleave — an expired
  // session is reported (without being modified) rather than rotated.
  const rotate = db.transaction((sessionId: string, creds: SealedCredentials): RotateOutcome => {
    const row = stmts.select.get(sessionId) as Pick<SessionRow, 'created_at'> | undefined;
    if (row === undefined) return { kind: 'missing' };
    if (config.now() >= row.created_at + maxAgeMs(config.maxAgeDays)) {
      return { kind: 'expired' };
    }
    const result = stmts.update.run(
      creds.tokenEncrypted,
      creds.refreshTokenEncrypted,
      creds.tokenExpiresAt,
      creds.refreshExpiresAt,
      sessionId,
    );
    return result.changes > 0 ? { kind: 'rotated' } : { kind: 'missing' };
  });

  let open = true;

  function assertOpen(): void {
    if (!open) {
      throw new SessionStorageError(
        'STORAGE_NOT_OPEN',
        'Session storage is closed.',
      );
    }
  }

  function validateCredentials(creds: SessionCredentials): void {
    const bad =
      typeof creds.accessToken !== 'string' ||
      creds.accessToken.length === 0 ||
      typeof creds.refreshToken !== 'string' ||
      creds.refreshToken.length === 0 ||
      !Number.isFinite(creds.tokenExpiresAt) ||
      !Number.isFinite(creds.refreshExpiresAt);
    if (bad) {
      throw new SessionStorageError(
        'INVALID_CREDENTIALS',
        'Session credentials must contain non-empty tokens and finite expiries.',
      );
    }
  }

  function lookup(sessionId: string): SessionLookupResult {
    if (!/^[0-9a-f]{64}$/.test(sessionId)) return { status: 'missing' };
    return guard('Could not read the session.', () => {
      const row = stmts.select.get(sessionId) as SessionRow | undefined;
      if (row === undefined) return { status: 'missing' } as SessionLookupResult;
      if (config.now() >= row.created_at + maxAgeMs(config.maxAgeDays)) {
        return { status: 'expired' } as SessionLookupResult;
      }
      const accessToken = openSecret(row.token_encrypted, config.encryptionKey);
      const refreshToken = openSecret(row.refresh_token_encrypted, config.encryptionKey);
      if (accessToken === null || refreshToken === null) {
        // Stored ciphertext failed authentication: treat as corrupted and
        // fail closed. The stable code keeps raw crypto errors off clients.
        throw new SessionStorageError(
          'DECRYPTION_FAILED',
          'Stored session credentials could not be decrypted.',
        );
      }
      return {
        status: 'found',
        session: {
          sessionId: row.session_id,
          user: {
            login: row.user_login,
            name: row.user_name,
            avatarUrl: row.user_avatar_url,
          },
          createdAt: row.created_at,
          expiresAt: row.created_at + maxAgeMs(config.maxAgeDays),
          csrfToken: row.csrf_token,
          credentials: {
            accessToken,
            refreshToken,
            tokenExpiresAt: row.token_expires_at,
            refreshExpiresAt: row.refresh_expires_at,
          },
        },
      } satisfies SessionLookupResult;
    });
  }

  const storage: SessionStorage = {
    createSession(input: CreateSessionInput): StoredSession {
      assertOpen();
      validateCredentials(input.credentials);
      return guard('Could not create the session.', () => {
        const sessionId = randomBytes(SESSION_ID_BYTES).toString('hex');
        const csrfToken = randomBytes(CSRF_TOKEN_BYTES).toString('hex');
        const createdAt = config.now();
        stmts.insert.run(
          sessionId,
          input.user.login,
          input.user.name,
          input.user.avatarUrl,
          csrfToken,
          sealSecret(input.credentials.accessToken, config.encryptionKey),
          sealSecret(input.credentials.refreshToken, config.encryptionKey),
          input.credentials.tokenExpiresAt,
          input.credentials.refreshExpiresAt,
          createdAt,
        );
        return {
          sessionId,
          user: { ...input.user },
          createdAt,
          expiresAt: createdAt + maxAgeMs(config.maxAgeDays),
          csrfToken,
          credentials: { ...input.credentials },
        };
      });
    },

    getSession(sessionId: string): SessionLookupResult {
      assertOpen();
      return lookup(sessionId);
    },

    rotateCredentials(
      sessionId: string,
      credentials: SessionCredentials,
    ): SessionLookupResult | undefined {
      assertOpen();
      validateCredentials(credentials);
      const sealed: SealedCredentials = {
        tokenEncrypted: sealSecret(credentials.accessToken, config.encryptionKey),
        refreshTokenEncrypted: sealSecret(credentials.refreshToken, config.encryptionKey),
        tokenExpiresAt: credentials.tokenExpiresAt,
        refreshExpiresAt: credentials.refreshExpiresAt,
      };
      const outcome = guard('Could not rotate the session credentials.', () =>
        rotate(sessionId, sealed),
      );
      if (outcome.kind === 'missing') return undefined;
      if (outcome.kind === 'expired') return { status: 'expired' };
      return lookup(sessionId);
    },

    deleteSession(sessionId: string): boolean {
      assertOpen();
      if (!/^[0-9a-f]{64}$/.test(sessionId)) return false;
      return guard('Could not delete the session.', () => stmts.remove.run(sessionId).changes > 0);
    },

    purgeExpiredSessions(): number {
      assertOpen();
      return guard(
        'Could not purge expired sessions.',
        () => stmts.purge.run(maxAgeMs(config.maxAgeDays), config.now()).changes,
      );
    },

    close(): void {
      if (!open) return;
      open = false;
      try {
        db.close();
      } catch {
        throw dbError('Could not close the session database.');
      }
    },
  };

  return storage;
}

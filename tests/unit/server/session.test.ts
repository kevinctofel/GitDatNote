/**
 * Task 3.1 — session storage and credential encryption tests.
 *
 * All databases are temporary (created under the OS temp dir) and removed
 * afterwards. No real GitHub credentials or repositories are used: tokens
 * are obviously fake test values. A deterministic injected clock keeps the
 * expiration tests flake-free.
 */

import {
  mkdtempSync,
  existsSync,
  rmSync,
  chmodSync,
  statSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
} from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  parseEncryptionKey,
  sealSecret,
  openSecret,
  resolveSessionConfig,
  ensureSessionDbParent,
  maxAgeMs,
  openSessionStorage,
  SessionStorageError,
} from '../../../src/server/session/index.js';

const DAY_MS = 86400000;

/** Test-only 256-bit key (64 hex chars). Never a real secret. */
const TEST_KEY =
  '3a7bd3e2360a3d29eea436fcfbef e70c'.replace(' ', '') +
  '434e20d53060c66e0c2f6a3f4a9c7e58';

/** Obviously fake GitHub-shaped tokens for tests only. */
const ACCESS_TOKEN = 'gho_test_access_AbCdEf12345';
const REFRESH_TOKEN = 'ghr_test_refresh_XyZ98765';
const ACCESS_TOKEN_2 = 'gho_test_access_Rotated6789';
const REFRESH_TOKEN_2 = 'ghr_test_refresh_Rotated012';

const USER = {
  login: 'test-user',
  name: 'Test User',
  avatarUrl: 'https://avatars.example/u/1.png',
};

let dirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gitdatnote-session-'));
  dirs.push(dir);
  return join(dir, 'sessions.db');
}

function key(): Buffer {
  const parsed = parseEncryptionKey(TEST_KEY);
  if (parsed === null) throw new Error('test key must be valid 64-hex');
  return parsed;
}

function creds(
  tokenExpiresAt: number,
  refreshExpiresAt: number,
  access = ACCESS_TOKEN,
  refresh = REFRESH_TOKEN,
) {
  return {
    accessToken: access,
    refreshToken: refresh,
    tokenExpiresAt,
    refreshExpiresAt,
  };
}

function openTestStorage(
  dbPath: string,
  options: { maxAgeDays?: number; now?: () => number } = {},
) {
  return openSessionStorage({
    dbPath,
    encryptionKey: key(),
    maxAgeDays: options.maxAgeDays ?? 7,
    now: options.now ?? (() => 0),
  });
}

/** Open a second raw connection to inspect stored bytes directly. */
function rawTable(dbPath: string, sessionId: string): Record<string, unknown> {
  const db = new Database(dbPath);
  try {
    const row = db
      .prepare('SELECT * FROM sessions WHERE session_id = ?')
      .get(sessionId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error('row missing');
    return row;
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe('session storage lifecycle', () => {
  it('creates and retrieves a valid session', () => {
    const path = tempDbPath();
    const clock = 1_750_000_000_000;
    const now = () => clock;
    const storage = openTestStorage(path, { now });

    const created = storage.createSession({ user: USER, credentials: creds(clock + 3600e3, clock + 30 * DAY_MS) });

    expect(created.sessionId).toMatch(/^[0-9a-f]{64}$/);
    expect(created.csrfToken).toMatch(/^[0-9a-f]{64}$/);
    expect(created.createdAt).toBe(clock);
    expect(created.expiresAt).toBe(clock + 7 * DAY_MS);

    const result = storage.getSession(created.sessionId);
    expect(result.status).toBe('found');
    if (result.status === 'found') {
      expect(result.session.user).toEqual(USER);
      expect(result.session.csrfToken).toBe(created.csrfToken);
      expect(result.session.credentials.accessToken).toBe(ACCESS_TOKEN);
      expect(result.session.credentials.refreshToken).toBe(REFRESH_TOKEN);
    }
    storage.close();
  });

  it('persists sessions across database close and reopen', () => {
    const path = tempDbPath();
    let clock = 1_750_000_000_000;
    const now = () => clock;

    let storage = openTestStorage(path, { now });
    clock = 1_750_000_000_000;
    const created = storage.createSession({ user: USER, credentials: creds(clock + 3600e3, clock + 30 * DAY_MS) });
    storage.close();

    storage = openTestStorage(path, { now });
    clock += 5000;
    const result = storage.getSession(created.sessionId);
    expect(result.status).toBe('found');
    if (result.status === 'found') {
      expect(result.session.user).toEqual(USER);
      expect(result.session.credentials.accessToken).toBe(ACCESS_TOKEN);
      expect(result.session.credentials.refreshToken).toBe(REFRESH_TOKEN);
      expect(result.session.expiresAt).toBe(created.createdAt + 7 * DAY_MS);
    }
    storage.close();
  });

  it('deletes a session and reports it missing afterwards', () => {
    const path = tempDbPath();
    const clock = 1_750_000_000_000;
    const storage = openTestStorage(path, { now: () => clock });
    const created = storage.createSession({ user: USER, credentials: creds(clock + 3600e3, clock + 30 * DAY_MS) });

    expect(storage.deleteSession(created.sessionId)).toBe(true);
    expect(storage.deleteSession(created.sessionId)).toBe(false);
    expect(storage.getSession(created.sessionId)).toEqual({ status: 'missing' });
    storage.close();
  });

  it('reports missing sessions for unknown and malformed ids', () => {
    const path = tempDbPath();
    const storage = openTestStorage(path, { now: () => 1_750_000_000_000 });
    const unknownId = 'ab'.repeat(32);
    expect(storage.getSession(unknownId)).toEqual({ status: 'missing' });
    expect(storage.getSession('not-a-session-id')).toEqual({ status: 'missing' });
    expect(storage.getSession('')).toEqual({ status: 'missing' });
    expect(storage.deleteSession('not-a-session-id')).toBe(false);
    storage.close();
  });

  it('rejects expired sessions at the storage layer', () => {
    const path = tempDbPath();
    let clock = 1_750_000_000_000;
    const storage = openTestStorage(path, { now: () => clock });
    const created = storage.createSession({ user: USER, credentials: creds(clock + 3600e3, clock + 30 * DAY_MS) });

    // One millisecond before the boundary: still active.
    clock = created.expiresAt - 1;
    expect(storage.getSession(created.sessionId).status).toBe('found');

    // At and past the boundary: rejected as expired.
    clock = created.expiresAt;
    expect(storage.getSession(created.sessionId)).toEqual({ status: 'expired' });
    clock = created.expiresAt + DAY_MS;
    expect(storage.getSession(created.sessionId)).toEqual({ status: 'expired' });
    storage.close();
  });

  it('honors the configured session lifetime', () => {
    const path = tempDbPath();
    let clock = 1_750_000_000_000;
    const storage = openTestStorage(path, { maxAgeDays: 2, now: () => clock });
    const created = storage.createSession({ user: USER, credentials: creds(clock + 3600e3, clock + 30 * DAY_MS) });

    expect(created.expiresAt).toBe(clock + 2 * DAY_MS);
    clock = created.createdAt + DAY_MS + 60_000;
    expect(storage.getSession(created.sessionId).status).toBe('found');
    clock = created.createdAt + 2 * DAY_MS;
    expect(storage.getSession(created.sessionId)).toEqual({ status: 'expired' });
    storage.close();
  });

  it('rotates both encrypted credentials and expiries atomically', () => {
    const path = tempDbPath();
    let clock = 1_750_000_000_000;
    const storage = openTestStorage(path, { now: () => clock });
    const created = storage.createSession({ user: USER, credentials: creds(clock + 3600e3, clock + 30 * DAY_MS) });

    const before = rawTable(path, created.sessionId);
    clock += 1800e3;
    const rotated = storage.rotateCredentials(
      created.sessionId,
      creds(clock + 3600e3, clock + 60 * DAY_MS, ACCESS_TOKEN_2, REFRESH_TOKEN_2),
    );
    expect(rotated?.status).toBe('found');
    if (rotated !== undefined && rotated.status === 'found') {
      expect(rotated.session.credentials.accessToken).toBe(ACCESS_TOKEN_2);
      expect(rotated.session.credentials.refreshToken).toBe(REFRESH_TOKEN_2);
    }

    const after = rawTable(path, created.sessionId);
    // Both ciphertexts were replaced and both expiries updated together.
    expect(after.token_encrypted).not.toBe(before.token_encrypted);
    expect(after.refresh_token_encrypted).not.toBe(before.refresh_token_encrypted);
    expect(after.token_expires_at).toBe(clock + 3600e3);
    expect(after.refresh_expires_at).toBe(clock + 60 * DAY_MS);
    // The old encrypted values are gone from the table.
    const allRows = (() => {
      const db = new Database(path);
      try {
        return db.prepare('SELECT * FROM sessions').all() as Array<Record<string, unknown>>;
      } finally {
        db.close();
      }
    })();
    for (const row of allRows) {
      expect(row.token_encrypted).not.toBe(before.token_encrypted);
      expect(row.refresh_token_encrypted).not.toBe(before.refresh_token_encrypted);
    }

    // Rotating an unknown session is a no-op, not an error.
    expect(storage.rotateCredentials('cd'.repeat(32), creds(clock, clock))).toBeUndefined();
    storage.close();
  });

  it('purges only expired sessions', () => {
    const path = tempDbPath();
    let clock = 1_750_000_000_000;
    const storage = openTestStorage(path, { maxAgeDays: 2, now: () => clock });
    const aged = storage.createSession({ user: USER, credentials: creds(clock + 3600e3, clock + 30 * DAY_MS) });
    clock += 1.5 * DAY_MS;
    const live = storage.createSession({ user: USER, credentials: creds(clock + 3600e3, clock + 30 * DAY_MS) });
    clock += DAY_MS; // now: aged is 2.5 days old, live is 1.0 day old
    expect(storage.purgeExpiredSessions()).toBe(1);
    expect(storage.getSession(aged.sessionId)).toEqual({ status: 'missing' });
    expect(storage.getSession(live.sessionId).status).toBe('found');
    storage.close();
  });
});

describe('credential encryption (AES-256-GCM)', () => {
  const k = key();

  it('round-trips access and refresh tokens', () => {
    expect(openSecret(sealSecret(ACCESS_TOKEN, k), k)).toBe(ACCESS_TOKEN);
    expect(openSecret(sealSecret(REFRESH_TOKEN, k), k)).toBe(REFRESH_TOKEN);
  });

  it('produces a different ciphertext and IV for each encryption', () => {
    const a = sealSecret(ACCESS_TOKEN, k);
    const b = sealSecret(ACCESS_TOKEN, k);
    expect(a).not.toBe(b);
    const [, ivA, , ctA] = a.split(':');
    const [, ivB, , ctB] = b.split(':');
    expect(ivA).not.toBe(ivB);
    expect(ctA).not.toBe(ctB);
    // Payload layout: v1:<iv>:<tag>:<ciphertext>
    expect(a.startsWith('v1:')).toBe(true);
    expect(ivA).toMatch(/^[0-9a-f]{24}$/);
    const [, , tagA] = a.split(':');
    expect(tagA).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects tampered ciphertext', () => {
    const payload = sealSecret(ACCESS_TOKEN, k);
    const parts = payload.split(':');
    // Flip one hex digit of the ciphertext.
    const ct = parts[3];
    const flipped = (ct[0] === '0' ? '1' : '0') + ct.slice(1);
    expect(openSecret(`${parts[0]}:${parts[1]}:${parts[2]}:${flipped}`, k)).toBeNull();
  });

  it('rejects an invalid authentication tag', () => {
    const payload = sealSecret(ACCESS_TOKEN, k);
    const parts = payload.split(':');
    const tag = parts[2];
    const flipped = (tag[0] === '0' ? '1' : '0') + tag.slice(1);
    expect(openSecret(`${parts[0]}:${parts[1]}:${flipped}:${parts[3]}`, k)).toBeNull();
  });

  it('rejects malformed payloads', () => {
    const good = sealSecret(ACCESS_TOKEN, k);
    const [version, iv, tag, ct] = good.split(':');
    expect(openSecret(`${version}:${iv}:${tag}`, k)).toBeNull(); // missing segment
    expect(openSecret(`${version}:${iv}:${tag}:${ct}:extra`, k)).toBeNull(); // extra segment
    expect(openSecret(`v2:${iv}:${tag}:${ct}`, k)).toBeNull(); // unknown version
    expect(openSecret(`${version}:zz:${tag}:${ct}`, k)).toBeNull(); // bad iv hex
    expect(openSecret(`${version}:${iv}:${tag}:abc`, k)).toBeNull(); // odd-length hex
    expect(openSecret('', k)).toBeNull();
    // Wrong IV length (truncated).
    expect(openSecret(`${version}:${iv.slice(0, 20)}:${tag}:${ct}`, k)).toBeNull();
  });

  it('rejects invalid or missing encryption keys', () => {
    expect(parseEncryptionKey(undefined)).toBeNull();
    expect(parseEncryptionKey('')).toBeNull();
    expect(parseEncryptionKey(TEST_KEY.slice(0, 62))).toBeNull(); // too short
    expect(parseEncryptionKey(TEST_KEY + 'ff')).toBeNull(); // too long
    expect(parseEncryptionKey('g'.repeat(64))).toBeNull(); // not hex
    expect(parseEncryptionKey(` ${TEST_KEY}`)).toBeNull(); // whitespace
  });

  it('fails decryption when the key differs', () => {
    const payload = sealSecret(ACCESS_TOKEN, k);
    const other = key(); // same for the test; simulate a different key by flipping a nibble
    const wrong = Buffer.from(other);
    wrong[0] = wrong[0] ^ 0xff;
    expect(openSecret(payload, wrong)).toBeNull();
  });

  it('never stores plaintext tokens in SQLite', () => {
    const path = tempDbPath();
    const clock = 1_750_000_000_000;
    const storage = openTestStorage(path, { now: () => clock });
    const created = storage.createSession({ user: USER, credentials: creds(clock + 3600e3, clock + 30 * DAY_MS) });
    storage.close();

    const db = new Database(path);
    try {
      const rows = db.prepare('SELECT * FROM sessions').all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      const haystack = Object.values(rows[0]).map(String).join('\n');
      expect(haystack).not.toContain(ACCESS_TOKEN);
      expect(haystack).not.toContain(REFRESH_TOKEN);
      expect(String(rows[0].token_encrypted).startsWith('v1:')).toBe(true);
      expect(String(rows[0].refresh_token_encrypted).startsWith('v1:')).toBe(true);
    } finally {
      db.close();
    }
    // Sanity: the stored session id is the 64-hex cookie value.
    expect(created.sessionId).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('session configuration validation', () => {
  it('applies documented defaults for unset options', () => {
    const config = resolveSessionConfig({ SESSION_ENCRYPTION_KEY: TEST_KEY });
    expect(config.dbPath).toBe('./data/sessions.db');
    expect(config.maxAgeDays).toBe(7);
    expect(config.encryptionKey).toEqual(key());
    expect(typeof config.now).toBe('function');
  });

  it('accepts explicit valid configuration', () => {
    const now = () => 1;
    const config = resolveSessionConfig(
      {
        SESSION_DB_PATH: '/tmp/app/data/sessions.db',
        SESSION_ENCRYPTION_KEY: TEST_KEY,
        SESSION_MAX_AGE_DAYS: '3',
      },
      now,
    );
    expect(config.dbPath).toBe('/tmp/app/data/sessions.db');
    expect(config.maxAgeDays).toBe(3);
    expect(config.now).toBe(now);
  });

  it('rejects a missing encryption key', () => {
    expect(() => resolveSessionConfig({})).toThrowError(SessionStorageError);
    try {
      resolveSessionConfig({});
    } catch (err) {
      expect((err as SessionStorageError).code).toBe('ENC_KEY_MISSING');
    }
    try {
      resolveSessionConfig({ SESSION_ENCRYPTION_KEY: '' });
      expect.unreachable();
    } catch (err) {
      expect((err as SessionStorageError).code).toBe('ENC_KEY_MISSING');
    }
  });

  it('rejects malformed encryption keys', () => {
    for (const bad of [
      TEST_KEY.slice(0, 62),
      TEST_KEY + 'ff',
      'g'.repeat(64),
      ` ${TEST_KEY}`,
    ]) {
      try {
        resolveSessionConfig({ SESSION_ENCRYPTION_KEY: bad });
        expect.unreachable();
      } catch (err) {
        expect((err as SessionStorageError).code).toBe('ENC_KEY_INVALID');
      }
    }
  });

  it('rejects malformed SESSION_MAX_AGE_DAYS values', () => {
    for (const bad of ['0', '-1', '1.5', '7 days', '1e3', '+7', '3651']) {
      try {
        resolveSessionConfig({ SESSION_ENCRYPTION_KEY: TEST_KEY, SESSION_MAX_AGE_DAYS: bad });
        expect.unreachable();
      } catch (err) {
        expect((err as SessionStorageError).code).toBe('CONFIG_INVALID');
      }
    }
  });

  it('rejects unsafe database paths', () => {
    for (const bad of ['a\0b.db', '   ']) {
      try {
        resolveSessionConfig({ SESSION_ENCRYPTION_KEY: TEST_KEY, SESSION_DB_PATH: bad });
        expect.unreachable();
      } catch (err) {
        expect((err as SessionStorageError).code).toBe('CONFIG_INVALID');
      }
    }
  });

  it('creates the database parent directory safely', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitdatnote-parent-'));
    dirs.push(dir);
    const nested = join(dir, 'a', 'b', 'c.db');
    expect(existsSync(join(dir, 'a', 'b'))).toBe(false);
    ensureSessionDbParent(nested);
    expect(existsSync(join(dir, 'a', 'b'))).toBe(true);
  });

  it('computes maximum-age milliseconds deterministically', () => {
    expect(maxAgeMs(7)).toBe(7 * DAY_MS);
    expect(maxAgeMs(1)).toBe(DAY_MS);
  });
});

// Meaningful file permissions exist on POSIX; on other platforms (e.g.
// Windows) permission bits are not enforced, so these tests are skipped.
const IS_POSIX = process.platform !== 'win32';

describe.skipIf(!IS_POSIX)('session database file permissions (POSIX)', () => {
  it('makes new database files private (0600) and new directories private (0700)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitdatnote-perm-'));
    dirs.push(dir);
    // An existing parent that is NOT 0700 — it must be left exactly as-is.
    chmodSync(dir, 0o755);
    const path = join(dir, 'new', 'sub', 'sessions.db');
    const clock = 1_750_000_000_000;

    const storage = openTestStorage(path, { now: () => clock });
    storage.createSession({ user: USER, credentials: creds(clock + 3600e3, clock + 30 * DAY_MS) });
    storage.close();

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'new')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'new', 'sub')).mode & 0o777).toBe(0o700);
    expect(statSync(dir).mode & 0o777).toBe(0o755); // untouched existing parent
  });

  it('re-secures an existing database file (0644 -> 0600) and preserves its contents on reopen', () => {
    const path = tempDbPath();
    const clock = 1_750_000_000_000;

    let storage = openTestStorage(path, { now: () => clock });
    const created = storage.createSession({
      user: USER,
      credentials: creds(clock + 3600e3, clock + 30 * DAY_MS),
    });
    storage.close();

    // Simulate permission drift (e.g. a copied or permissively created file).
    chmodSync(path, 0o644);

    storage = openTestStorage(path, { now: () => clock + 1000 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(storage.getSession(created.sessionId).status).toBe('found');
    storage.close();
    expect(statSync(path).mode & 0o777).toBe(0o600); // still private after reopen
  });
});

describe('SQLite failure normalization', () => {
  it('maps a corrupt database file to a stable DB_ERROR without leaking details', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitdatnote-corrupt-'));
    dirs.push(dir);
    const path = join(dir, 'corrupt.db');
    writeFileSync(path, 'definitely not a sqlite database');

    try {
      openTestStorage(path);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SessionStorageError);
      expect((err as SessionStorageError).code).toBe('DB_ERROR');
      const message = (err as SessionStorageError).message;
      expect(message).not.toContain('corrupt.db');
      expect(message).not.toContain('not a database');
      expect(message).not.toContain('SQLITE');
    }
  });

  it('maps schema initialization failure to DB_ERROR and leaves the file usable', () => {
    const path = tempDbPath();
    const primed = new Database(path);
    primed.exec('CREATE VIEW sessions AS SELECT 1');
    primed.close();

    try {
      openTestStorage(path);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SessionStorageError);
      expect((err as SessionStorageError).code).toBe('DB_ERROR');
    }

    // The failed open must not leave the file locked or corrupted: a plain
    // connection still sees the original object.
    const check = new Database(path);
    try {
      const views = check
        .prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'sessions'")
        .all() as Array<Record<string, unknown>>;
      expect(views.length).toBe(1);
    } finally {
      check.close();
    }
  });

  it('maps runtime statement failures to DB_ERROR without leaking SQL or paths', () => {
    const path = tempDbPath();
    // Pre-create the sessions table with a CHECK constraint that fails for
    // every row, so the schema step (CREATE TABLE IF NOT EXISTS) is a no-op
    // while every INSERT is guaranteed to fail at runtime.
    const primed = new Database(path);
    primed.exec(
      `CREATE TABLE sessions (
         session_id TEXT PRIMARY KEY,
         user_login TEXT NOT NULL,
         user_name TEXT NOT NULL,
         user_avatar_url TEXT NOT NULL,
         csrf_token TEXT NOT NULL,
         token_encrypted TEXT NOT NULL,
         refresh_token_encrypted TEXT NOT NULL,
         token_expires_at INTEGER NOT NULL,
         refresh_expires_at INTEGER NOT NULL,
         created_at INTEGER NOT NULL CHECK (1 = 0)
       );`,
    );
    primed.close();

    const clock = 1_750_000_000_000;
    const storage = openTestStorage(path, { now: () => clock });

    try {
      storage.createSession({
        user: USER,
        credentials: creds(clock + 3600e3, clock + 30 * DAY_MS),
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SessionStorageError);
      expect((err as SessionStorageError).code).toBe('DB_ERROR');
      const message = (err as SessionStorageError).message;
      // No paths, SQL text, or raw SQLite wording in the outward error.
      expect(message).not.toContain('sessions.db');
      expect(message).not.toContain('INSERT');
      expect(message).not.toContain('CHECK');
      expect(message).not.toContain('constraint');
    }
    storage.close();
  });

  it('preserves typed session errors instead of masking them as DB_ERROR', () => {
    const path = tempDbPath();
    const storage = openTestStorage(path, { now: () => 1_750_000_000_000 });
    storage.close();

    try {
      storage.createSession({
        user: USER,
        credentials: creds(1_750_003_600_000, 1_750_000_000_000 + 30 * DAY_MS),
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SessionStorageError);
      expect((err as SessionStorageError).code).toBe('STORAGE_NOT_OPEN');
    }
  });
});

describe('credential rotation on expired sessions (regression)', () => {
  it('refuses rotation on an expired session and leaves stored credentials unchanged', () => {
    const path = tempDbPath();
    let clock = 1_750_000_000_000;
    const storage = openTestStorage(path, { maxAgeDays: 1, now: () => clock });

    const created = storage.createSession({
      user: USER,
      credentials: creds(clock + 3600e3, clock + 30 * DAY_MS),
    });
    const before = rawTable(path, created.sessionId);

    // Move the deterministic clock past the session's maximum age.
    clock = created.expiresAt + 60_000;

    const result = storage.rotateCredentials(
      created.sessionId,
      creds(clock + 3600e3, clock + 60 * DAY_MS, ACCESS_TOKEN_2, REFRESH_TOKEN_2),
    );
    expect(result).toEqual({ status: 'expired' });

    // The stored encrypted token pair and both expiries are byte-for-byte
    // unchanged — the rotation wrote nothing.
    const after = rawTable(path, created.sessionId);
    expect(after).toEqual(before);

    // And the new token values never reached storage in any form.
    const db = new Database(path);
    let haystack = '';
    try {
      const rows = db.prepare('SELECT * FROM sessions').all() as Array<Record<string, unknown>>;
      haystack = rows
        .map((row) => Object.values(row).map(String).join('\n'))
        .join('\n');
    } finally {
      db.close();
    }
    expect(haystack).not.toContain(ACCESS_TOKEN_2);
    expect(haystack).not.toContain(REFRESH_TOKEN_2);

    storage.close();
  });
});

/**
 * Regression: when permission enforcement fails during initialization,
 * the database handle opened just before the failure must be closed
 * before the stable SessionStorageError propagates.
 *
 * The failure is produced deterministically with a small FUSE filesystem
 * (compiled at test time) that passes every operation through to a backing
 * directory except permission changes, which always fail with EPERM. No
 * production test hooks are involved: the storage code simply cannot make
 * the database file private, exactly as a real permission failure would
 * behave. The suite is skipped when FUSE tooling is unavailable.
 */

/** Passthrough FUSE helper whose chmod/chown always fail with -EPERM. */
const FUSE_HELPER_SOURCE = String.raw`
#define FUSE_USE_VERSION 35
#include <fuse3/fuse.h>

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <unistd.h>

static char basepath[PATH_MAX];

static void realpath_of(const char *path, char *out, size_t n) {
    if (strcmp(path, "/") == 0) {
        snprintf(out, n, "%s", basepath);
    } else {
        snprintf(out, n, "%s%s", basepath, path);
    }
}

static int pt_access(const char *path, int mode) {
    char rb[PATH_MAX];
    realpath_of(path, rb, sizeof rb);
    if (access(rb, mode) < 0) return -errno;
    return 0;
}

/* Permission changes always fail: the deterministic failure under test. */
static int pt_chmod(const char *path, mode_t mode, struct fuse_file_info *fi) {
    (void)path;
    (void)mode;
    (void)fi;
    return -EPERM;
}

static int pt_chown(const char *path, uid_t uid, gid_t gid,
                    struct fuse_file_info *fi) {
    (void)path;
    (void)uid;
    (void)gid;
    (void)fi;
    return -EPERM;
}

static int pt_truncate(const char *path, off_t size, struct fuse_file_info *fi) {
    (void)fi;
    char rb[PATH_MAX];
    realpath_of(path, rb, sizeof rb);
    if (truncate(rb, size) < 0) return -errno;
    return 0;
}

static int pt_getattr(const char *path, struct stat *st, struct fuse_file_info *fi) {
    (void)fi;
    char rb[PATH_MAX];
    realpath_of(path, rb, sizeof rb);
    if (lstat(rb, st) < 0) return -errno;
    return 0;
}

static int pt_mkdir(const char *path, mode_t mode) {
    char rb[PATH_MAX];
    realpath_of(path, rb, sizeof rb);
    if (mkdir(rb, mode) < 0) return -errno;
    return 0;
}

static int pt_unlink(const char *path) {
    char rb[PATH_MAX];
    realpath_of(path, rb, sizeof rb);
    if (unlink(rb) < 0) return -errno;
    return 0;
}

static int pt_rmdir(const char *path) {
    char rb[PATH_MAX];
    realpath_of(path, rb, sizeof rb);
    if (rmdir(rb) < 0) return -errno;
    return 0;
}

static int pt_rename(const char *old, const char *new, unsigned int flags) {
    char rob[PATH_MAX], rnb[PATH_MAX];
    (void)flags;
    realpath_of(old, rob, sizeof rob);
    realpath_of(new, rnb, sizeof rnb);
    if (rename(rob, rnb) < 0) return -errno;
    return 0;
}

static int pt_statfs(const char *path, struct statvfs *buf) {
    char rb[PATH_MAX];
    realpath_of(path, rb, sizeof rb);
    if (statvfs(rb, buf) < 0) return -errno;
    return 0;
}

static int pt_open(const char *path, struct fuse_file_info *fi) {
    char rb[PATH_MAX];
    realpath_of(path, rb, sizeof rb);
    int fd = open(rb, fi->flags, 0644);
    if (fd < 0) return -errno;
    fi->fh = (uint64_t)fd;
    return 0;
}

static int pt_create(const char *path, mode_t mode, struct fuse_file_info *fi) {
    char rb[PATH_MAX];
    realpath_of(path, rb, sizeof rb);
    int fd = open(rb, O_RDWR | O_CREAT, mode);
    if (fd < 0) return -errno;
    fi->fh = (uint64_t)fd;
    return 0;
}

static int pt_read(const char *path, char *buf, size_t size, off_t off,
                   struct fuse_file_info *fi) {
    (void)path;
    ssize_t r = pread((int)fi->fh, buf, size, off);
    if (r < 0) return -errno;
    return (int)r;
}

static int pt_write(const char *path, const char *buf, size_t size, off_t off,
                    struct fuse_file_info *fi) {
    (void)path;
    ssize_t r = pwrite((int)fi->fh, buf, size, off);
    if (r < 0) return -errno;
    return (int)r;
}

static int pt_release(const char *path, struct fuse_file_info *fi) {
    (void)path;
    int fd = (int)fi->fh;
    if (fd >= 0) close(fd);
    return 0;
}

static int pt_fsync(const char *path, int flags, struct fuse_file_info *fi) {
    (void)path;
    (void)flags;
    if (fsync((int)fi->fh) < 0) return -errno;
    return 0;
}

static int pt_opendir(const char *path, struct fuse_file_info *fi) {
    (void)path;
    fi->fh = 0;
    return 0;
}

static int pt_readdir(const char *path, void *buf, fuse_fill_dir_t fill,
                      off_t off, struct fuse_file_info *fi,
                      enum fuse_readdir_flags flags) {
    (void)off;
    (void)fi;
    (void)flags;
    char rb[PATH_MAX];
    realpath_of(path, rb, sizeof rb);
    DIR *d = opendir(rb);
    if (!d) return -errno;
    struct dirent *e;
    int rc = 0;
    while ((e = readdir(d)) != NULL) {
        if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0)
            continue;
        if (fill(buf, e->d_name, NULL, 0, 0)) {
            rc = 1;
            break;
        }
    }
    closedir(d);
    return rc ? 1 : 0;
}

static int pt_releasedir(const char *path, struct fuse_file_info *fi) {
    (void)path;
    (void)fi;
    return 0;
}

static const struct fuse_operations ops = {
    .access = pt_access,
    .chmod = pt_chmod,
    .chown = pt_chown,
    .truncate = pt_truncate,
    .getattr = pt_getattr,
    .mkdir = pt_mkdir,
    .unlink = pt_unlink,
    .rmdir = pt_rmdir,
    .rename = pt_rename,
    .statfs = pt_statfs,
    .open = pt_open,
    .create = pt_create,
    .read = pt_read,
    .write = pt_write,
    .release = pt_release,
    .fsync = pt_fsync,
    .opendir = pt_opendir,
    .readdir = pt_readdir,
    .releasedir = pt_releasedir,
};

int main(int argc, char *argv[]) {
    if (argc < 3) {
        fprintf(stderr, "usage: %s <backing-dir> <mount-point> [fuse options]\n",
                argv[0]);
        return 1;
    }
    snprintf(basepath, sizeof basepath, "%s", argv[1]);
    /* Rebuild argv for fuse_main: [prog, mountpoint, options..., NULL].
     * argv was [prog, backing-dir, mountpoint, options..., NULL]. */
    argv[1] = argv[2];
    for (int i = 2; i < argc - 1; i++) {
        argv[i] = argv[i + 1];
    }
    return fuse_main(argc - 1, argv, &ops, NULL);
}
`;

/** True only when every piece of the FUSE failure harness is available. */
const FUSE_AVAILABLE: boolean = (() => {
  if (process.platform !== 'linux') return false;
  if (!existsSync('/dev/fuse')) return false;
  if (!existsSync('/usr/bin/fusermount3')) return false;
  if (!existsSync('/usr/include/fuse3/fuse.h')) return false;
  if (spawnSync('gcc', ['--version'], { stdio: 'ignore' }).status !== 0) {
    return false;
  }
  // The helper must compile against the local libfuse3 header.
  const probe = spawnSync(
    'gcc',
    ['-fsyntax-only', '-x', 'c', '-', '-I/usr/include/fuse3'],
    { input: FUSE_HELPER_SOURCE, encoding: 'utf8' },
  );
  return probe.status === 0;
})();

/** Count open file descriptors in THIS process whose target is under path. */
function openFdCountUnder(path: string): number {
  let count = 0;
  for (const fd of readdirSync('/proc/self/fd')) {
    let target: string;
    try {
      target = readlinkSync(join('/proc/self/fd', fd));
    } catch {
      continue;
    }
    if (target.startsWith(path)) count += 1;
  }
  return count;
}

/** Poll /proc/mounts until mountpoint appears (or the deadline passes). */
function waitForMount(mountpoint: string, timeoutMs: number): boolean {
  const marker = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  const isMounted = () =>
    readFileSync('/proc/mounts', 'utf8').includes(` ${mountpoint} `);
  while (Date.now() < deadline) {
    if (isMounted()) return true;
    Atomics.wait(marker, 0, 0, 25);
  }
  return isMounted();
}

describe.skipIf(!FUSE_AVAILABLE)('session initialization failure cleanup (FUSE)', () => {
  it('closes the database handle when permission enforcement fails during open', () => {
    const root = mkdtempSync(join(tmpdir(), 'gitdatnote-fuse-'));
    const backing = join(root, 'backing');
    const mnt = join(root, 'mnt');
    const helperBin = join(root, 'chmod_block');
    mkdirSync(backing);
    mkdirSync(mnt);

    // Pre-create the backing database with world-readable permissions so
    // secureSessionDbFile() is guaranteed to attempt (and fail) a chmod,
    // independent of the process umask.
    const backingDb = join(backing, 'sessions.db');
    writeFileSync(backingDb, '');
    chmodSync(backingDb, 0o644);

    let child: ChildProcess | undefined;
    try {
      const compile = spawnSync(
        'gcc',
        ['-O1', '-x', 'c', '-', '-o', helperBin, '-I/usr/include/fuse3', '-lfuse3', '-lpthread'],
        { input: FUSE_HELPER_SOURCE, encoding: 'utf8' },
      );
      expect(compile.status, `FUSE helper compile failed: ${compile.stderr}`).toBe(0);

      child = spawn(helperBin, [backing, mnt, '-f'], { stdio: 'ignore' });
      child.on('error', () => {
        /* Handled by the mount check below. */
      });

      expect(
        waitForMount(mnt, 5000),
        'FUSE mount did not come up',
      ).toBe(true);

      const dbPath = join(mnt, 'sessions.db');
      try {
        openTestStorage(dbPath, { now: () => 1_750_000_000_000 });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(SessionStorageError);
        expect((err as SessionStorageError).code).toBe('DB_ERROR');
        const message = (err as SessionStorageError).message;
        // The fixed, outward-safe message: no paths, no raw wording.
        expect(message).toBe('Could not secure the session database file.');
        expect(message).not.toContain('sessions.db');
        expect(message).not.toContain('SQLITE');

        // The regression: no open file descriptor may point at the
        // database file after a failed initialization — the handle that
        // was opened before the failure must have been closed.
        expect(openFdCountUnder(mnt)).toBe(0);
      }
    } finally {
      // Lazy unmount: succeeds even when a (leaked) descriptor still holds
      // the FUSE mount busy — the exact condition this test guards against.
      spawnSync('/usr/bin/fusermount3', ['-uz', mnt], { stdio: 'ignore' });
      if (child !== undefined) child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

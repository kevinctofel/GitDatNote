/**
 * Pending authorization state store (task 3.2, design.md A-04).
 *
 * State is 32 cryptographically random bytes (hex) and is stored in a
 * dedicated SQLite table (`pending_authorizations`) inside the session
 * database file. It is deliberately NOT the authenticated `sessions` table:
 * a pending attempt carries no credentials and no user identity.
 *
 * One-time consumption: `consume` flips `consumed = 1` atomically together
 * with the expiry check in a single UPDATE. Any later attempt sees
 * `consumed = 1` and is rejected as a replay — state replay is impossible
 * even across concurrent callbacks.
 */

import Database from 'better-sqlite3';
import { PENDING_AUTH_TTL_MS } from './config.js';
import type { ConsumeResult, PendingStateStore } from './types.js';
import type { Logger } from '../middleware/logging.js';

type DatabaseHandle = InstanceType<typeof Database>;

interface Row {
  consumed: number;
  expires_at: number;
}

export function openPendingStateStore(
  dbPath: string,
  logger: Logger,
  now: () => number,
): PendingStateStore {
  let db: DatabaseHandle | null = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_authorizations (
      state TEXT PRIMARY KEY,
      verifier TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pending_authorizations_expires_at
      ON pending_authorizations (expires_at);
  `);

  const purge = db.prepare('DELETE FROM pending_authorizations WHERE expires_at <= ?');
  const insert = db.prepare(
    `INSERT INTO pending_authorizations (state, verifier, created_at, expires_at, consumed)
     VALUES (?, ?, ?, ?, 0)`,
  );
  const consumeStmt = db.prepare(
    `UPDATE pending_authorizations SET consumed = 1
     WHERE state = ? AND consumed = 0 AND expires_at > ?`,
  );
  const fetchRow = db.prepare(
    'SELECT consumed, expires_at FROM pending_authorizations WHERE state = ?',
  );
  const fetchVerifier = db.prepare(
    'SELECT verifier FROM pending_authorizations WHERE state = ?',
  );

  // Best-effort cleanup of rows that expired before this process started.
  const initialPurged = purge.run(now()).changes;
  if (initialPurged > 0) {
    logger.debug({ event: 'pending_auth_purge', purged: initialPurged });
  }

  return {
    create(state: string, verifier: string, nowMs: number): void {
      purge.run(nowMs);
      insert.run(state, verifier, nowMs, nowMs + PENDING_AUTH_TTL_MS);
    },
    consume(state: string, nowMs: number): ConsumeResult {
      const info = consumeStmt.run(state, nowMs);
      if (info.changes === 1) {
        const row = fetchVerifier.get(state) as { verifier: string } | undefined;
        if (row === undefined) {
          // Consumed but purged between the UPDATE and the read. Never allow
          // a success path for a record we can no longer prove.
          return { kind: 'replayed' };
        }
        return { kind: 'consumed', verifier: row.verifier };
      }
      const row = fetchRow.get(state) as Row | undefined;
      if (row === undefined) return { kind: 'missing' };
      if (row.consumed === 1) return { kind: 'replayed' };
      return { kind: 'expired' };
    },
    purgeExpired(nowMs: number): number {
      return purge.run(nowMs).changes;
    },
    close(): void {
      if (db !== null) {
        try {
          db.close();
        } catch {
          // Already closed; nothing to do.
        }
        db = null;
      }
    },
  };
}

/**
 * Session storage configuration (task 3.1, design.md A-04).
 *
 * Environment contract:
 * - `SESSION_DB_PATH`       optional; default `./data/sessions.db`.
 * - `SESSION_ENCRYPTION_KEY` required — exactly 64 hex characters
 *   (256-bit, full entropy). See `crypto.ts` for the exact contract.
 * - `SESSION_MAX_AGE_DAYS`  optional positive integer; default 7.
 *
 * Validation is strict: malformed or unsafe values raise
 * `SessionStorageError` instead of silently substituting defaults.
 */

import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { parseEncryptionKey } from './crypto.js';
import { SessionStorageError } from './types.js';

/**
 * POSIX systems expose meaningful file permissions; on other platforms
 * (e.g. Windows) permission bits are not enforced the same way, so the
 * permission checks in this module and `storage.ts` are skipped there.
 */
export const IS_POSIX = process.platform !== 'win32';

/** Resolved, validated session storage configuration. */
export interface SessionConfig {
  /** Filesystem path of the SQLite database (under `data/`, git-ignored). */
  dbPath: string;
  /** 32-byte AES-256-GCM key from `SESSION_ENCRYPTION_KEY`. */
  encryptionKey: Buffer;
  /** Maximum session age in whole days (>= 1). */
  maxAgeDays: number;
  /** Injectable clock (epoch milliseconds) for deterministic tests. */
  now: () => number;
}

export const SESSION_DB_PATH_DEFAULT = './data/sessions.db';
export const SESSION_MAX_AGE_DAYS_DEFAULT = 7;
/** Sessions are never accepted older than ten years. */
export const SESSION_MAX_AGE_DAYS_LIMIT = 3650;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Convert a validated whole-day maximum age to milliseconds. */
export function maxAgeMs(maxAgeDays: number): number {
  return maxAgeDays * DAY_MS;
}

/**
 * Resolve session storage configuration from an environment map.
 *
 * Throws `SessionStorageError` with a stable code:
 * - `ENC_KEY_MISSING`  — `SESSION_ENCRYPTION_KEY` not set.
 * - `ENC_KEY_INVALID`  — set but not exactly 64 hex characters.
 * - `CONFIG_INVALID`   — malformed/unsafe `SESSION_DB_PATH` or
 *   `SESSION_MAX_AGE_DAYS`.
 */
export function resolveSessionConfig(
  env: Record<string, string | undefined>,
  now: () => number = Date.now,
): SessionConfig {
  const key = parseEncryptionKey(env.SESSION_ENCRYPTION_KEY);
  if (key === null) {
    if (env.SESSION_ENCRYPTION_KEY === undefined || env.SESSION_ENCRYPTION_KEY === '') {
      throw new SessionStorageError(
        'ENC_KEY_MISSING',
        'SESSION_ENCRYPTION_KEY is required to initialize encrypted session storage.',
      );
    }
    throw new SessionStorageError(
      'ENC_KEY_INVALID',
      'SESSION_ENCRYPTION_KEY must be exactly 64 hex characters (a 256-bit secret).',
    );
  }

  return {
    dbPath: resolveDbPath(env.SESSION_DB_PATH),
    encryptionKey: key,
    maxAgeDays: resolveMaxAgeDays(env.SESSION_MAX_AGE_DAYS),
    now,
  };
}

/**
 * Ensure the parent directory of the database path exists, creating only
 * the missing directory segments. On POSIX, every segment created by this
 * function is private (mode 0700). Existing directories are never chmod'ed:
 * an unrelated parent keeps exactly the permissions it already had.
 */
export function ensureSessionDbParent(dbPath: string): void {
  const parent = dirname(dbPath);
  if (parent === '' || parent === '.' || parent === '/') return;

  // Collect the segments that do not exist yet, walking up to the nearest
  // existing ancestor.
  const missing: string[] = [];
  let cursor = parent;
  while (!existsSync(cursor)) {
    missing.push(cursor);
    const up = dirname(cursor);
    if (up === cursor) break; // reached the filesystem root
    cursor = up;
  }

  // Create the missing segments outermost-first; each is created (and, on
  // POSIX, re-asserted past umask masking) as owner-only.
  for (const segment of missing.reverse()) {
    try {
      mkdirSync(segment, { mode: 0o700 });
      if (IS_POSIX) chmodSync(segment, 0o700);
    } catch {
      throw new SessionStorageError(
        'DB_ERROR',
        'Could not create the session database directory.',
      );
    }
  }
}

function resolveDbPath(raw: string | undefined): string {
  if (raw === undefined || raw === '') return SESSION_DB_PATH_DEFAULT;
  if (/\0/.test(raw)) {
    throw new SessionStorageError(
      'CONFIG_INVALID',
      'SESSION_DB_PATH contains invalid characters.',
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new SessionStorageError(
      'CONFIG_INVALID',
      'SESSION_DB_PATH must not be empty.',
    );
  }
  return trimmed;
}

function resolveMaxAgeDays(raw: string | undefined): number {
  if (raw === undefined || raw === '') return SESSION_MAX_AGE_DAYS_DEFAULT;
  // Whole base-10 positive integer only — no signs, spaces, fractions, or
  // exponent notation.
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new SessionStorageError(
      'CONFIG_INVALID',
      'SESSION_MAX_AGE_DAYS must be a positive whole number of days.',
    );
  }
  const days = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(days) || days > SESSION_MAX_AGE_DAYS_LIMIT) {
    throw new SessionStorageError(
      'CONFIG_INVALID',
      `SESSION_MAX_AGE_DAYS must be between 1 and ${SESSION_MAX_AGE_DAYS_LIMIT} days.`,
    );
  }
  return days;
}

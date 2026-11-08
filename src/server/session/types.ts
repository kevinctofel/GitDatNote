/**
 * Session storage types for GitDatNote (design.md decision A-04, task 3.1).
 *
 * These types are the public server-side contract that task 3.2 (OAuth
 * callback, `GET /api/session`) and task 3.5 (token refresh) will consume.
 * They contain no database or HTTP types, so the frontend never needs
 * database access: the browser only ever sees a cookie name and, at most,
 * the session's non-secret user fields.
 *
 * Security boundary:
 * - `credentials` fields are plaintext in server memory only. They must
 *   never be written to logs, API response bodies, or the client bundle.
 * - The session ID is carried by the session cookie only; it must not
 *   appear in API response bodies or logs.
 * - Only stable `SessionErrorCode` values cross the server boundary; raw
 *   crypto or SQLite error text must not reach clients.
 */

/** Non-secret GitHub user profile for a session. */
export interface SessionUser {
  login: string;
  name: string;
  avatarUrl: string;
}

/**
 * GitHub credentials in plaintext, held in server memory only.
 *
 * Values are encrypted at rest (AES-256-GCM) before they touch SQLite and
 * are decrypted only in memory to perform API calls or refresh (tasks
 * 3.2/3.5). Never log these values.
 */
export interface SessionCredentials {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds at which the access token expires. */
  tokenExpiresAt: number;
  /** Epoch milliseconds at which the refresh token expires. */
  refreshExpiresAt: number;
}

/** A stored session with credentials decrypted for server-side use. */
export interface StoredSession {
  /** Cryptographically random 64-hex-character identifier (cookie value). */
  sessionId: string;
  user: SessionUser;
  /** Epoch milliseconds. */
  createdAt: number;
  /**
   * Epoch milliseconds: `createdAt` plus the configured maximum session
   * age. Enforced by the storage layer, not only by cookie expiry.
   */
  expiresAt: number;
  /**
   * Cryptographically random CSRF value (64 hex characters) generated at
   * session creation. It may be exposed to the client through the future
   * `GET /api/session` (task 3.2); request-level CSRF validation is task
   * 3.3.
   */
  csrfToken: string;
  /** Decrypted in server memory only — never into logs or response bodies. */
  credentials: SessionCredentials;
}

/** Outcome of a session lookup. Expired and missing are distinct so the
 *  server layer can map both to `401 UNAUTHORIZED` (task 3.5) without
 *  leaking which one occurred. */
export type SessionLookupResult =
  | { status: 'found'; session: StoredSession }
  | { status: 'expired' }
  | { status: 'missing' };

/** Input for creating a session (plaintext credentials encrypted at rest). */
export interface CreateSessionInput {
  user: SessionUser;
  credentials: SessionCredentials;
}

/**
 * Server-side session storage contract (task 3.2 consumes this interface;
 * it must never be imported from the frontend bundle).
 */
export interface SessionStorage {
  /** Create a session with a fresh random ID and CSRF value. */
  createSession(input: CreateSessionInput): StoredSession;
  /**
   * Retrieve a session by ID. Returns `expired` when the session exceeds
   * the configured maximum age, `missing` when no such session exists.
   * Throws `SessionStorageError('DECRYPTION_FAILED')` if stored ciphertext
   * cannot be authenticated (tampered or corrupted at rest).
   */
  getSession(sessionId: string): SessionLookupResult;
  /**
   * Atomically replace the stored encrypted token pair and both expiry
   * timestamps (refresh-token rotation, task 3.5). Returns the updated
   * lookup result, or `undefined` when no session has that ID.
   */
  rotateCredentials(
    sessionId: string,
    credentials: SessionCredentials,
  ): SessionLookupResult | undefined;
  /** Delete/invalidate a session. `true` when a session was removed. */
  deleteSession(sessionId: string): boolean;
  /** Remove every session past its maximum age. Returns the count. */
  purgeExpiredSessions(): number;
  /** Close the underlying database. No further calls are permitted. */
  close(): void;
}

/**
 * Stable, client-safe error codes for session storage failures.
 * Mapped by the server layer to standard API error envelopes (A-05);
 * raw underlying error text must not reach clients.
 */
export type SessionErrorCode =
  | 'STORAGE_NOT_OPEN'
  | 'INVALID_SESSION_ID'
  | 'INVALID_CREDENTIALS'
  | 'CONFIG_INVALID'
  | 'ENC_KEY_MISSING'
  | 'ENC_KEY_INVALID'
  | 'DECRYPTION_FAILED'
  | 'DB_ERROR';

/** Thrown by session storage/config/crypto helpers. `code` is stable and
 *  safe to log; the message is fixed and never carries secrets. */
export class SessionStorageError extends Error {
  readonly code: SessionErrorCode;

  constructor(code: SessionErrorCode, message: string) {
    super(message);
    this.name = 'SessionStorageError';
    this.code = code;
  }
}

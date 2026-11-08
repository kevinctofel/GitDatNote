/**
 * Session storage foundation (task 3.1, design.md A-04).
 *
 * Public surface for the server layer (task 3.2 and later). This barrel is
 * the only import the rest of the server uses for sessions; the frontend
 * bundle must never import it.
 */

export {
  SessionStorageError,
  type CreateSessionInput,
  type SessionCredentials,
  type SessionErrorCode,
  type SessionLookupResult,
  type SessionStorage,
  type SessionUser,
  type StoredSession,
} from './types.js';
export {
  CRYPTO_FORMAT_VERSION,
  ENCRYPTION_KEY_BYTE_LENGTH,
  ENCRYPTION_KEY_HEX_LENGTH,
  IV_BYTES,
  TAG_BYTES,
  openSecret,
  parseEncryptionKey,
  sealSecret,
} from './crypto.js';
export {
  SESSION_DB_PATH_DEFAULT,
  SESSION_MAX_AGE_DAYS_DEFAULT,
  SESSION_MAX_AGE_DAYS_LIMIT,
  ensureSessionDbParent,
  maxAgeMs,
  resolveSessionConfig,
  type SessionConfig,
} from './config.js';
export { openSessionStorage } from './storage.js';
export {
  SESSION_COOKIE_NAME,
  SESSION_ID_PATTERN,
  clearSessionCookie,
  issueSessionCookie,
  parseSessionCookie,
  resolveCookieSecure,
  type SessionCookieOptions,
} from './cookies.js';

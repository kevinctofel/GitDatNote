/**
 * Secure session cookie helpers (task 3.1, design.md A-04).
 *
 * Fixed, documented cookie name: `gitdatnote_session`.
 *
 * Attributes on every cookie we set:
 * - `HttpOnly`   — invisible to page JavaScript,
 * - `SameSite=Lax` — cross-site submission protection,
 * - `Path=/`,
 * - `Secure`     — in production/HTTPS mode; omitted in local HTTP
 *   development (per OpenSpec, so `localhost` dev works),
 * - `Max-Age`/`Expires` consistent with the configured session lifetime.
 *
 * The session ID travels only in this cookie. It must never appear in API
 * response bodies, logs, or client code. Malformed or missing cookies are
 * treated as unauthenticated — parsing never throws.
 *
 * No cookie framework is added: these are small, dependency-free helpers.
 */

/** The single session cookie name used across the app. */
export const SESSION_COOKIE_NAME = 'gitdatnote_session';

/** Shape of a valid session ID (and therefore a valid cookie value). */
export const SESSION_ID_PATTERN = /^[0-9a-f]{64}$/;

export interface SessionCookieOptions {
  /** `true` under HTTPS/production configuration. */
  secure: boolean;
  /** Configured maximum session age in whole days (>= 1). */
  maxAgeDays: number;
  /** Injectable clock for deterministic expiry values. */
  now?: () => number;
}

const DAY_SECONDS = 24 * 60 * 60;
const DAY_MS = DAY_SECONDS * 1000;
const EPOCH_1970 = 'Thu, 01 Jan 1970 00:00:00 GMT';

/**
 * Resolve whether the session cookie must carry `Secure`:
 * `NODE_ENV=production` always enables it; `SESSION_COOKIE_SECURE` set to
 * `true` or `1` enables it explicitly (e.g. behind an HTTPS proxy).
 */
export function resolveCookieSecure(
  env: Record<string, string | undefined>,
): boolean {
  if (env.NODE_ENV === 'production') return true;
  const flag = env.SESSION_COOKIE_SECURE;
  return flag === 'true' || flag === '1';
}

/**
 * Build the `Set-Cookie` header value for a new session.
 *
 * Example (local development):
 * `gitdatnote_session=ab…; Max-Age=604800; Expires=Fri, 07 Nov 2026 ...; Path=/; HttpOnly; SameSite=Lax`
 */
export function issueSessionCookie(
  sessionId: string,
  options: SessionCookieOptions,
): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new TypeError('session id must be 64 lowercase hex characters');
  }
  if (!Number.isInteger(options.maxAgeDays) || options.maxAgeDays < 1) {
    throw new TypeError('maxAgeDays must be a positive whole number');
  }
  const now = (options.now ?? Date.now)();
  const maxAgeSeconds = options.maxAgeDays * DAY_SECONDS;
  const expires = new Date(now + options.maxAgeDays * DAY_MS).toUTCString();
  const parts = [
    `${SESSION_COOKIE_NAME}=${sessionId}`,
    `Max-Age=${maxAgeSeconds}`,
    `Expires=${expires}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Build the `Set-Cookie` header value that clears the session cookie using
 * matching attributes and a zero lifetime.
 */
export function clearSessionCookie(options: { secure?: boolean } = {}): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'Max-Age=0',
    `Expires=${EPOCH_1970}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Extract the session ID from an incoming `Cookie` header value.
 *
 * Returns `null` (unauthenticated) when the header is absent, the session
 * cookie is absent, or its value is not a well-formed session ID. Never
 * throws.
 */
export function parseSessionCookie(
  cookieHeader: string | undefined | null,
): string | null {
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) {
    return null;
  }
  for (const pair of cookieHeader.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    const value = pair.slice(eq + 1).trim();
    // A malformed value is treated as unauthenticated, not an error.
    return SESSION_ID_PATTERN.test(value) ? value : null;
  }
  return null;
}

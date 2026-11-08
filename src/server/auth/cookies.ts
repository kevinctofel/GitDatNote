/**
 * Pending-authorization browser-binding cookie (task 3.2, design.md A-04).
 *
 * Cookie name: `gitdatnote_pending_auth`. Its value is the pending
 * authorization state (64 lowercase hex characters). The cookie binds the
 * OAuth callback to the browser that initiated sign-in, which prevents
 * login CSRF and authorization-response swapping.
 *
 * Attributes: `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` whenever
 * cookies are secure in this deployment (same policy as the session
 * cookie). Lifetime: 10 minutes, matching the pending state TTL.
 *
 * The state value must never appear in logs, responses, redirects, or
 * client code.
 */

import { PENDING_AUTH_TTL_MS } from './config.js';
import { SESSION_ID_PATTERN } from '../session/cookies.js';

/** The pending-authorization binding cookie name. */
export const PENDING_AUTH_COOKIE = 'gitdatnote_pending_auth';

const PENDING_COOKIE_TTL_SECONDS = PENDING_AUTH_TTL_MS / 1000;
const EPOCH_1970 = 'Thu, 01 Jan 1970 00:00:00 GMT';

/**
 * Build the `Set-Cookie` header for a new pending authorization.
 * `state` must be 64 lowercase hex characters (same shape as a session id).
 */
export function issuePendingAuthCookie(
  state: string,
  secure: boolean,
  now: number,
): string {
  if (!SESSION_ID_PATTERN.test(state)) {
    throw new TypeError('state must be 64 lowercase hex characters');
  }
  const expires = new Date(now + PENDING_AUTH_TTL_MS).toUTCString();
  const parts = [
    `${PENDING_AUTH_COOKIE}=${state}`,
    `Max-Age=${PENDING_COOKIE_TTL_SECONDS}`,
    `Expires=${expires}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Build the `Set-Cookie` header that clears the pending binding. */
export function clearPendingAuthCookie(secure: boolean): string {
  const parts = [
    `${PENDING_AUTH_COOKIE}=`,
    'Max-Age=0',
    `Expires=${EPOCH_1970}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Extract the pending state from the `Cookie` header. Returns `null` when
 * absent or malformed — never throws.
 */
export function parsePendingAuthCookie(
  cookieHeader: string | undefined | null,
): string | null {
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) {
    return null;
  }
  for (const pair of cookieHeader.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (name !== PENDING_AUTH_COOKIE) continue;
    const value = pair.slice(eq + 1).trim();
    return SESSION_ID_PATTERN.test(value) ? value : null;
  }
  return null;
}

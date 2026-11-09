/**
 * Centralized CSRF protection for state-changing API requests
 * (design.md decision A-05, task 3.3).
 *
 * This module is the single security boundary every authenticated
 * `POST`/`PUT`/`DELETE` request to `/api/*` must pass before a handler
 * executes. The boundary is wired once in `src/server/index.ts`, so future
 * state-changing routes inherit protection without re-implementing CSRF
 * validation in each handler.
 *
 * The CSRF value is the session-bound token generated at session creation
 * (tasks 3.1/3.2): 32 random bytes, stored as exactly 64 lowercase hex
 * characters. It is reused as-is — no second token, no new persistence.
 *
 * Accepted token carrier: the `X-CSRF-Token` HTTP header only. Token values
 * carried in request bodies, query strings, or cookies are never read.
 *
 * Outcomes:
 * - `unauthorized` — no session cookie, or unknown/expired session. The
 *   caller responds `401 UNAUTHORIZED`.
 * - `csrf_invalid` — missing, malformed, duplicated, or mismatched token.
 *   The caller responds `403 CSRF_INVALID`.
 * - `internal` — session storage failure; fail closed. The caller responds
 *   `500 INTERNAL_ERROR`.
 *
 * Logging: events carry fixed event names and safe reason codes only.
 * CSRF token values, session IDs, cookies, and other credentials are never
 * logged.
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { errorDetail } from '../../shared/errors.js';
import { parseSessionCookie } from '../session/cookies.js';
import { SessionStorageError } from '../session/types.js';
import type { SessionStorage } from '../session/types.js';
import type { Logger } from './logging.js';

/** The only accepted carrier for the CSRF token. */
export const CSRF_HEADER_NAME = 'x-csrf-token';

/** Stored CSRF values are 32 random bytes -> exactly 64 lowercase hex chars. */
const CSRF_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** Outcome of a centralized CSRF check. */
export type CsrfCheckResult =
  | { status: 'ok'; sessionId: string }
  | { status: 'unauthorized' }
  | { status: 'csrf_invalid' }
  | { status: 'internal' };

/**
 * Read the CSRF token from the `X-CSRF-Token` header only.
 *
 * Returns `null` for a missing header, or for a duplicate/ambiguous header:
 * Node joins repeated header lines with ", " (which can never match the
 * strict token format), and a raw header array is accepted only when it
 * holds exactly one value.
 */
export function readCsrfHeader(req: IncomingMessage): string | null {
  const header = req.headers[CSRF_HEADER_NAME];
  if (Array.isArray(header)) {
    return header.length === 1 ? header[0] : null;
  }
  if (typeof header === 'string') {
    return header;
  }
  return null;
}

/** Strict format gate: exactly 64 lowercase hex characters. */
export function isValidCsrfToken(token: string): boolean {
  return CSRF_TOKEN_PATTERN.test(token);
}

/**
 * Constant-time comparison for valid, equally sized tokens.
 *
 * Both operands must already pass the strict format gate; malformed values
 * are rejected by the caller before this runs, so no partial hex decoding
 * of attacker-controlled input is ever compared.
 */
export function constantTimeTokenMatch(provided: string, expected: string): boolean {
  if (!isValidCsrfToken(provided) || !isValidCsrfToken(expected)) {
    return false;
  }
  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Authenticate and CSRF-validate a state-changing request.
 *
 * Performs exactly one session lookup. A missing session cookie short-
 * circuits before any database access. Any storage exception fails closed
 * (`internal`); no credentials or identifiers are logged.
 */
export function checkCsrf(
  req: IncomingMessage,
  storage: SessionStorage,
  logger: Logger,
): CsrfCheckResult {
  const sessionId = parseSessionCookie(req.headers.cookie);
  if (sessionId === null) {
    return { status: 'unauthorized' };
  }
  let result;
  try {
    result = storage.getSession(sessionId);
  } catch (err) {
    logger.error({
      event: 'csrf_session_lookup_failed',
      code: err instanceof SessionStorageError ? err.code : 'DB_ERROR',
    });
    return { status: 'internal' };
  }
  if (result.status !== 'found') {
    return { status: 'unauthorized' };
  }
  const token = readCsrfHeader(req);
  if (token === null || !isValidCsrfToken(token)) {
    logger.warn({
      event: 'csrf_rejected',
      reason: token === null ? 'missing' : 'malformed',
    });
    return { status: 'csrf_invalid' };
  }
  if (!constantTimeTokenMatch(token, result.session.csrfToken)) {
    logger.warn({ event: 'csrf_rejected', reason: 'mismatch' });
    return { status: 'csrf_invalid' };
  }
  return { status: 'ok', sessionId: result.session.sessionId };
}

/**
 * Write the standard shared error envelope for a failed centralized CSRF
 * check. Returns `true` only when the request may proceed to its handler;
 * the caller must not invoke the handler when `false` is returned.
 */
export function respondToCsrf(res: ServerResponse, result: CsrfCheckResult): boolean {
  if (result.status === 'ok') {
    return true;
  }
  const detail =
    result.status === 'unauthorized'
      ? errorDetail('UNAUTHORIZED')
      : result.status === 'csrf_invalid'
        ? errorDetail('CSRF_INVALID')
        : errorDetail('INTERNAL_ERROR');
  res.writeHead(detail.status, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(detail));
  return false;
}

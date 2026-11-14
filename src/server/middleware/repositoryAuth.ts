/**
 * Task 3.4 / Task 4.2 — repository authorization boundary for the content
 * operation surface (`/api/repos/{owner}/{repo}/content`).
 *
 * This module provides the reusable, fail-closed integration pattern that
 * every content endpoint must go through:
 *
 * - `matchContentRepositoryRef(pathname)` recognizes the content route
 *   shape.
 * - `enforceContentBoundary(...)` is the gate content handlers must call
 *   before performing a content operation: it re-verifies the session,
 *   refreshes the user's access token when needed (task 3.5), runs the
 *   fresh `authorizeRepository` check, and maps the outcome to the
 *   established error contracts. An authorized request receives
 *   `{ authorized: true, session }`, where `session` is the exact session
 *   state the authorization decision was made on (including the refreshed
 *   access token when one was needed); handlers must build their
 *   authenticated client from that credential rather than re-reading the
 *   stored session, which may still hold a pre-refresh token.
 *
 * The boundary runs AFTER the centralized CSRF boundary (task 3.3) for
 * state-changing requests and never substitutes for it: CSRF proves the
 * request came from the authenticated browser session, authorization
 * proves the session is permitted on the target repository.
 *
 * Failure mapping (safe, standard envelope):
 * - missing/expired session, missing session cookie → 401 UNAUTHORIZED
 * - authorization denied (any condition) → 403 REPO_NOT_ALLOWED
 * - GitHub rate limit (429 / 403 with X-RateLimit-Remaining: 0) → 429 RATE_LIMITED
 * - GitHub unavailable (5xx) → 502 GITHUB_UNAVAILABLE
 * - unexpected failure → safe INTERNAL_ERROR envelope
 *
 * No credentials, permission details, repository contents, session IDs,
 * CSRF tokens, or upstream bodies are included in any response.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { errorDetail } from '../../shared/errors.js';
import { parseSessionCookie } from '../session/cookies.js';
import { authorizeRepository } from '../auth/authorization.js';
import type { RequiredRepoAccess } from '../auth/permissions.js';
import { AuthError } from '../auth/types.js';
import type { AuthRouteDeps } from '../auth/routes.js';
import type { StoredSession } from '../session/types.js';
import { sendJsonError } from './errorHandling.js';
import type { Logger } from './logging.js';

/** A repository reference parsed from a future content path. */
export interface ContentRepositoryRef {
  readonly owner: string;
  readonly repo: string;
}

/**
 * The future content-operation route shape:
 * `/api/repos/{owner}/{repo}/content` and any path beneath it.
 */
const CONTENT_REPOSITORY_PATTERN = /^\/api\/repos\/([^/]+)\/([^/]+)\/content(?:\/|$)/;

/**
 * Parse `{owner, repo}` from a content path, or `null` when the path is not
 * a content-operation path. Owner/repo are validated again inside
 * `authorizeRepository` before any upstream request.
 */
export function matchContentRepositoryRef(pathname: string): ContentRepositoryRef | null {
  const match = pathname.match(CONTENT_REPOSITORY_PATTERN);
  if (match === null) return null;
  const owner = match[1] ?? '';
  const repo = match[2] ?? '';
  if (owner.length === 0 || repo.length === 0) return null;
  return { owner, repo };
}

/**
 * The outcome of a content-boundary check.
 *
 * When the request is authorized, the result carries the exact session
 * state the authorization decision was made on — including the refreshed
 * access token produced by the task 3.5 refresh step when one was needed.
 * Content handlers must build their authenticated client from that
 * credential, never from a fresh re-read of the stored session (which may
 * still hold the pre-refresh token) and never from another user's token.
 * When the request is denied, the boundary has already written the safe
 * error response; the caller must not write anything else.
 */
export type ContentBoundaryOutcome =
  | { readonly authorized: true; readonly session: StoredSession }
  | { readonly authorized: false };

/**
 * Enforce repository authorization for a content operation.
 *
 * Returns an authorized outcome carrying the session state used for the
 * decision when the request may proceed. Otherwise it writes a safe error
 * response and returns `{ authorized: false }`.
 */
export async function enforceContentBoundary(
  req: IncomingMessage,
  res: ServerResponse,
  ref: ContentRepositoryRef,
  requiredAccess: RequiredRepoAccess,
  deps: AuthRouteDeps,
  logger: Logger,
): Promise<ContentBoundaryOutcome> {
  // 1) Session gate: same lookup semantics as repository discovery. When
  //    session storage is unavailable no authenticated session can exist,
  //    so the boundary fails closed with 401.
  if (deps.session === null) {
    sendJsonError(res, errorDetail('UNAUTHORIZED'));
    return { authorized: false };
  }
  const sessionId = parseSessionCookie(req.headers.cookie);
  if (sessionId === null) {
    sendJsonError(res, errorDetail('UNAUTHORIZED'));
    return { authorized: false };
  }
  let lookup;
  try {
    lookup = deps.session.storage.getSession(sessionId);
  } catch {
    logger.error({ event: 'content_boundary_session_error' });
    sendJsonError(res, errorDetail('INTERNAL_ERROR'));
    return { authorized: false };
  }
  if (lookup.status !== 'found') {
    sendJsonError(res, errorDetail('UNAUTHORIZED'));
    return { authorized: false };
  }
  const session = lookup.session;

  // 2) Task 3.5: obtain a currently valid user access token. This refreshes
  //    (rotating both credentials) when the stored access token has expired.
  //    Transient upstream failures map to 429/502; unrecoverable credential
  //    failures (and deleted/expired sessions) map to 401, so a request
  //    never proceeds with a dead or stale token.
  let sessionForAuthorization = session;
  if (deps.refresh !== null) {
    const token = await deps.refresh.getValidAccessToken(session.sessionId);
    if (token.status === 'rate_limited') {
      sendJsonError(res, errorDetail('RATE_LIMITED'));
      return { authorized: false };
    }
    if (token.status === 'upstream_unavailable') {
      sendJsonError(res, errorDetail('GITHUB_UNAVAILABLE'));
      return { authorized: false };
    }
    if (token.status !== 'valid') {
      sendJsonError(res, errorDetail('UNAUTHORIZED'));
      return { authorized: false };
    }
    sessionForAuthorization = {
      ...session,
      credentials: { ...session.credentials, accessToken: token.accessToken },
    };
  }

  // 3) Fresh repository authorization (never a cached discovery result).
  try {
    const authorization = await authorizeRepository(
      sessionForAuthorization,
      ref.owner,
      ref.repo,
      requiredAccess,
      { fetchImpl: deps.fetchImpl },
    );
    if (authorization.status !== 'authorized') {
      // `denied` (403) and `unauthorized` (401) are distinct outcomes.
      if (authorization.status === 'unauthorized') {
        // A definitive GitHub 401 against the user's stored credentials
        // proves they are invalid or revoked: invalidate the session (same
        // behavior as repository discovery). Permission denials (403) and
        // rate limits must NOT invalidate.
        deps.session.storage.deleteSession(session.sessionId);
        deps.logger.warn({ event: 'session_invalidated', reason: 'github_401' });
        sendJsonError(res, errorDetail('UNAUTHORIZED'));
        return { authorized: false };
      }
      logger.warn({ event: 'content_boundary_denied', access: requiredAccess });
      sendJsonError(res, errorDetail('REPO_NOT_ALLOWED'));
      return { authorized: false };
    }
    // The authorized outcome carries the exact session state (including the
    // refreshed access token) the decision was made on, so handlers can
    // build their client without re-reading potentially stale storage.
    return { authorized: true, session: sessionForAuthorization };
  } catch (err) {
    if (err instanceof AuthError) {
      logger.warn({ event: 'content_boundary_upstream_error', code: err.code });
      if (err.code === 'UNAUTHORIZED') {
        // A definitive GitHub 401 against the user's stored credentials
        // proves they are invalid or revoked: invalidate the session.
        deps.session.storage.deleteSession(session.sessionId);
        deps.logger.warn({ event: 'session_invalidated', reason: 'github_401' });
        sendJsonError(res, errorDetail('UNAUTHORIZED'));
        return { authorized: false };
      }
      if (err.code === 'RATE_LIMITED') {
        sendJsonError(res, errorDetail('RATE_LIMITED'));
        return { authorized: false };
      }
      if (err.code === 'GITHUB_UNAVAILABLE') {
        sendJsonError(res, errorDetail('GITHUB_UNAVAILABLE'));
        return { authorized: false };
      }
    }
    logger.error({ event: 'content_boundary_unexpected' });
    sendJsonError(res, errorDetail('INTERNAL_ERROR'));
    return { authorized: false };
  }
}

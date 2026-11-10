/**
 * Task 3.4 — repository authorization boundary for the future content
 * operation surface (`/api/repos/{owner}/{repo}/content`).
 *
 * The content endpoints do not exist yet (they belong to a later task), so
 * this module establishes the reusable, fail-closed integration pattern:
 *
 * - `matchContentRepositoryRef(pathname)` recognizes the future content
 *   route shape without registering a fake endpoint.
 * - `enforceContentBoundary(...)` is the gate future handlers must call
 *   before performing a content operation: it re-verifies the session,
 *   runs the fresh `authorizeRepository` check, and maps the outcome to
 *   the established error contracts. A request that passes the gate still
 *   receives the standard 404 until the content handlers land, so no
 *   production content functionality is introduced by this task.
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
 * Enforce repository authorization for a future content operation.
 *
 * Returns `true` when the request is authorized to proceed (the caller then
 * responds per its own route rules — today that is the standard 404 because
 * no content handler is registered yet). Returns `false` after writing a
 * safe error response; the caller must not write anything else.
 */
export async function enforceContentBoundary(
  req: IncomingMessage,
  res: ServerResponse,
  ref: ContentRepositoryRef,
  requiredAccess: RequiredRepoAccess,
  deps: AuthRouteDeps,
  logger: Logger,
): Promise<boolean> {
  // 1) Session gate: same lookup semantics as repository discovery. When
  //    session storage is unavailable no authenticated session can exist,
  //    so the boundary fails closed with 401.
  if (deps.session === null) {
    sendJsonError(res, errorDetail('UNAUTHORIZED'));
    return false;
  }
  const sessionId = parseSessionCookie(req.headers.cookie);
  if (sessionId === null) {
    sendJsonError(res, errorDetail('UNAUTHORIZED'));
    return false;
  }
  let lookup;
  try {
    lookup = deps.session.storage.getSession(sessionId);
  } catch {
    logger.error({ event: 'content_boundary_session_error' });
    sendJsonError(res, errorDetail('INTERNAL_ERROR'));
    return false;
  }
  if (lookup.status !== 'found') {
    sendJsonError(res, errorDetail('UNAUTHORIZED'));
    return false;
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
      return false;
    }
    if (token.status === 'upstream_unavailable') {
      sendJsonError(res, errorDetail('GITHUB_UNAVAILABLE'));
      return false;
    }
    if (token.status !== 'valid') {
      sendJsonError(res, errorDetail('UNAUTHORIZED'));
      return false;
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
        return false;
      }
      logger.warn({ event: 'content_boundary_denied', access: requiredAccess });
      sendJsonError(res, errorDetail('REPO_NOT_ALLOWED'));
      return false;
    }
    return true;
  } catch (err) {
    if (err instanceof AuthError) {
      logger.warn({ event: 'content_boundary_upstream_error', code: err.code });
      if (err.code === 'UNAUTHORIZED') {
        // A definitive GitHub 401 against the user's stored credentials
        // proves they are invalid or revoked: invalidate the session.
        deps.session.storage.deleteSession(session.sessionId);
        deps.logger.warn({ event: 'session_invalidated', reason: 'github_401' });
        sendJsonError(res, errorDetail('UNAUTHORIZED'));
        return false;
      }
      if (err.code === 'RATE_LIMITED') {
        sendJsonError(res, errorDetail('RATE_LIMITED'));
        return false;
      }
      if (err.code === 'GITHUB_UNAVAILABLE') {
        sendJsonError(res, errorDetail('GITHUB_UNAVAILABLE'));
        return false;
      }
    }
    logger.error({ event: 'content_boundary_unexpected' });
    sendJsonError(res, errorDetail('INTERNAL_ERROR'));
    return false;
  }
}

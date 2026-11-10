/**
 * Task 3.5 — GitHub App user access token refresh service (server-only).
 *
 * Implements the GitHub App user-to-server refresh flow documented at
 * https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
 *
 * Request:
 *   POST https://github.com/login/oauth/access_token
 *   client_id=<App client ID>
 *   client_secret=<App client secret>
 *   grant_type=refresh_token
 *   refresh_token=<stored refresh token>
 *
 * Documented response contract (JSON):
 *   access_token             new short-lived user access token
 *   expires_in               lifetime in seconds (App user tokens always expire)
 *   refresh_token            new refresh token; GitHub invalidates BOTH the
 *                            previous access token and the previous refresh
 *                            token (rotation is enforced by GitHub)
 *   refresh_token_expires_in refresh-token lifetime in seconds (15897600)
 *   scope / token_type       informational ("" and "bearer")
 *
 * Documented failure semantics:
 *   - An expired, revoked, or otherwise invalid refresh token is rejected
 *     (documented error value: `bad_refresh_token`). The affected session
 *     cannot be recovered without re-running the web authorization flow, so
 *     the session is deleted and the refresh token is never retried.
 *   - HTTP 429, and HTTP 403 with the documented rate-limit indication
 *     (`X-RateLimit-Remaining: 0`), are transient rate limits: the session
 *     is preserved and the refresh token is not consumed.
 *   - HTTP 401 and a genuine credential-rejection 403 are unauthorized:
 *     the session is invalidated and the refresh token is never retried.
 *   - Transient 5xx / network failures are upstream unavailability: the
 *     session is preserved.
 *   - A revoked authorization surfaces as `401 Bad Credentials` when the
 *     (revoked) access token is used against the API; authenticated routes
 *     map that to an unauthorized response and never grant repository access.
 *
 * Concurrency:
 *   Per-session single-flight bookkeeping (in-memory Map) serializes
 *   concurrent refresh requests for the same session: one request submits
 *   the refresh token, the others share its result. This is correct for the
 *   current single-process Node server. It is NOT cross-process or
 *   cross-instance safe; a multi-instance deployment would need an external
 *   serialization guard (deliberately out of scope).
 *
 * Security:
 *   - Never returns the refresh token or the client secret to callers.
 *   - Never logs token values or secrets; log entries carry fixed event
 *     names and safe reason codes only.
 */

import type { Logger } from '../middleware/logging.js';
import type { SessionLookupResult, SessionStorage } from '../session/types.js';
import type { AuthConfig } from './types.js';

/**
 * Refresh the access token when it expires within this window (1 minute).
 * The window only guards boundary clock skew: normal operation refreshes on
 * the documented expiration itself, well before any practical skew.
 */
export const REFRESH_SAFETY_WINDOW_MS = 60_000;

/** GitHub's user access token endpoint (initial exchange and refresh). */
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/**
 * Documented fixed refresh-token lifetime in seconds, used when a response
 * omits `refresh_token_expires_in`.
 */
const REFRESH_TOKEN_LIFETIME_DEFAULT_S = 15_897_600;

/**
 * Outcome of requesting a usable access token for a session:
 * - 'valid'                token usable for authenticated GitHub calls.
 * - 'unauthorized'         session missing/expired, or credentials
 *                          irrecoverably invalid (session deleted).
 * - 'rate_limited'         GitHub rate-limited the refresh call; the session
 *                          is preserved (valid credentials, transient failure).
 * - 'upstream_unavailable' transient GitHub or transport failure; the session
 *                          is preserved.
 */
export type AccessTokenOutcome =
  | { readonly status: 'valid'; readonly accessToken: string }
  | { readonly status: 'unauthorized' }
  | { readonly status: 'rate_limited' }
  | { readonly status: 'upstream_unavailable' };

export interface TokenRefreshDeps {
  readonly storage: SessionStorage;
  readonly authConfig: AuthConfig;
  readonly now: () => number;
  readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  readonly logger: Logger;
}

export interface TokenRefreshService {
  /**
   * Return a valid user access token for the session, refreshing (and
   * rotating both credentials) when the stored access token has expired or
   * is about to. Refresh failures are classified per the documented GitHub
   * semantics; see the module header.
   */
  getValidAccessToken(sessionId: string): Promise<AccessTokenOutcome>;
}

interface RefreshResponseData {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresIn: number;
  readonly refreshExpiresIn: number;
}

export function createTokenRefreshService(deps: TokenRefreshDeps): TokenRefreshService {
  /** In-flight refresh operations per session (single-process single-flight). */
  const inflight = new Map<string, Promise<AccessTokenOutcome>>();

  /**
   * Delete the session and log a safe (secret-free) reason. Used for every
   * unrecoverable outcome: the session must never be left behind for a
   * refresh that has already failed or consumed its refresh token.
   */
  function invalidate(sessionId: string, reason: string): void {
    try {
      deps.storage.deleteSession(sessionId);
    } catch {
      /* session already gone */
    }
    deps.logger.warn({ event: 'token_refresh_invalidated', reason });
  }

  async function performRefresh(
    sessionId: string,
    refreshToken: string,
  ): Promise<AccessTokenOutcome> {
    const body = new URLSearchParams({
      client_id: deps.authConfig.clientId,
      client_secret: deps.authConfig.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString();

    let response: Response;
    try {
      response = await deps.fetchImpl(GITHUB_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
      });
    } catch {
      // Transient transport failure: stored credentials are untouched.
      deps.logger.warn({ event: 'token_refresh_transport_error' });
      return { status: 'upstream_unavailable' };
    }

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(await response.text());
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      if (response.status === 429) {
        // Rate limiting is transient; do not invalidate valid credentials.
        deps.logger.warn({ event: 'token_refresh_rate_limited' });
        return { status: 'rate_limited' };
      }
      // GitHub documents rate-limit responses as HTTP 403 with
      // X-RateLimit-Remaining: 0 (the same reliable indication used by the
      // existing authorizationStatusError classification). This is
      // transient, not a credential rejection: the refresh token was not
      // consumed, so the session is preserved.
      if (
        response.status === 403 &&
        response.headers.get('x-ratelimit-remaining') === '0'
      ) {
        deps.logger.warn({ event: 'token_refresh_rate_limited' });
        return { status: 'rate_limited' };
      }
      if (response.status >= 500) {
        // Service failure is transient; retrying later must not consume
        // the refresh token (it is only submitted on the next attempt).
        deps.logger.warn({ event: 'token_refresh_upstream_error' });
        return { status: 'upstream_unavailable' };
      }
      // Any other 4xx: 401 and a genuine credential-rejection 403 are
      // unauthorized (invalidate); the documented `bad_refresh_token`
      // rejection is unrecoverable and must never be retried.
      const reason =
        isRecord(parsed) && parsed.error === 'bad_refresh_token'
          ? 'bad_refresh_token'
          : response.status === 401 || response.status === 403
            ? 'unauthorized'
            : 'request_denied';
      invalidate(sessionId, reason);
      return { status: 'unauthorized' };
    }

    const data = validateRefreshResponse(parsed);
    if (data === null) {
      // A 2xx response that fails the documented contract is untrustworthy,
      // and the old refresh token may already have been consumed by the
      // rotation. Fail closed: invalidate the session, never retry.
      invalidate(sessionId, 'malformed_response');
      return { status: 'unauthorized' };
    }

    const nowMs = deps.now();
    try {
      const rotation = deps.storage.rotateCredentials(sessionId, {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        tokenExpiresAt: nowMs + data.accessExpiresIn * 1000,
        refreshExpiresAt: nowMs + data.refreshExpiresIn * 1000,
      });
      if (rotation === undefined || rotation.status !== 'found') {
        // The session was deleted or expired while the refresh was in
        // flight; GitHub has already consumed the old refresh token.
        invalidate(sessionId, 'session_gone');
        return { status: 'unauthorized' };
      }
    } catch {
      // Rotation persistence failed after GitHub rotated the credentials:
      // the stored refresh token is already consumed, so the session is
      // unrecoverable. Fail closed instead of retrying a dead token.
      invalidate(sessionId, 'persist_failed');
      return { status: 'unauthorized' };
    }

    deps.logger.info({ event: 'token_refresh_rotated' });
    return { status: 'valid', accessToken: data.accessToken };
  }

  return {
    async getValidAccessToken(sessionId: string): Promise<AccessTokenOutcome> {
      let lookup: SessionLookupResult;
      try {
        lookup = deps.storage.getSession(sessionId);
      } catch {
        deps.logger.error({ event: 'token_refresh_lookup_failed' });
        return { status: 'unauthorized' };
      }
      if (lookup.status !== 'found') {
        return { status: 'unauthorized' };
      }

      const credentials = lookup.session.credentials;
      const nowMs = deps.now();

      // Not expired (outside the safety window): no GitHub round-trip.
      if (credentials.tokenExpiresAt - REFRESH_SAFETY_WINDOW_MS > nowMs) {
        return { status: 'valid', accessToken: credentials.accessToken };
      }

      // Refresh token already expired: invalidate without contacting GitHub.
      if (credentials.refreshExpiresAt <= nowMs) {
        invalidate(sessionId, 'refresh_expired');
        return { status: 'unauthorized' };
      }

      // Defensive: an expired access token with no usable refresh token
      // cannot be recovered.
      if (credentials.refreshToken.length === 0) {
        invalidate(sessionId, 'missing_refresh_token');
        return { status: 'unauthorized' };
      }

      const shared = inflight.get(sessionId);
      if (shared !== undefined) {
        // Another request is already rotating this session; share its result.
        return shared;
      }
      const operation = performRefresh(sessionId, credentials.refreshToken).finally(
        () => {
          inflight.delete(sessionId);
        },
      );
      inflight.set(sessionId, operation);
      return operation;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate the documented refresh response shape. Returns null when any
 * required field is missing or malformed:
 *   access_token (non-empty string), refresh_token (non-empty string),
 *   expires_in (positive integer), refresh_token_expires_in (positive
 *   integer, defaulting to the documented fixed lifetime when omitted).
 */
function validateRefreshResponse(parsed: unknown): RefreshResponseData | null {
  if (!isRecord(parsed)) return null;
  const { access_token, refresh_token, expires_in, refresh_token_expires_in } = parsed;
  if (typeof access_token !== 'string' || access_token.length === 0) return null;
  if (typeof refresh_token !== 'string' || refresh_token.length === 0) return null;
  if (typeof expires_in !== 'number' || !Number.isInteger(expires_in) || expires_in <= 0) {
    return null;
  }
  const refreshExpiresIn =
    refresh_token_expires_in === undefined ? REFRESH_TOKEN_LIFETIME_DEFAULT_S : refresh_token_expires_in;
  if (
    typeof refreshExpiresIn !== 'number' ||
    !Number.isInteger(refreshExpiresIn) ||
    refreshExpiresIn <= 0
  ) {
    return null;
  }
  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    accessExpiresIn: expires_in,
    refreshExpiresIn,
  };
}

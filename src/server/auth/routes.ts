/**
 * HTTP route handlers for the GitHub App user web flow (task 3.2).
 *
 * Endpoints:
 * - `GET  /api/auth/github/start`    — begin OAuth (302 to GitHub)
 * - `GET  /api/auth/github/callback` — complete OAuth (302 to the app)
 * - `GET  /api/session`              — session probe for the frontend
 * - `POST /api/auth/logout`          — CSRF-protected session deletion
 * - `GET  /api/repositories`         — Task 3.2 repository discovery boundary
 *
 * Security notes:
 * - State, verifiers, cookies, authorization codes, and tokens are never
 *   logged. Callback failures redirect to `/error?reason=<safe-code>`;
 *   GitHub error text, codes, and internal messages are never echoed.
 * - The callback query string contains the authorization code, so request
 *   logging must never include query strings (the existing logging
 *   middleware logs pathname only — preserved here).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { clearPendingAuthCookie, issuePendingAuthCookie, parsePendingAuthCookie } from './cookies.js';
import { GITHUB_AUTHORIZATION_URL, GITHUB_APP_SCOPE } from './config.js';
import { exchangeUserToken, fetchUserProfile, listAccessibleRepositories } from './github.js';
import {
  clearSessionCookie,
  issueSessionCookie,
  parseSessionCookie,
  SessionStorageError,
  type SessionConfig,
  type SessionStorage,
  type SessionLookupResult,
} from '../session/index.js';
import { DEFAULT_CONTENT_ROOT } from '../../shared/types.js';
import { errorDetail } from '../../shared/errors.js';
import type { ErrorDetail } from '../../shared/types.js';
import {
  AuthError,
  type AuthConfig,
  type PendingStateStore,
  type TokenResponseData,
} from './types.js';
import type { Logger } from '../middleware/logging.js';

export interface AuthRouteDeps {
  readonly logger: Logger;
  readonly now: () => number;
  readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  /** `null` when the GitHub App web-flow configuration is absent. */
  readonly authConfig: AuthConfig | null;
  /** `null` when session storage is unavailable. */
  readonly stateStore: PendingStateStore | null;
  readonly session: { storage: SessionStorage; config: SessionConfig } | null;
  /** `true` when cookies must carry `Secure` (production/HTTPS). */
  readonly cookieSecure: boolean;
}

type ErrorReason =
  | 'auth_unconfigured'
  | 'state_invalid'
  | 'state_expired'
  | 'state_replayed'
  | 'consent_denied'
  | 'token_error'
  | 'profile_error'
  | 'session_error'
  | 'github_unavailable'
  | 'rate_limited'
  | 'internal';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' } as const;

function sendRedirect(res: ServerResponse, location: string, cookies: string[] = []): void {
  const headers: Record<string, string | string[]> = { Location: location };
  if (cookies.length > 0) headers['Set-Cookie'] = cookies;
  res.writeHead(302, headers);
  res.end();
}

function redirectWithError(res: ServerResponse, reason: ErrorReason): void {
  if (res.headersSent) return;
  sendRedirect(res, `/error?reason=${reason}`);
}

function sendJson(res: ServerResponse, status: number, detail: ErrorDetail): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(detail));
}

function storageErrorName(err: unknown): string {
  return err instanceof SessionStorageError ? err.code : 'INTERNAL';
}

function codeToReason(err: AuthError): ErrorReason {
  switch (err.code) {
    case 'STATE_INVALID':
      return 'state_invalid';
    case 'STATE_EXPIRED':
      return 'state_expired';
    case 'STATE_REPLAYED':
      return 'state_replayed';
    case 'CONSENT_DENIED':
      return 'consent_denied';
    case 'TOKEN_ERROR':
    case 'UNAUTHORIZED':
      return 'token_error';
    case 'PROFILE_ERROR':
      return 'profile_error';
    case 'SESSION_ERROR':
      return 'session_error';
    case 'RATE_LIMITED':
      return 'rate_limited';
    case 'GITHUB_UNAVAILABLE':
      return 'github_unavailable';
    case 'AUTH_NOT_CONFIGURED':
      return 'auth_unconfigured';
    default:
      return 'internal';
  }
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * `GET /api/auth/github/start`
 *
 * Generates a cryptographically random state and PKCE verifier, stores the
 * pending authorization server-side (10-minute TTL, one-time consumption),
 * binds the attempt to the initiating browser with an HttpOnly cookie, and
 * redirects to GitHub's authorization URL with `scope=offline_access`.
 */
export function handleAuthStart(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: AuthRouteDeps,
): void {
  if (deps.authConfig === null || deps.stateStore === null || deps.session === null) {
    deps.logger.warn({ event: 'auth_start_unavailable' });
    redirectWithError(res, 'auth_unconfigured');
    return;
  }
  const nowMs = deps.now();
  const state = randomBytes(32).toString('hex');
  const verifier = randomBytes(32).toString('hex');
  try {
    deps.stateStore.create(state, verifier, nowMs);
  } catch (err) {
    deps.logger.error({ event: 'auth_state_store_error', code: storageErrorName(err) });
    redirectWithError(res, 'internal');
    return;
  }
  const authorizationUrl = new URL(GITHUB_AUTHORIZATION_URL);
  authorizationUrl.searchParams.set('client_id', deps.authConfig.clientId);
  authorizationUrl.searchParams.set('redirect_uri', deps.authConfig.callbackUrl);
  authorizationUrl.searchParams.set('state', state);
  authorizationUrl.searchParams.set('scope', GITHUB_APP_SCOPE);
  authorizationUrl.searchParams.set('code_challenge', pkceChallenge(verifier));
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  const cookie = issuePendingAuthCookie(state, deps.cookieSecure, nowMs);
  deps.logger.info({ event: 'auth_start' });
  sendRedirect(res, authorizationUrl.toString(), [cookie]);
}

/**
 * `GET /api/auth/github/callback`
 *
 * Validates the browser binding, consumes the state exactly once, exchanges
 * the authorization code (with the PKCE verifier), fetches `/user`, creates
 * an encrypted session, sets the session cookie, clears the pending
 * binding, and redirects to the fixed local application destination (`/`).
 *
 * Every failure path redirects to `/error?reason=<safe-code>`. The pending
 * state is consumed (and therefore unreplayable) even on failure.
 */
export async function handleAuthCallback(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AuthRouteDeps,
): Promise<void> {
  try {
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
    const errorParam = query.get('error');
    const state = query.get('state');
    const code = query.get('code');

    // Provider-side consent denial or other GitHub error: handle safely.
    if (errorParam !== null) {
      deps.logger.warn({ event: 'auth_consent_denied', error: errorParam });
      redirectWithError(res, 'consent_denied');
      return;
    }

    if (deps.authConfig === null || deps.stateStore === null || deps.session === null) {
      redirectWithError(res, 'auth_unconfigured');
      return;
    }

    if (state === null || code === null || state.length !== 64) {
      redirectWithError(res, 'state_invalid');
      return;
    }

    // Browser binding: the callback must carry the pending-auth cookie that
    // was issued to the browser that started sign-in.
    const boundState = parsePendingAuthCookie(req.headers.cookie);
    if (boundState === null || !timingSafeEqualHex(boundState, state)) {
      deps.logger.warn({ event: 'auth_callback_binding_mismatch' });
      redirectWithError(res, 'state_invalid');
      return;
    }

    const nowMs = deps.now();
    const consumed = deps.stateStore.consume(state, nowMs);
    if (consumed.kind !== 'consumed') {
      const reason: ErrorReason =
        consumed.kind === 'missing'
          ? 'state_invalid'
          : consumed.kind === 'expired'
            ? 'state_expired'
            : 'state_replayed';
      deps.logger.warn({ event: 'auth_callback_state_rejected', reason });
      redirectWithError(res, reason);
      return;
    }

    let tokens: TokenResponseData;
    try {
      tokens = await exchangeUserToken(
        deps.authConfig,
        code,
        consumed.verifier,
        deps.fetchImpl,
      );
    } catch (err) {
      fail(res, deps, err, 'auth_callback_token_failed');
      return;
    }

    let profile;
    try {
      profile = await fetchUserProfile(tokens.accessToken, deps.fetchImpl);
    } catch (err) {
      fail(res, deps, err, 'auth_callback_profile_failed');
      return;
    }

    let session;
    try {
      session = deps.session.storage.createSession({
        user: {
          login: profile.login,
          // GitHub `name` is nullable; fall back to the login handle so the
          // session contract (non-empty string) always holds.
          name: profile.name ?? profile.login,
          avatarUrl: profile.avatarUrl,
        },
        credentials: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          tokenExpiresAt: nowMs + tokens.accessExpiresIn * 1000,
          refreshExpiresAt: nowMs + tokens.refreshExpiresIn * 1000,
        },
      });
    } catch (err) {
      deps.logger.error({ event: 'auth_session_create_failed', code: storageErrorName(err) });
      redirectWithError(res, 'session_error');
      return;
    }

    const sessionCookie = issueSessionCookie(session.sessionId, {
      secure: deps.cookieSecure,
      maxAgeDays: deps.session.config.maxAgeDays,
      now: deps.now,
    });
    deps.logger.info({ event: 'auth_login' });
    sendRedirect(res, '/', [sessionCookie, clearPendingAuthCookie(deps.cookieSecure)]);
  } catch (err) {
    // Unexpected failure: never leak internals into the browser URL.
    deps.logger.error({ event: 'auth_callback_unexpected', code: storageErrorName(err) });
    if (!res.headersSent) redirectWithError(res, 'internal');
  }
}

function fail(res: ServerResponse, deps: AuthRouteDeps, err: unknown, event: string): void {
  const reason: ErrorReason = err instanceof AuthError ? codeToReason(err) : 'internal';
  const code = err instanceof AuthError ? err.code : 'INTERNAL';
  deps.logger.warn({ event, code, reason });
  if (!res.headersSent) redirectWithError(res, reason);
}

/**
 * `GET /api/session`
 *
 * Returns `{ connected: false }` for unauthenticated requests. For valid
 * sessions it returns only `connected`, the non-secret identity fields, and
 * the per-session CSRF token. Tokens, refresh tokens, session ids, and
 * internal database information are never returned.
 */
export function handleSession(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: AuthRouteDeps,
): void {
  const body: {
    connected: boolean;
    user?: { login: string; name: string; avatarUrl: string };
    csrfToken?: string;
  } = { connected: false };

  const session = deps.session;
  if (session !== null) {
    const sessionId = parseSessionCookie(_req.headers.cookie);
    if (sessionId !== null) {
      try {
        const result = session.storage.getSession(sessionId);
        if (result.status === 'found') {
          body.connected = true;
          body.user = {
            login: result.session.user.login,
            name: result.session.user.name,
            avatarUrl: result.session.user.avatarUrl,
          };
          body.csrfToken = result.session.csrfToken;
        }
        // Expired and missing sessions behave as unauthenticated.
      } catch (err) {
        // Never expose storage internals; treat as disconnected.
        deps.logger.error({ event: 'session_lookup_failed', code: storageErrorName(err) });
      }
    }
  }
  res.writeHead(200, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/**
 * `POST /api/auth/logout`
 *
 * Requires a valid session and a matching `X-CSRF-Token` header (the only
 * accepted CSRF source). Deletes the session server-side and clears the
 * session cookie.
 */
export function handleLogout(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AuthRouteDeps,
): void {
  if (deps.session === null) {
    sendJson(res, 401, errorDetail('UNAUTHORIZED'));
    return;
  }
  const sessionId = parseSessionCookie(req.headers.cookie);
  if (sessionId === null) {
    sendJson(res, 401, errorDetail('UNAUTHORIZED'));
    return;
  }
  let result: SessionLookupResult;
  try {
    result = deps.session.storage.getSession(sessionId);
  } catch (err) {
    deps.logger.error({ event: 'session_lookup_failed', code: storageErrorName(err) });
    sendJson(res, 500, errorDetail('INTERNAL_ERROR'));
    return;
  }
  if (result.status !== 'found') {
    sendJson(res, 401, errorDetail('UNAUTHORIZED'));
    return;
  }
  const header = req.headers['x-csrf-token'];
  const token = typeof header === 'string' ? header : Array.isArray(header) ? header[0] : '';
  if (!validateCsrf(token, result.session.csrfToken)) {
    deps.logger.warn({ event: 'logout_csrf_rejected' });
    sendJson(res, 403, errorDetail('CSRF_INVALID'));
    return;
  }
  try {
    deps.session.storage.deleteSession(sessionId);
  } catch (err) {
    deps.logger.error({ event: 'session_delete_failed', code: storageErrorName(err) });
    sendJson(res, 500, errorDetail('INTERNAL_ERROR'));
    return;
  }
  res.writeHead(204, { 'Set-Cookie': clearSessionCookie({ secure: deps.cookieSecure }) });
  res.end();
  deps.logger.info({ event: 'logout' });
}

function validateCsrf(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * `GET /api/repositories`
 *
 * Task 3.2 discovery boundary. Requires an authenticated session and uses
 * the user's own access token (never an application-wide privileged token)
 * with the two-step installations flow. `canRead`/`canWrite` are truthful
 * per-repository permissions; the fixed default content root is preserved.
 */
export async function handleRepositories(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: AuthRouteDeps,
): Promise<void> {
  try {
    if (deps.authConfig === null || deps.session === null) {
      sendJson(res, 401, errorDetail('UNAUTHORIZED'));
      return;
    }
    const sessionId = parseSessionCookie(_req.headers.cookie);
    if (sessionId === null) {
      sendJson(res, 401, errorDetail('UNAUTHORIZED'));
      return;
    }
    let result: SessionLookupResult;
    try {
      result = deps.session.storage.getSession(sessionId);
    } catch (err) {
      deps.logger.error({ event: 'session_lookup_failed', code: storageErrorName(err) });
      sendJson(res, 500, errorDetail('INTERNAL_ERROR'));
      return;
    }
    if (result.status !== 'found') {
      sendJson(res, 401, errorDetail('UNAUTHORIZED'));
      return;
    }

    let repos;
    try {
      repos = await listAccessibleRepositories(
        result.session.credentials.accessToken,
        deps.fetchImpl,
      );
    } catch (err) {
      deps.logger.warn({
        event: 'repositories_failed',
        code: err instanceof AuthError ? err.code : 'INTERNAL',
      });
      if (err instanceof AuthError) {
        if (err.code === 'UNAUTHORIZED') {
          sendJson(res, 401, errorDetail('UNAUTHORIZED'));
          return;
        }
        if (err.code === 'RATE_LIMITED') {
          sendJson(res, 429, errorDetail('RATE_LIMITED'));
          return;
        }
        if (err.code === 'GITHUB_UNAVAILABLE') {
          sendJson(res, 502, errorDetail('GITHUB_UNAVAILABLE'));
          return;
        }
      }
      sendJson(res, 500, errorDetail('INTERNAL_ERROR'));
      return;
    }

    const body = repos.map((r) => ({
      owner: r.owner,
      name: r.name,
      contentRoot: DEFAULT_CONTENT_ROOT,
      canRead: r.canRead,
      canWrite: r.canWrite,
      private: r.isPrivate,
    }));
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify(body));
  } catch (err) {
    deps.logger.error({ event: 'repositories_unexpected', code: storageErrorName(err) });
    if (!res.headersSent) sendJson(res, 500, errorDetail('INTERNAL_ERROR'));
  }
}

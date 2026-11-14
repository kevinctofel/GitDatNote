/**
 * GitDatNote backend entry point (OpenSpec task 2.4).
 *
 * A standalone Node HTTP server using only built-in modules:
 * - `GET /api/health` -> `200 { "status": "ok" }` (no authentication; confirms
 *   only that the HTTP process is responding — not GitHub or SQLite).
 * - Unknown `/api/*` route -> standard JSON 404 envelope.
 * - Malformed request targets (request lines that `new URL()` cannot parse,
 *   e.g. an absolute-form `http://x:99999/`) -> safe shared `PATH_INVALID`
 *   422 envelope; the request log line uses a fixed marker path and never
 *   echoes the raw target.
 * - Non-`/api` paths -> plain-text 404 (the frontend is served by Vite in dev
 *   and by static hosting in production).
 * - Structured request logging: method, route label, status, duration. Never
 *   logs bodies, query strings, headers, or credentials. Request lines log
 *   a minimal, deterministic route label (`labelRequestPath`) rather than
 *   raw path segments.
 * - Standard API error handling via the shared contracts in `src/shared`.
 *
 * Authentication routes (task 3.2), all server-side:
 * - `GET /api/auth/github/start` -> 302 to GitHub's App authorization URL.
 * - `GET /api/auth/github/callback` -> validates state/browser binding,
 *   exchanges the code, creates an encrypted session, 302 to `/`.
 * - `GET /api/session` -> `{ connected: false }` or `{ connected: true,
 *   user: { login, name, avatarUrl }, csrfToken }`.
 * - `POST /api/auth/logout` -> CSRF-protected session deletion (204).
 * - `GET /api/repositories` -> authenticated repository discovery boundary.
 *
 * Centralized CSRF security boundary (task 3.3): every state-changing
 * (`POST`/`PUT`/`DELETE`) `/api/*` request must pass session authentication
 * plus the session-bound `X-CSRF-Token` header before any handler executes
 * (see `src/server/middleware/csrf.ts`). Read-only routes — including the
 * GitHub OAuth callback, which validates its own state parameter — are
 * unaffected.
 * Missing GitHub App credentials make these routes fail safely (redirect to
 * `/error?reason=auth_unconfigured` or 401) without affecting health,
 * logging, or frontend serving.
 *
 * Configuration (environment variables):
 * - `PORT`     — listen port (default: 3000, matching the Vite `/api` proxy).
 *   If `PORT` is set to a value that is not a base-10 integer in 1–65535
 *   (e.g. `3999abc`), the server logs `invalid_port` and exits with code 1
 *   instead of silently falling back to the default port.
 * - `HOST`     — bind address (default: 127.0.0.1).
 * - `LOG_LEVEL` — debug | info | warn | error (default: info).
 */

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createLogger,
  labelRequestPath,
  logRequest,
  resolveLogLevel,
} from './middleware/logging.js';
import type { Logger, LogLevel } from './middleware/logging.js';
import { sendApiNotFound, sendJsonError, sendUnexpectedError } from './middleware/errorHandling.js';
import { checkCsrf, respondToCsrf } from './middleware/csrf.js';
import {
  enforceContentBoundary,
  matchContentRepositoryRef,
  type ContentRepositoryRef,
} from './middleware/repositoryAuth.js';
import {
  createAuthenticatedContentClient,
  createContentAdapter,
} from './content/index.js';
import { ContentAdapterError, type ContentClient } from './content/types.js';
import { DEFAULT_CONTENT_ROOT, type ContentResult } from '../shared/types.js';
import { errorDetail } from '../shared/errors.js';
import {
  handleAuthCallback,
  handleAuthStart,
  handleLogout,
  handleRepositories,
  handleSession,
  resolveAuthConfig,
  type AuthRouteDeps,
} from './auth/index.js';
import { createTokenRefreshService } from './auth/refresh.js';
import type { PendingStateStore } from './auth/index.js';
import { openPendingStateStore } from './auth/state.js';
import {
  openSessionStorage,
  resolveSessionConfig,
  resolveCookieSecure,
  SessionStorageError,
  type SessionConfig,
  type SessionStorage,
} from './session/index.js';
import type { StoredSession } from './session/types.js';

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '127.0.0.1';
const JSON_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json; charset=utf-8',
};
/**
 * Fixed marker logged for requests whose target `new URL()` cannot parse.
 * Never echoes the raw target: an absolute-form request line may carry
 * credentials in its userinfo/query.
 */
const UNPARSEABLE_PATH = '(unparseable)';

export interface AppOptions {
  /** Log level; defaults to the `LOG_LEVEL` environment variable (`info`). */
  readonly logLevel?: LogLevel;
  /** Environment map (defaults to `process.env`); tests inject fakes. */
  readonly env?: Record<string, string | undefined>;
  /** Injectable fetch for GitHub calls (tests mock all upstream traffic). */
  readonly fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Injectable clock (epoch milliseconds) for deterministic tests. */
  readonly now?: () => number;
  /**
   * Task 4.2: injectable factory for the authenticated content client of
   * the read-only content endpoint. Defaults to
   * `createAuthenticatedContentClient`. Tests inject a factory that
   * records which access token it receives, proving the handler builds
   * its client from the authorized-request credential (possibly
   * refreshed) rather than a fresh session-storage read.
   */
  readonly contentClientFactory?: (accessToken: string) => ContentClient;
}

/**
 * Build the HTTP application (route dispatch + logging + error boundary).
 * Exported so tests can bind to an ephemeral port; the process entry point
 * (`main`) performs the actual listen.
 */
export function createApp(options: AppOptions = {}): Server {
  const logger = createLogger(options.logLevel ?? resolveLogLevel());
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const cookieSecure = resolveCookieSecure(env);

  // Task 3.1 session storage and task 3.2 pending-authorization state both
  // live in the same SQLite file but in separate tables with separate
  // lifetimes. A broken session database degrades auth safely: the auth
  // endpoints report 401 / a safe error, while health, logging, and
  // frontend serving keep working.
  let session: { storage: SessionStorage; config: SessionConfig } | null = null;
  let stateStore: PendingStateStore | null = null;
  try {
    const config = resolveSessionConfig(env, now);
    session = { storage: openSessionStorage(config), config };
    stateStore = openPendingStateStore(config.dbPath, logger, now);
  } catch (err) {
    const code = err instanceof SessionStorageError ? err.code : 'DB_ERROR';
    logger.warn({ event: 'session_storage_unavailable', code });
  }

  const authResult = resolveAuthConfig(env);
  const authConfig = authResult.status === 'ok' ? authResult.config : null;
  if (authResult.status === 'unconfigured') {
    logger.warn({ event: 'auth_not_configured', reason: authResult.reason });
  }

  // Task 3.5: token refresh service. Both auth configuration and session
  // storage must be available; otherwise authenticated routes fall back to
  // the stored token without refresh capability (existing error mapping).
  const refresh =
    authConfig !== null && session !== null
      ? createTokenRefreshService({
          storage: session.storage,
          authConfig,
          now,
          fetchImpl,
          logger,
        })
      : null;

  const authDeps: AuthRouteDeps = {
    logger,
    now,
    fetchImpl,
    authConfig,
    stateStore,
    session,
    refresh,
    cookieSecure,
  };

  // Task 4.2: the authenticated content client factory for the read-only
  // content endpoint. The default builds the real Octokit client from the
  // access token carried by the authorized-boundary outcome (the exact,
  // possibly refreshed credential of the authorized request — never a
  // fresh session-storage read); tests may inject a factory that records
  // the token it receives. One client per operation context, never shared
  // or cached across requests.
  const contentClientFactory =
    options.contentClientFactory ?? createAuthenticatedContentClient;

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const startedAt = process.hrtime.bigint();
    // URL parsing lives inside the handler's exception boundary: a malformed
    // request target must not become an uncaught synchronous exception.
    let pathname: string;
    let urlParseFailed = false;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      pathname = UNPARSEABLE_PATH;
      urlParseFailed = true;
    }

    // Task 3.7: the request log line carries a deterministic route label
    // instead of the raw pathname. Routing itself still uses the raw
    // pathname (see the dispatch below).
    const logPath = urlParseFailed ? UNPARSEABLE_PATH : labelRequestPath(pathname);

    // Log exactly once per completed response, with the final status.
    res.on('finish', () => {
      const durationMs = Math.max(
        0,
        Math.round(Number(process.hrtime.bigint() - startedAt) / 1_000_000),
      );
      logRequest(logger, {
        method: req.method ?? 'GET',
        path: logPath,
        status: res.statusCode,
        durationMs,
      });
    });

    try {
      if (urlParseFailed) {
        // Malformed request target: safe shared PATH_INVALID envelope (422).
        sendJsonError(res, errorDetail('PATH_INVALID'));
        return;
      }

      // Centralized CSRF security boundary (task 3.3, design A-05): every
      // state-changing /api request must pass session authentication plus
      // the session-bound X-CSRF-Token header before any handler executes.
      // The authorization decision is unconditional: when session storage
      // is unavailable no authenticated session can exist, so the request
      // fails closed with the established 401 before route dispatch —
      // future state-changing handlers can never bypass this boundary.
      const method = req.method ?? 'GET';
      if (
        pathname.startsWith('/api/') &&
        (method === 'POST' || method === 'PUT' || method === 'DELETE')
      ) {
        if (session === null) {
          res.writeHead(401, JSON_HEADERS);
          res.end(JSON.stringify(errorDetail('UNAUTHORIZED')));
          return;
        }
        const csrf = checkCsrf(req, session.storage, logger);
        if (csrf.status !== 'ok') {
          respondToCsrf(res, csrf);
          return;
        }
        if (pathname === '/api/auth/logout' && method === 'POST') {
          handleLogout(res, authDeps, csrf.sessionId);
          return;
        }
        // Task 3.4: state-changing content operations pass the CSRF boundary
        // above, then the repository authorization boundary with write
        // access — authorization never substitutes for CSRF, and CSRF never
        // substitutes for authorization.
        const contentRef = matchContentRepositoryRef(pathname);
        if (contentRef !== null) {
          void enforceContentBoundary(req, res, contentRef, 'write', authDeps, logger).then(
            (outcome) => {
              // Authorized: no state-changing content handler is registered
              // yet (a later task), so the standard 404 is the safe
              // response today. Denied outcomes already have their safe
              // error response written by the boundary.
              if (outcome.authorized) sendApiNotFound(res);
            },
          ).catch((err: unknown) => {
            sendUnexpectedError(res, logger, err);
          });
          return;
        }
        // No handler is registered for this state-changing route. The
        // request already proved authentication and CSRF, so the safe
        // standard 404 is the established response.
        sendApiNotFound(res);
        return;
      }

      // Task 3.4 / 4.2: fail-closed authorization boundary for the
      // content-operation surface (/api/repos/{owner}/{repo}/content). This
      // boundary runs after the CSRF boundary above and never substitutes
      // for it: CSRF proves the request came from the authenticated browser
      // session; authorization proves the session is permitted on the
      // target repository. The boundary outcome carries the exact session
      // state (including any refreshed access token) the authorization
      // decision was made on.
      const contentRef = matchContentRepositoryRef(pathname);
      if (contentRef !== null) {
        // Task 4.2 (post-review correction): GET on exactly
        // /api/repos/{owner}/{repo}/content is the read-only content
        // endpoint (the requested path arrives in the `path` query
        // parameter, relative to the content root). Authorization
        // semantics are restored to the original Task 3.4 rule: every
        // GET and HEAD request on the content surface requires
        // repository read access; POST, PUT, DELETE, and other
        // state-changing operations require write access. Only the exact
        // GET endpoint invokes the content-read handler; GET subpaths
        // beneath /content have no registered handler yet (later tasks)
        // and, after passing read authorization, receive the standard
        // 404 without constructing a content client.
        const isContentRead =
          method === 'GET' &&
          pathname === `/api/repos/${contentRef.owner}/${contentRef.repo}/content`;
        const requiredAccess: 'read' | 'write' =
          method === 'GET' || method === 'HEAD' ? 'read' : 'write';
        void enforceContentBoundary(req, res, contentRef, requiredAccess, authDeps, logger).then(
          (outcome) => {
            if (!outcome.authorized) {
              // The boundary has already written the safe error response.
              return;
            }
            if (isContentRead) {
              void handleContentRead(req, res, contentRef, outcome.session, {
                authDeps,
                logger,
                contentClientFactory,
              }).catch((err: unknown) => {
                sendUnexpectedError(res, logger, err);
              });
              return;
            }
            // Authorized, but no handler is registered for this route: the
            // standard 404 remains the safe response.
            sendApiNotFound(res);
          },
        ).catch((err: unknown) => {
          sendUnexpectedError(res, logger, err);
        });
        return;
      }

      if (pathname === '/api/health' && req.method === 'GET') {
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (pathname === '/api/auth/github/start' && req.method === 'GET') {
        handleAuthStart(req, res, authDeps);
        return;
      }
      if (pathname === '/api/auth/github/callback' && req.method === 'GET') {
        // The callback query string contains the authorization code, so it
        // must never be logged; the request logger records pathname only.
        void handleAuthCallback(req, res, authDeps).catch((err: unknown) => {
          sendUnexpectedError(res, logger, err);
        });
        return;
      }
      if (pathname === '/api/session' && req.method === 'GET') {
        void handleSession(req, res, authDeps).catch((err: unknown) => {
          sendUnexpectedError(res, logger, err);
        });
        return;
      }
      if (pathname === '/api/repositories' && req.method === 'GET') {
        void handleRepositories(req, res, authDeps).catch((err: unknown) => {
          sendUnexpectedError(res, logger, err);
        });
        return;
      }
      if (pathname.startsWith('/api/')) {
        sendApiNotFound(res);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } catch (err) {
      sendUnexpectedError(res, logger, err);
    }
  };

  const server = http.createServer(handler);
  server.on('close', () => {
    stateStore?.close();
    session?.storage.close();
  });
  return server;
}

/**
 * Task 4.2 — handler for `GET /api/repos/{owner}/{repo}/content`.
 *
 * Called only after `enforceContentBoundary` returned an authorized
 * outcome, so `session` is the exact session state (including the
 * refreshed access token when one was needed) the authorization decision
 * was made on. The authenticated content client is built from that token —
 * never from a fresh session-storage read (which may still hold the
 * pre-refresh token) and never from another user's credential — and the
 * Task 4.1 content adapter performs the single upstream Contents API
 * request. A missing or empty `path` query parameter means the content
 * root itself; an invalid path is rejected by the shared validator before
 * any request is sent.
 *
 * Error contract: adapter failures are the shared safe `ErrorDetail`
 * envelope (no Octokit text, tokens, or file content). A definitive GitHub
 * 401 (user credential revoked) invalidates the session through the
 * established session-storage mechanism — the same behavior as repository
 * discovery and the boundary. Ordinary 403 permission denials and 429 rate
 * limits never invalidate the session.
 *
 * File content is returned exactly as stored (raw UTF-8 Markdown); no
 * rendering or sanitization happens here (web preview layer's
 * responsibility).
 */
async function handleContentRead(
  req: IncomingMessage,
  res: ServerResponse,
  ref: ContentRepositoryRef,
  session: StoredSession,
  deps: {
    readonly authDeps: AuthRouteDeps;
    readonly logger: Logger;
    readonly contentClientFactory: (accessToken: string) => ContentClient;
  },
): Promise<void> {
  const { authDeps, logger, contentClientFactory } = deps;

  // The `path` query parameter is relative to the repository's content
  // root. The dispatcher has already parsed the request target safely
  // (unparseable targets answered 422 before dispatch), so the query can
  // be read the same way.
  const query = new URLSearchParams(
    new URL(req.url ?? '/', 'http://localhost').search,
  );
  const rawPath = query.get('path');
  const relativePath = rawPath === null ? '' : rawPath;

  const client = contentClientFactory(session.credentials.accessToken);
  const adapter = createContentAdapter({ client, contentRoot: DEFAULT_CONTENT_ROOT });

  let result: ContentResult;
  try {
    result = await adapter.getContent(ref.owner, ref.repo, relativePath);
  } catch (err) {
    if (err instanceof ContentAdapterError) {
      if (err.detail.code === 'UNAUTHORIZED') {
        // A definitive GitHub 401 proves the stored user credential is
        // invalid or revoked: invalidate the session through the
        // established session-storage mechanism (same as repository
        // discovery and the boundary). 403 and 429 do not invalidate.
        if (authDeps.session !== null) {
          authDeps.session.storage.deleteSession(session.sessionId);
        }
        logger.warn({ event: 'session_invalidated', reason: 'github_401' });
      }
      // The adapter's ErrorDetail is already the shared safe envelope.
      sendJsonError(res, err.detail);
      return;
    }
    sendUnexpectedError(res, logger, err);
    return;
  }

  res.writeHead(200, JSON_HEADERS);
  res.end(JSON.stringify(result));
}

/**
 * Resolve the listen port from the environment.
 *
 * `undefined`/empty `PORT` falls back to the default (3000). Any other value
 * that is not a base-10 integer in 1–65535 (e.g. `3999abc`, `+5`, `1e3`,
 * `0`, `65536`) is invalid and yields `null` — the caller must fail fast
 * (`main` logs `invalid_port` and exits 1) rather than silently substituting
 * the default port.
 */
export function resolvePort(
  env: Record<string, string | undefined> = process.env,
): number | null {
  const raw = env.PORT;
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const trimmed = raw.trim();
  const parsed = Number.parseInt(trimmed, 10);
  const valid =
    trimmed === String(parsed) && parsed >= 1 && parsed <= 65_535;
  return valid ? parsed : null;
}

function resolveHost(
  env: Record<string, string | undefined> = process.env,
): string {
  const host = env.HOST?.trim();
  return host === undefined || host === '' ? DEFAULT_HOST : host;
}

export function main(): void {
  const logger = createLogger(resolveLogLevel());
  const host = resolveHost();
  const port = resolvePort();
  if (port === null) {
    logger.error({ event: 'invalid_port' });
    process.exit(1);
  }
  const server = createApp();

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ event: 'shutdown', signal });
    server.close(() => process.exit(0));
    // Never hang on stuck connections.
    const force = setTimeout(() => process.exit(1), 5_000);
    force.unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.on('error', (err: Error) => {
    logger.error({ event: 'server_error', name: err.name });
    process.exit(1);
  });

  server.listen(port, host, () => {
    logger.info({ event: 'server_listening', host, port });
  });
}

// Run only when executed directly (`node dist-server/server/index.js`,
// `tsx src/server/index.ts`) — not when imported by tests.
const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  main();
}

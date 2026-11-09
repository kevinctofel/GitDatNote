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
 * - Structured request logging: method, pathname, status, duration. Never
 *   logs bodies, query strings, headers, or credentials. Future sensitive or
 *   parameterized routes must log sanitized route templates (e.g.
 *   `/api/articles/{id}`) rather than raw path segments.
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
import { createLogger, logRequest, resolveLogLevel } from './middleware/logging.js';
import type { LogLevel } from './middleware/logging.js';
import { sendApiNotFound, sendJsonError, sendUnexpectedError } from './middleware/errorHandling.js';
import { checkCsrf, respondToCsrf } from './middleware/csrf.js';
import { enforceContentBoundary, matchContentRepositoryRef } from './middleware/repositoryAuth.js';
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

  const authDeps: AuthRouteDeps = {
    logger,
    now,
    fetchImpl,
    authConfig,
    stateStore,
    session,
    cookieSecure,
  };

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

    // Log exactly once per completed response, with the final status.
    res.on('finish', () => {
      const durationMs = Math.max(
        0,
        Math.round(Number(process.hrtime.bigint() - startedAt) / 1_000_000),
      );
      logRequest(logger, {
        method: req.method ?? 'GET',
        path: pathname,
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
            (authorized: boolean) => {
              // Authorized: no content handler is registered yet (a later
              // task), so the standard 404 is the safe response today.
              if (authorized) sendApiNotFound(res);
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

      // Task 3.4: fail-closed authorization boundary for the future
      // content-operation surface (/api/repos/{owner}/{repo}/content). The
      // content handlers do not exist yet (a later task), so today the only
      // reachable outcomes are safe errors — or the standard 404 for an
      // authenticated, authorized request. This boundary runs after the
      // CSRF boundary above and never substitutes for it: CSRF proves the
      // request came from the authenticated browser session; authorization
      // proves the session is permitted on the target repository.
      const contentRef = matchContentRepositoryRef(pathname);
      if (contentRef !== null) {
        const requiredAccess: 'read' | 'write' =
          method === 'GET' || method === 'HEAD' ? 'read' : 'write';
        void enforceContentBoundary(req, res, contentRef, requiredAccess, authDeps, logger).then(
          (authorized: boolean) => {
            // Authorized: no content handler is registered yet (a later
            // task), so the standard 404 is the safe response today.
            if (authorized) sendApiNotFound(res);
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
        handleSession(req, res, authDeps);
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

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
import { errorDetail } from '../shared/errors.js';

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
}

/**
 * Build the HTTP application (route dispatch + logging + error boundary).
 * Exported so tests can bind to an ephemeral port; the process entry point
 * (`main`) performs the actual listen.
 */
export function createApp(options: AppOptions = {}): Server {
  const logger = createLogger(options.logLevel ?? resolveLogLevel());

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
      if (pathname === '/api/health' && req.method === 'GET') {
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ status: 'ok' }));
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

  return http.createServer(handler);
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

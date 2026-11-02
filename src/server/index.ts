/**
 * GitDatNote backend entry point (OpenSpec task 2.4).
 *
 * A standalone Node HTTP server using only built-in modules:
 * - `GET /api/health` -> `200 { "status": "ok" }` (no authentication; confirms
 *   only that the HTTP process is responding — not GitHub or SQLite).
 * - Unknown `/api/*` route -> standard JSON 404 envelope.
 * - Non-`/api` paths -> plain-text 404 (the frontend is served by Vite in dev
 *   and by static hosting in production).
 * - Structured request logging: method, pathname, status, duration. Never
 *   logs bodies, query strings, headers, or credentials.
 * - Standard API error handling via the shared contracts in `src/shared`.
 *
 * Configuration (environment variables):
 * - `PORT`     — listen port (default: 3000, matching the Vite `/api` proxy).
 * - `HOST`     — bind address (default: 127.0.0.1).
 * - `LOG_LEVEL` — debug | info | warn | error (default: info).
 */

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger, logRequest, resolveLogLevel } from './middleware/logging.js';
import type { LogLevel } from './middleware/logging.js';
import { sendApiNotFound, sendUnexpectedError } from './middleware/errorHandling.js';

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '127.0.0.1';
const JSON_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json; charset=utf-8',
};

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
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

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

function resolvePort(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number.parseInt(env.PORT ?? String(DEFAULT_PORT), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535
    ? parsed
    : DEFAULT_PORT;
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

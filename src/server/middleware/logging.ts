/**
 * Structured request logging for the GitDatNote backend (design.md A-05).
 *
 * Security rules (task 2.4, path labeling completed in task 3.7):
 * - Never log GitHub access tokens, session cookies, or authorization headers.
 * - Never log request or response bodies (article content).
 * - Never log full query strings (they may carry sensitive data).
 * - Never log raw request targets or raw path segments derived from them.
 *   Request lines log a minimal, deterministic route label instead: an exact
 *   fixed label for known static routes, a fixed template for the
 *   parameterized repository content route (no owner/repository values), and
 *   a fixed fallback label for unknown routes. This is deliberately not a
 *   general-purpose routing or logging framework. When a request target
 *   cannot be parsed at all, request lines log the fixed marker
 *   `(unparseable)` instead.
 *
 * Request log lines therefore carry only: method, route label, status,
 * duration. The log level is configurable via the `LOG_LEVEL` environment
 * variable (default: `info`).
 */

import { matchContentRepositoryRef } from './repositoryAuth.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Resolve the active log level from the environment (default: `info`). */
export function resolveLogLevel(
  env: Record<string, string | undefined> = process.env,
): LogLevel {
  const raw = (env.LOG_LEVEL ?? '').trim().toLowerCase();
  return raw in LEVELS ? (raw as LogLevel) : 'info';
}

export type LogPayload = string | Record<string, unknown>;

export interface Logger {
  readonly level: LogLevel;
  debug(payload: LogPayload): void;
  info(payload: LogPayload): void;
  warn(payload: LogPayload): void;
  error(payload: LogPayload): void;
}

function emit(level: LogLevel, payload: LogPayload): void {
  const line = JSON.stringify({
    level,
    ts: new Date().toISOString(),
    ...(typeof payload === 'string' ? { msg: payload } : payload),
  });
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

/** Create a logger that only emits entries at or above its level. */
export function createLogger(level: LogLevel): Logger {
  const min = LEVELS[level];
  const gate = (emitLevel: LogLevel): boolean => LEVELS[emitLevel] >= min;
  return {
    level,
    debug: (payload) => {
      if (gate('debug')) emit('debug', payload);
    },
    info: (payload) => {
      if (gate('info')) emit('info', payload);
    },
    warn: (payload) => {
      if (gate('warn')) emit('warn', payload);
    },
    error: (payload) => {
      if (gate('error')) emit('error', payload);
    },
  };
}

export interface RequestLogEntry {
  readonly method: string;
  /**
   * Sanitized route label, never the raw pathname or query string: an exact
   * fixed label for known static routes, a fixed template for the
   * parameterized repository content route, a fixed fallback label for
   * unknown routes, or the fixed `(unparseable)` marker when the request
   * target cannot be parsed at all.
   */
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
}

/** Fixed labels for the known static routes (logging only). */
const STATIC_ROUTE_LABELS: ReadonlySet<string> = new Set([
  '/api/health',
  '/api/auth/github/start',
  '/api/auth/github/callback',
  '/api/session',
  '/api/repositories',
  '/api/auth/logout',
]);

/** Fixed template logged for the parameterized repository content route. */
const CONTENT_ROUTE_TEMPLATE = '/api/repos/{owner}/{repo}/content';

/**
 * Minimal deterministic route label for request log lines (task 3.7).
 *
 * Logging only — the dispatcher must continue to route on the raw pathname;
 * this function never influences routing, responses, or status codes.
 *
 * - Known static route → its exact fixed label.
 * - Parameterized repository content route → fixed template, with the
 *   owner/repository values removed.
 * - Other `/api/...` path → fixed label `/api/*`.
 * - Any other path → fixed label `/*`.
 *
 * Arbitrary user-controlled path segments are never echoed, so values
 * embedded in URL paths cannot reach the log stream.
 */
export function labelRequestPath(pathname: string): string {
  if (STATIC_ROUTE_LABELS.has(pathname)) return pathname;
  if (matchContentRepositoryRef(pathname) !== null) return CONTENT_ROUTE_TEMPLATE;
  return pathname.startsWith('/api/') ? '/api/*' : '/*';
}

/** Log one completed request (emitted at `info` level). */
export function logRequest(logger: Logger, entry: RequestLogEntry): void {
  logger.info({ event: 'request', ...entry });
}

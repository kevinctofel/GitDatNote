/**
 * Structured request logging for the GitDatNote backend (design.md A-05).
 *
 * Security rules (task 2.4):
 * - Never log GitHub access tokens, session cookies, or authorization headers.
 * - Never log request or response bodies (article content).
 * - Never log full query strings (they may carry sensitive data).
 * - Never log raw request targets or raw path segments derived from them:
 *   future sensitive or parameterized routes must log sanitized route
 *   templates (e.g. `/api/articles/{id}`) rather than raw path segments. A
 *   general-purpose routing or logging framework is intentionally not built
 *   yet (out of scope for task 2.4). When a request target cannot be parsed
 *   at all, request lines log the fixed marker `(unparseable)` instead.
 *
 * Request log lines therefore carry only: method, pathname, status, duration.
 * The log level is configurable via the `LOG_LEVEL` environment variable
 * (default: `info`).
 */

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
   * Request pathname only — never the query string. Fixed `(unparseable)`
   * marker when the request target cannot be parsed at all.
   */
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
}

/** Log one completed request (emitted at `info` level). */
export function logRequest(logger: Logger, entry: RequestLogEntry): void {
  logger.info({ event: 'request', ...entry });
}

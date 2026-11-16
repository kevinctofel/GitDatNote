/**
 * Standard API error handling for the GitDatNote backend (design.md A-05/A-06).
 *
 * - Expected application errors are converted to the established
 *   `{ "error": { code, message, retryable, status } }` JSON format using the
 *   shared contracts in `src/shared/errors.ts` (no second error-code set).
 * - Unexpected exceptions never leak stack traces, credentials, filesystem
 *   paths, or internal details to the client: the client receives only the
 *   fixed `INTERNAL_ERROR` message, and the server-side log records just the
 *   error name (raw messages can embed paths or token-bearing URLs).
 */

import type { ServerResponse } from 'node:http';
import type { ErrorDetail } from '../../shared/types.js';
import {
  errorDetail,
  isValidRetryAfterSeconds,
  toErrorResponse,
} from '../../shared/errors.js';
import type { Logger } from './logging.js';

/**
 * Write a JSON API error response built from a shared `ErrorDetail`.
 *
 * Task 4.5: a `RATE_LIMITED` detail carrying a validated whole-second
 * delay is surfaced as a standards-compatible `Retry-After` response
 * header. The value is re-validated here so no raw or untrusted upstream
 * header text can ever be forwarded; responses without a trustworthy
 * delay are unchanged.
 */
export function sendJsonError(res: ServerResponse, detail: ErrorDetail): void {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (
    detail.code === 'RATE_LIMITED' &&
    isValidRetryAfterSeconds(detail.retryAfterSeconds)
  ) {
    headers['Retry-After'] = String(detail.retryAfterSeconds);
  }
  res.writeHead(detail.status, headers);
  res.end(JSON.stringify(toErrorResponse(detail)));
}

/** Standard JSON 404 for an unknown `/api/*` route. */
export function sendApiNotFound(res: ServerResponse): void {
  sendJsonError(
    res,
    errorDetail('FILE_NOT_FOUND', 'The requested API route was not found.'),
  );
}

/**
 * Boundary for unexpected exceptions. Responds with the safe
 * `INTERNAL_ERROR` envelope (500); if the response already started, destroys
 * it instead of emitting a second status line.
 */
export function sendUnexpectedError(
  res: ServerResponse,
  logger: Logger,
  err: unknown,
): void {
  const name = err instanceof Error ? err.name : 'UnknownError';
  logger.error({ event: 'unhandled_error', name });
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJsonError(res, errorDetail('INTERNAL_ERROR'));
}

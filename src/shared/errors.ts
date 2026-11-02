/**
 * Error domain for GitDatNote (design.md A-05/A-06).
 *
 * Pure, platform-independent helpers that map GitHub API failures to the
 * standard API error format. Client-facing messages are fixed and safe:
 * no stack traces, tokens, request contents, or repository details.
 *
 * HTTP server/middleware is intentionally out of scope (later tasks).
 */

import type {
  ErrorDomain,
  ErrorStatus,
  ErrorResponse,
  ErrorDetail,
  ShaConflictErrorDetail,
  ShaConflictErrorResponse,
} from './types.js';

/** Status and retryability of each error code (API contract). */
export const ERROR_CODES: Readonly<
  Record<ErrorDomain, { readonly status: ErrorStatus; readonly retryable: boolean }>
> = {
  UNAUTHORIZED: { status: 401, retryable: false },
  REPO_NOT_ALLOWED: { status: 403, retryable: false },
  CSRF_INVALID: { status: 403, retryable: false },
  PATH_INVALID: { status: 422, retryable: false },
  FILE_NOT_FOUND: { status: 404, retryable: false },
  FILE_EXISTS: { status: 409, retryable: false },
  SHA_CONFLICT: { status: 409, retryable: false },
  CONTENT_TOO_LARGE: { status: 422, retryable: false },
  RATE_LIMITED: { status: 429, retryable: true },
  GITHUB_UNAVAILABLE: { status: 502, retryable: true },
  INTERNAL_ERROR: { status: 500, retryable: false },
};

/** Default client-safe message for each error code. */
export const SAFE_MESSAGES: Readonly<Record<ErrorDomain, string>> = {
  UNAUTHORIZED: 'Your session is no longer valid. Please sign in again.',
  REPO_NOT_ALLOWED: 'You do not have access to this repository.',
  CSRF_INVALID: 'This request was rejected for security reasons. Please try again.',
  PATH_INVALID: 'The requested path is not valid.',
  FILE_NOT_FOUND: 'The requested file was not found.',
  FILE_EXISTS: 'A file already exists at this path.',
  SHA_CONFLICT:
    'The file changed after it was loaded. Please reload it and try again.',
  CONTENT_TOO_LARGE: 'The content exceeds the maximum size of 1 MB.',
  RATE_LIMITED: 'The GitHub API rate limit was reached. Please try again shortly.',
  GITHUB_UNAVAILABLE: 'GitHub is temporarily unavailable. Please try again shortly.',
  INTERNAL_ERROR: 'An unexpected error occurred.',
};

/** Build an `ErrorDetail` for a code with the given (or default) message. */
export function errorDetail(code: ErrorDomain, message?: string): ErrorDetail {
  const meta = ERROR_CODES[code];
  return {
    code,
    message: message ?? SAFE_MESSAGES[code],
    retryable: meta.retryable,
    status: meta.status,
  };
}

/** An `ErrorDetail` for a code with its default safe message. */
export function defaultDetail(code: ErrorDomain): ErrorDetail {
  return errorDetail(code, SAFE_MESSAGES[code]);
}

/**
 * Context the server layer can supply when mapping an upstream GitHub
 * failure. All fields optional; mapping stays conservative without them.
 */
export interface GithubErrorContext {
  /**
   * Set when a 403/429 is a rate-limit response (e.g.
   * `x-ratelimit-remaining: 0` or rate-limit error message). GitHub 403
   * also covers permission failures, so this flag disambiguates.
   */
  rateLimited?: boolean;
  /** `Retry-After` header value in seconds, when present. */
  retryAfterSeconds?: number;
  /**
   * For 422 responses: which validation failure the upstream reported.
   * Without this, 422 is mapped to `PATH_INVALID` (the conservative
   * default for content operations).
   */
  validation?: 'path' | 'size';
}

/**
 * Map a GitHub HTTP status code to a GitDatNote error.
 *
 * Conservative defaults:
 * - 403 without rate-limit context -> REPO_NOT_ALLOWED.
 * - 404 -> FILE_NOT_FOUND. (If the repository itself is missing or not
 *   visible to the user, the server layer should override to
 *   REPO_NOT_ALLOWED; that decision needs repository-existence state this
 *   pure function does not have.)
 * - 422 -> PATH_INVALID unless `validation: 'size'` is supplied.
 * - 5xx -> GITHUB_UNAVAILABLE.
 * - anything else -> INTERNAL_ERROR.
 */
export function mapGithubHttpError(
  status: number,
  context: GithubErrorContext = {},
): ErrorDetail {
  switch (status) {
    case 401:
      return defaultDetail('UNAUTHORIZED');
    case 403:
      return context.rateLimited
        ? rateLimitedDetail(context)
        : defaultDetail('REPO_NOT_ALLOWED');
    case 404:
      return defaultDetail('FILE_NOT_FOUND');
    case 409:
      return defaultDetail('SHA_CONFLICT');
    case 422:
      return context.validation === 'size'
        ? defaultDetail('CONTENT_TOO_LARGE')
        : defaultDetail('PATH_INVALID');
    case 429:
      return rateLimitedDetail(context);
    default:
      if (status >= 500) return defaultDetail('GITHUB_UNAVAILABLE');
      return defaultDetail('INTERNAL_ERROR');
  }
}

/** Map a network-level failure (request never answered) to an error. */
export function mapGithubNetworkError(): ErrorDetail {
  return defaultDetail('GITHUB_UNAVAILABLE');
}

function rateLimitedDetail(context: GithubErrorContext): ErrorDetail {
  const { retryAfterSeconds } = context;
  const message =
    typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
      ? `${SAFE_MESSAGES.RATE_LIMITED} Try again in about ${Math.round(retryAfterSeconds)} seconds.`
      : SAFE_MESSAGES.RATE_LIMITED;
  return errorDetail('RATE_LIMITED', message);
}

/** Wrap an `ErrorDetail` in the standard API error response body. */
export function toErrorResponse(detail: ErrorDetail): ErrorResponse {
  return { error: detail };
}

/**
 * Build a `SHA_CONFLICT` error detail that carries the file's current blob
 * SHA. The `repository-content` specification requires that a stale update
 * be rejected with `409 SHA_CONFLICT` and that the response "include the
 * current SHA in the response".
 */
export function shaConflictDetail(currentSha: string): ShaConflictErrorDetail {
  const meta = ERROR_CODES['SHA_CONFLICT'];
  return {
    code: 'SHA_CONFLICT',
    message: SAFE_MESSAGES['SHA_CONFLICT'],
    retryable: meta.retryable,
    status: meta.status,
    currentSha,
  };
}

/** Wrap a `SHA_CONFLICT` detail in the API response body for that code. */
export function toShaConflictResponse(currentSha: string): ShaConflictErrorResponse {
  return { error: shaConflictDetail(currentSha) };
}

/**
 * Unit tests for `src/shared/errors.ts` (task 2.6).
 *
 * Covers all 11 documented error codes (status + retryability), safe
 * messages, the standard response envelope, GitHub HTTP status mapping
 * (including the ambiguous 403 with/without rate-limit context and the 422
 * validation context), network error mapping, unknown upstream statuses,
 * and the `SHA_CONFLICT` response shape. Mock status codes and local data
 * only — no network requests.
 */
import { describe, expect, it } from 'vitest';

import {
  ERROR_CODES,
  SAFE_MESSAGES,
  defaultDetail,
  errorDetail,
  mapGithubHttpError,
  mapGithubNetworkError,
  shaConflictDetail,
  toErrorResponse,
  toShaConflictResponse,
} from '../../../src/shared/errors.js';
import type { GithubErrorContext } from '../../../src/shared/errors.js';
import type { ErrorDomain } from '../../../src/shared/types.js';

const ALL_CODES: readonly ErrorDomain[] = [
  'UNAUTHORIZED',
  'REPO_NOT_ALLOWED',
  'CSRF_INVALID',
  'PATH_INVALID',
  'FILE_NOT_FOUND',
  'FILE_EXISTS',
  'SHA_CONFLICT',
  'CONTENT_TOO_LARGE',
  'RATE_LIMITED',
  'GITHUB_UNAVAILABLE',
  'INTERNAL_ERROR',
];

/** Expected API contract per code (design.md A-05). */
const EXPECTED_META: Record<ErrorDomain, { status: number; retryable: boolean }> = {
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

const EXPECTED_MESSAGES: Record<ErrorDomain, string> = {
  UNAUTHORIZED: 'Your session is no longer valid. Please sign in again.',
  REPO_NOT_ALLOWED: 'You do not have access to this repository.',
  CSRF_INVALID: 'This request was rejected for security reasons. Please try again.',
  PATH_INVALID: 'The requested path is not valid.',
  FILE_NOT_FOUND: 'The requested file was not found.',
  FILE_EXISTS: 'A file already exists at this path.',
  SHA_CONFLICT: 'The file changed after it was loaded. Please reload it and try again.',
  CONTENT_TOO_LARGE: 'The content exceeds the maximum size of 1 MB.',
  RATE_LIMITED: 'The GitHub API rate limit was reached. Please try again shortly.',
  GITHUB_UNAVAILABLE: 'GitHub is temporarily unavailable. Please try again shortly.',
  INTERNAL_ERROR: 'An unexpected error occurred.',
};

describe('ERROR_CODES — status and retryability for all 11 codes', () => {
  it.each(ALL_CODES.map((code) => [code, EXPECTED_META[code]] as const))(
    '%s maps to status %i and retryable %j',
    (code, meta) => {
      expect(ERROR_CODES[code]).toEqual({ status: meta.status, retryable: meta.retryable });
    },
  );
});

describe('SAFE_MESSAGES — fixed client-safe messages', () => {
  it.each(ALL_CODES.map((code) => [code, EXPECTED_MESSAGES[code]] as const))(
    '%s has the exact documented safe message',
    (code, message) => {
      expect(SAFE_MESSAGES[code]).toBe(message);
    },
  );

  it('no message exposes tokens, URLs, stack traces, or control characters', () => {
    for (const code of ALL_CODES) {
      const message = SAFE_MESSAGES[code];
      expect(message).toMatch(/^[A-Za-z0-9 .,!-]+$/);
      expect(message.toLowerCase()).not.toContain('bearer');
      expect(message.toLowerCase()).not.toContain('token');
      expect(message).not.toContain('github.com');
      expect(message).not.toContain('\n');
      expect(message).not.toContain('\t');
    }
  });
});

describe('errorDetail / defaultDetail', () => {
  it.each(ALL_CODES.map((code) => [code] as const))('defaultDetail(%s) carries code, safe message, status, retryability', (code) => {
    const meta = EXPECTED_META[code];
    expect(defaultDetail(code)).toEqual({
      code,
      message: EXPECTED_MESSAGES[code],
      retryable: meta.retryable,
      status: meta.status,
    });
  });

  it('errorDetail supports a caller-supplied message override', () => {
    expect(errorDetail('RATE_LIMITED', 'Try again in about 42 seconds.')).toEqual({
      code: 'RATE_LIMITED',
      message: 'Try again in about 42 seconds.',
      retryable: true,
      status: 429,
    });
  });

  it('errorDetail falls back to the safe default message when none is given', () => {
    expect(errorDetail('FILE_NOT_FOUND').message).toBe(EXPECTED_MESSAGES.FILE_NOT_FOUND);
  });
});

describe('mapGithubHttpError — status code mapping', () => {
  it.each([
    [401, { code: 'UNAUTHORIZED', status: 401, retryable: false }],
    [403, { code: 'REPO_NOT_ALLOWED', status: 403, retryable: false }],
    [404, { code: 'FILE_NOT_FOUND', status: 404, retryable: false }],
    [409, { code: 'SHA_CONFLICT', status: 409, retryable: false }],
    [422, { code: 'PATH_INVALID', status: 422, retryable: false }],
    [429, { code: 'RATE_LIMITED', status: 429, retryable: true }],
    [500, { code: 'GITHUB_UNAVAILABLE', status: 502, retryable: true }],
    [502, { code: 'GITHUB_UNAVAILABLE', status: 502, retryable: true }],
    [503, { code: 'GITHUB_UNAVAILABLE', status: 502, retryable: true }],
    [400, { code: 'INTERNAL_ERROR', status: 500, retryable: false }],
    [405, { code: 'INTERNAL_ERROR', status: 500, retryable: false }],
    [999, { code: 'GITHUB_UNAVAILABLE', status: 502, retryable: true }],
  ])('maps GitHub HTTP %i to %j', (status, expected) => {
    expect(mapGithubHttpError(status)).toMatchObject(expected);
  });

  it('maps 403 with rate-limit context to RATE_LIMITED', () => {
    const detail = mapGithubHttpError(403, { rateLimited: true });
    expect(detail.code).toBe('RATE_LIMITED');
    expect(detail.status).toBe(429);
    expect(detail.retryable).toBe(true);
  });

  it('maps 403 without rate-limit context to REPO_NOT_ALLOWED', () => {
    const detail = mapGithubHttpError(403);
    expect(detail.code).toBe('REPO_NOT_ALLOWED');
    expect(detail.status).toBe(403);
  });

  const VALIDATION_CASES: [NonNullable<GithubErrorContext['validation']>, ErrorDomain][] = [
    ['size', 'CONTENT_TOO_LARGE'],
    ['path', 'PATH_INVALID'],
  ];
  it.each(VALIDATION_CASES)('maps 422 with validation context %p to %s', (validation, code) => {
    expect(mapGithubHttpError(422, { validation }).code).toBe(code);
  });
});

describe('mapGithubHttpError — rate-limit message hints', () => {
  it.each([
    [30, 'The GitHub API rate limit was reached. Please try again shortly. Try again in about 30 seconds.'],
    [30.4, 'The GitHub API rate limit was reached. Please try again shortly. Try again in about 30 seconds.'],
    [61.6, 'The GitHub API rate limit was reached. Please try again shortly. Try again in about 62 seconds.'],
    [0, 'The GitHub API rate limit was reached. Please try again shortly. Try again in about 0 seconds.'],
  ])('appends a rounded retry hint for retryAfterSeconds %i', (retryAfterSeconds, message) => {
    expect(mapGithubHttpError(429, { retryAfterSeconds }).message).toBe(message);
  });

  it.each([undefined, -5, NaN])('uses the plain message when retryAfterSeconds is %p', (retryAfterSeconds) => {
    expect(mapGithubHttpError(429, { retryAfterSeconds }).message).toBe(EXPECTED_MESSAGES.RATE_LIMITED);
  });
});

describe('mapGithubNetworkError', () => {
  it('maps a request that never answered to GITHUB_UNAVAILABLE (retryable)', () => {
    expect(mapGithubNetworkError()).toEqual({
      code: 'GITHUB_UNAVAILABLE',
      message: EXPECTED_MESSAGES.GITHUB_UNAVAILABLE,
      retryable: true,
      status: 502,
    });
  });
});

describe('toErrorResponse', () => {
  it('wraps a detail in the standard { error } envelope', () => {
    const detail = defaultDetail('FILE_NOT_FOUND');
    expect(toErrorResponse(detail)).toEqual({ error: detail });
    expect(Object.keys(toErrorResponse(detail))).toEqual(['error']);
  });
});

describe('SHA_CONFLICT response shape', () => {
  it('shaConflictDetail carries currentSha plus the standard fields', () => {
    expect(shaConflictDetail('abc123')).toEqual({
      code: 'SHA_CONFLICT',
      message: EXPECTED_MESSAGES.SHA_CONFLICT,
      retryable: false,
      status: 409,
      currentSha: 'abc123',
    });
  });

  it('toShaConflictResponse wraps the conflict detail in the envelope', () => {
    const response = toShaConflictResponse('deadbeef');
    expect(Object.keys(response)).toEqual(['error']);
    expect(response.error.code).toBe('SHA_CONFLICT');
    expect(response.error.status).toBe(409);
    expect(response.error.currentSha).toBe('deadbeef');
  });

  it('never echoes upstream payload content into the conflict message', () => {
    const response = toShaConflictResponse('some-raw-github-sha-value');
    expect(response.error.message).toBe(EXPECTED_MESSAGES.SHA_CONFLICT);
  });
});

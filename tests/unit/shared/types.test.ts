/**
 * Contract tests for `src/shared/types.ts`.
 *
 * The module exports only compile-time contracts (no runtime behavior), so
 * this suite exercises the shapes structurally: each object literal below is
 * type-checked against its exported type by the compiler (the file is part
 * of `tsconfig.server.json`), and the runtime assertions pin down the
 * wire-shape details the API contract depends on (discriminators and
 * envelope fields).
 */
import { describe, expect, it } from 'vitest';

import type {
  DirectoryChild,
  DirectoryListing,
  ErrorDetail,
  ErrorResponse,
  FileContent,
  Repository,
  ShaConflictErrorDetail,
  ShaConflictErrorResponse,
} from '../../../src/shared/types.js';

describe('types — compile-time contract shapes', () => {
  it('Repository carries both permission flags', () => {
    const repo: Repository = {
      owner: 'octo',
      name: 'notes',
      contentRoot: 'Journal',
      canRead: true,
      canWrite: false,
      private: false,
    };
    expect(repo.canRead).toBe(true);
    expect(repo.canWrite).toBe(false);
  });

  it('FileContent is discriminated with type "file"', () => {
    const file: FileContent = {
      type: 'file',
      path: 'a.md',
      content: 'hi',
      sha: 'abc123',
      size: 2,
    };
    expect(file.type).toBe('file');
  });

  it('DirectoryListing is discriminated with type "directory"', () => {
    const child: DirectoryChild = { name: 'a.md', type: 'file', sha: 'abc', size: 2 };
    const dir: DirectoryListing = { type: 'directory', path: '', children: [child] };
    expect(dir.type).toBe('directory');
    expect(dir.path).toBe('');
    expect(dir.children).toHaveLength(1);
  });

  it('ErrorDetail carries code, message, retryable, status', () => {
    const detail: ErrorDetail = {
      code: 'FILE_NOT_FOUND',
      message: 'The requested file was not found.',
      retryable: false,
      status: 404,
    };
    expect(detail).toEqual({
      code: 'FILE_NOT_FOUND',
      message: 'The requested file was not found.',
      retryable: false,
      status: 404,
    });
  });

  it('ErrorResponse wraps the detail under "error"', () => {
    const body: ErrorResponse = {
      error: {
        code: 'PATH_INVALID',
        message: 'The requested path is not valid.',
        retryable: false,
        status: 422,
      },
    };
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error.code).toBe('PATH_INVALID');
  });

  it('ShaConflictErrorDetail adds currentSha to the standard detail', () => {
    const detail: ShaConflictErrorDetail = {
      code: 'SHA_CONFLICT',
      message: 'The file changed after it was loaded. Please reload it and try again.',
      retryable: false,
      status: 409,
      currentSha: 'deadbeef',
    };
    expect(detail.code).toBe('SHA_CONFLICT');
    expect(detail.status).toBe(409);
    expect(detail.currentSha).toBe('deadbeef');
  });

  it('ShaConflictErrorResponse wraps the conflict detail', () => {
    const body: ShaConflictErrorResponse = {
      error: {
        code: 'SHA_CONFLICT',
        message: 'The file changed after it was loaded. Please reload it and try again.',
        retryable: false,
        status: 409,
        currentSha: 'cafef00d',
      },
    };
    expect(body.error.currentSha).toBe('cafef00d');
  });
});

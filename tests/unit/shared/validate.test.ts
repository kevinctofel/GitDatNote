/**
 * Unit tests for `src/shared/validate.ts` (task 2.6).
 *
 * Covers configured content-root validation, user-supplied relative path
 * validation and canonicalization, the empty-path policy per operation kind,
 * and UTF-8 content size limits. Pure assertions only — no filesystem,
 * network, or Node-only APIs.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_MARKDOWN_BYTES,
  utf8ByteLength,
  validateContentPath,
  validateMarkdownContent,
} from '../../../src/shared/validate.js';

function canonicalize(rel: string): string {
  const segments: string[] = [];
  for (const segment of rel.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
}

function expectPathInvalid(result: ReturnType<typeof validateContentPath>): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe('PATH_INVALID');
    expect(result.error.status).toBe(422);
    expect(result.error.retryable).toBe(false);
  }
}

describe('validateContentPath — content-root validation', () => {
  it.each(['', 'Journal', 'src/posts', 'a/b/c'])(
    'accepts valid content root %p',
    (root) => {
      const result = validateContentPath(root, 'a.md', 'file');
      expect(result.ok).toBe(true);
    },
  );

  it.each([
    '/absolute',
    'a\\b',
    'a\nb',
    'a\u0000b',
    'a\u0001b',
    '..',
    '../x',
    'a/../../x',
  ])('rejects invalid content root %p', (root) => {
    expectPathInvalid(validateContentPath(root, 'a.md', 'file'));
  });

  it('allows internally resolvable ".." in the root (approved lexical policy)', () => {
    // "a/.." canonicalizes to the repository root; nothing escaped it.
    expect(validateContentPath('a/..', 'b.md', 'file')).toEqual({
      ok: true,
      relativePath: 'b.md',
      repositoryPath: 'b.md',
    });
  });
});

describe('validateContentPath — user-supplied relative paths (root "Journal")', () => {
  const ROOT = 'Journal';

  it.each([
    ['a.md', 'Journal/a.md'],
    ['sub/b.md', 'Journal/sub/b.md'],
    ['a/../b.md', 'Journal/b.md'],
    ['a/b/../../sub/c.md', 'Journal/sub/c.md'],
    ['a//b.md', 'Journal/a/b.md'],
    ['a/./b.md', 'Journal/a/b.md'],
    ['./a.md', 'Journal/a.md'],
    ['a/b/../c.md', 'Journal/a/c.md'],
  ])('accepts relative path %p and resolves to repository path %p', (rel, repo) => {
    expect(validateContentPath(ROOT, rel, 'file')).toEqual({
      ok: true,
      relativePath: canonicalize(rel),
      repositoryPath: repo,
    });
  });

  it.each([
    '/a.md',
    'a\\b.md',
    'a\u0000b.md',
    'a\u0001b.md',
    '../a.md',
    'a/../../x.md',
    'a/..',
    '.',
    '',
  ])('rejects relative path %p for file operations', (rel) => {
    expectPathInvalid(validateContentPath(ROOT, rel, 'file'));
  });

  it.each([
    ['', 'Journal'],
    ['.', 'Journal'],
    ['a/..', 'Journal'],
    ['a/../', 'Journal'],
  ])('allows relative path %p for directory operations, resolving to %p', (rel, repo) => {
    expect(validateContentPath(ROOT, rel, 'directory')).toEqual({
      ok: true,
      relativePath: '',
      repositoryPath: repo,
    });
  });
});

describe('validateContentPath — empty content root', () => {
  it('resolves file paths to the repository root', () => {
    expect(validateContentPath('', 'a.md', 'file')).toEqual({
      ok: true,
      relativePath: 'a.md',
      repositoryPath: 'a.md',
    });
  });

  it('resolves an empty directory path to the repository root', () => {
    expect(validateContentPath('', '', 'directory')).toEqual({
      ok: true,
      relativePath: '',
      repositoryPath: '',
    });
  });

  it.each(['/x', 'x\\y', '\u0000', '..', '../x'])('rejects relative path %p against an empty root', (rel) => {
    expectPathInvalid(validateContentPath('', rel, 'file'));
  });
});

describe('validateContentPath — normalization invariants', () => {
  it('never emits ".", "..", or leading-slash segments in ok results', () => {
    for (const root of ['', 'Journal', 'a/b']) {
      for (const rel of ['a.md', 'x/y/z.md', 'a/../b.md', './c.md', 'a//b.md']) {
        const result = validateContentPath(root, rel, 'file');
        if (!result.ok) continue;
        for (const path of [result.relativePath, result.repositoryPath]) {
          const segments = path === '' ? [] : path.split('/');
          expect(segments).not.toContain('.');
          expect(segments).not.toContain('..');
          expect(segments).not.toContain('');
          expect(path.startsWith('/')).toBe(false);
        }
      }
    }
  });

  it('keeps repository paths inside the configured content root', () => {
    const root = 'Journal/sub';
    for (const rel of ['a.md', 'x/y.md', 'a/../b.md', './c.md']) {
      const result = validateContentPath(root, rel, 'file');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.repositoryPath.startsWith(`${root}/`)).toBe(true);
      }
    }
  });
});

describe('utf8ByteLength', () => {
  it.each([
    ['', 0],
    ['abc', 3],
    ['héllo', 6],
    ['€uro', 6],
    ['🚀', 4],
  ])('counts UTF-8 bytes for %p as %p', (value, bytes) => {
    expect(utf8ByteLength(value)).toBe(bytes);
  });
});

describe('validateMarkdownContent', () => {
  it('accepts empty content with byte length 0', () => {
    expect(validateMarkdownContent('')).toEqual({ ok: true, byteLength: 0 });
  });

  it.each([
    ['abc', 3],
    ['héllo', 6],
    ['🚀', 4],
  ])('accepts ordinary content %p with correct byte length %p', (value, bytes) => {
    expect(validateMarkdownContent(value)).toEqual({ ok: true, byteLength: bytes });
  });

  it('accepts content exactly at the 1 MiB limit', () => {
    const atLimit = 'a'.repeat(MAX_MARKDOWN_BYTES);
    expect(validateMarkdownContent(atLimit)).toEqual({ ok: true, byteLength: MAX_MARKDOWN_BYTES });
  });

  it('rejects content one byte above the limit', () => {
    const over = 'a'.repeat(MAX_MARKDOWN_BYTES + 1);
    const result = validateMarkdownContent(over);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CONTENT_TOO_LARGE');
      expect(result.error.status).toBe(422);
      expect(result.error.retryable).toBe(false);
    }
  });

  it('accepts multibyte content whose byte length lands exactly on the limit', () => {
    // 1,048,574 ASCII bytes + one 2-byte character = exactly 1 MiB.
    const atLimit = 'a'.repeat(MAX_MARKDOWN_BYTES - 2) + 'é';
    expect(validateMarkdownContent(atLimit)).toEqual({ ok: true, byteLength: MAX_MARKDOWN_BYTES });
  });

  it('rejects multibyte content crossing the limit mid-character', () => {
    // 1,048,575 ASCII bytes + one 2-byte character = 1 MiB + 1 byte.
    const over = 'a'.repeat(MAX_MARKDOWN_BYTES - 1) + 'é';
    const result = validateMarkdownContent(over);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CONTENT_TOO_LARGE');
      expect(result.error.status).toBe(422);
    }
  });
});

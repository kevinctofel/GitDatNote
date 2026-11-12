/**
 * Task 4.1 — GitHub repository content adapter tests.
 *
 * All GitHub behavior is mocked: no real GitHub API requests, no real
 * credentials, no live repositories. Covers the 20 required Task 4.1
 * adapter properties (listed per test group) plus error-mapping, commit
 * metadata, and early Unicode coverage. Task 4.6's dedicated UTF-8
 * round-trip acceptance and Task 4.7's integration matrix are out of
 * scope here.
 */

import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';

import {
  createAuthenticatedContentClient,
  createContentAdapter,
} from '../../../src/server/content/index.js';
import {
  ContentAdapterError,
  type ContentClient,
} from '../../../src/server/content/types.js';
import type {
  ErrorDomain,
  ShaConflictErrorDetail,
} from '../../../src/shared/types.js';
import { DEFAULT_CONTENT_ROOT } from '../../../src/shared/types.js';
import { MAX_MARKDOWN_BYTES } from '../../../src/shared/validate.js';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const OWNER = 'octo-cat';
const REPO = 'notebook';

const SHA_A = '0123456789abcdef0123456789abcdef01234567';
const SHA_B = 'fedcba9876543210fedcba9876543210fedcba98';
const SHA_NEW = '1111111111111111111111111111111111111111';

function base64(content: string): string {
  return Buffer.from(content, 'utf8').toString('base64');
}

/** A synthetic Octokit HTTP error (status + optional headers). */
function httpError(status: number, headers: Record<string, string> = {}) {
  return Object.assign(new Error('upstream error text'), {
    status,
    response: { headers },
  });
}

function fileResponse(content: string, sha: string) {
  return {
    data: {
      type: 'file',
      name: 'post.md',
      sha,
      size: Buffer.byteLength(content, 'utf8'),
      encoding: 'base64',
      content: base64(content),
    },
  };
}

/** A file response carrying a raw (possibly malformed) base64 payload. */
function rawFileResponse(rawBase64: string, size: number) {
  return {
    data: {
      type: 'file',
      name: 'post.md',
      sha: SHA_A,
      size,
      encoding: 'base64',
      content: rawBase64,
    },
  };
}

function dirResponse(entries: Array<Record<string, unknown>>) {
  return { data: entries };
}

interface CallRecord {
  readonly method: 'getContent' | 'createOrUpdateFileContents';
  readonly params: Record<string, unknown>;
}

type MockOutcome = Promise<{ data: unknown }> | { data: unknown };

interface MockScript {
  getContent?: (params: {
    owner: string;
    repo: string;
    path: string;
  }) => MockOutcome;
  createOrUpdateFileContents?: (params: {
    owner: string;
    repo: string;
    path: string;
    message: string;
    content: string;
    sha?: string;
  }) => MockOutcome;
}

function createMock(script: MockScript = {}) {
  const calls: CallRecord[] = [];
  const client: ContentClient = {
    rest: {
      repos: {
        getContent: async (params) => {
          calls.push({ method: 'getContent', params: { ...params } });
          if (script.getContent) {
            return script.getContent(params);
          }
          return { data: [] };
        },
        createOrUpdateFileContents: async (params) => {
          calls.push({ method: 'createOrUpdateFileContents', params: { ...params } });
          if (script.createOrUpdateFileContents) {
            return script.createOrUpdateFileContents(params);
          }
          return { data: { content: { sha: SHA_NEW } } };
        },
      },
    },
  };
  const getContentCalls = () => calls.filter((c) => c.method === 'getContent');
  const writeCalls = () => calls.filter((c) => c.method === 'createOrUpdateFileContents');
  return { client, calls, getContentCalls, writeCalls };
}

function adapter(client: ContentClient, root: string) {
  return createContentAdapter({ client, contentRoot: root });
}

async function expectAdapterError(
  fn: () => Promise<unknown>,
  code: ErrorDomain,
): Promise<ContentAdapterError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ContentAdapterError);
    const detail = (err as ContentAdapterError).detail;
    expect(detail.code).toBe(code);
    // Safe errors never carry credentials or raw upstream text.
    expect(detail.message).not.toMatch(/ghu_|gho_|Authorization|token|upstream error/i);
    return err as ContentAdapterError;
  }
  throw new Error(
    `Expected ContentAdapterError with code ${code}, but no error was thrown`,
  );
}

function shaConflictCurrentSha(err: ContentAdapterError): string {
  expect(err.detail).toMatchObject({ code: 'SHA_CONFLICT' });
  const detail = err.detail as ShaConflictErrorDetail;
  expect(typeof detail.currentSha).toBe('string');
  return detail.currentSha;
}

/* ------------------------------------------------------------------ */
/* listContent                                                         */
/* ------------------------------------------------------------------ */

describe('listContent', () => {
  // (1) Lists the content-root directory.
  it('lists the content-root directory (empty relative path)', async () => {
    const mock = createMock({
      getContent: (params) => {
        expect(params).toEqual({ owner: OWNER, repo: REPO, path: 'Journal' });
        return dirResponse([
          { name: 'post.md', type: 'file', sha: SHA_A, size: 128 },
          { name: '2024', type: 'dir', sha: SHA_B, size: 0 },
        ]);
      },
    });
    const a = adapter(mock.client, 'Journal');
    const listing = await a.listContent(OWNER, REPO, '');
    expect(listing).toEqual({
      type: 'directory',
      path: '',
      children: [
        { name: 'post.md', type: 'file', sha: SHA_A, size: 128 },
        { name: '2024', type: 'dir', sha: SHA_B, size: 0 },
      ],
    });
    expect(mock.getContentCalls()).toHaveLength(1);
  });

  // (2) Lists a nested directory.
  it('lists a nested directory, resolved against the root', async () => {
    const mock = createMock({
      getContent: (params) => {
        expect(params).toEqual({
          owner: OWNER,
          repo: REPO,
          path: 'Journal/2024/December',
        });
        return dirResponse([{ name: 'post.md', type: 'file', sha: SHA_A, size: 32 }]);
      },
    });
    const a = adapter(mock.client, 'Journal');
    const listing = await a.listContent(OWNER, REPO, '2024/December');
    expect(listing.path).toBe('2024/December');
    expect(listing.children).toEqual([
      { name: 'post.md', type: 'file', sha: SHA_A, size: 32 },
    ]);
  });

  // (6) Rejects absolute paths before contacting GitHub.
  it('rejects absolute paths before contacting GitHub', async () => {
    const mock = createMock();
    const a = adapter(mock.client, 'Journal');
    await expectAdapterError(
      () => a.listContent(OWNER, REPO, '/etc/passwd'),
      'PATH_INVALID',
    );
    expect(mock.calls).toHaveLength(0);
  });

  // (7) Rejects traversal outside the root before contacting GitHub.
  it('rejects traversal outside the root before contacting GitHub', async () => {
    const mock = createMock();
    const a = adapter(mock.client, 'Journal');
    await expectAdapterError(
      () => a.listContent(OWNER, REPO, '../../outside'),
      'PATH_INVALID',
    );
    expect(mock.calls).toHaveLength(0);
  });

  // (8) Rejects null bytes (and other control characters) before GitHub.
  it('rejects null bytes and control characters before contacting GitHub', async () => {
    const mock = createMock();
    const a = adapter(mock.client, 'Journal');
    await expectAdapterError(
      () => a.listContent(OWNER, REPO, 'a\u0000b'),
      'PATH_INVALID',
    );
    await expectAdapterError(() => a.listContent(OWNER, REPO, 'a\tb'), 'PATH_INVALID');
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects backslash paths before contacting GitHub', async () => {
    const mock = createMock();
    const a = adapter(mock.client, 'Journal');
    await expectAdapterError(
      () => a.listContent(OWNER, REPO, '2024\\December'),
      'PATH_INVALID',
    );
    expect(mock.calls).toHaveLength(0);
  });

  it('treats a file path as not a directory (FILE_NOT_FOUND)', async () => {
    const mock = createMock({
      getContent: () => fileResponse('secret body', SHA_A),
    });
    const a = adapter(mock.client, 'Journal');
    await expectAdapterError(() => a.listContent(OWNER, REPO, 'post.md'), 'FILE_NOT_FOUND');
  });

  // (20, part) Fails safely on unexpected listing shapes.
  it('fails safely on malformed directory entries (no fabricated data)', async () => {
    const a = adapter(createMock({
      getContent: () => dirResponse([
        { name: 'link', type: 'symlink', sha: SHA_A, size: 1 },
      ]),
    }).client, 'Journal');
    await expectAdapterError(() => a.listContent(OWNER, REPO, ''), 'INTERNAL_ERROR');

    const b = adapter(createMock({
      getContent: () => dirResponse([{ name: 'x.md', type: 'file', sha: SHA_A }]),
    }).client, 'Journal');
    await expectAdapterError(() => b.listContent(OWNER, REPO, ''), 'INTERNAL_ERROR');
  });

  it('maps a 404 on a listing to FILE_NOT_FOUND', async () => {
    const mock = createMock({
      getContent: () => {
        throw httpError(404);
      },
    });
    const a = adapter(mock.client, 'Journal');
    await expectAdapterError(() => a.listContent(OWNER, REPO, 'missing'), 'FILE_NOT_FOUND');
  });

  it('rejects invalid repository references before contacting GitHub', async () => {
    const mock = createMock();
    const a = adapter(mock.client, 'Journal');
    await expectAdapterError(
      () => a.listContent('bad owner', REPO, ''),
      'PATH_INVALID',
    );
    await expectAdapterError(() => a.listContent(OWNER, 'Repo Name!', ''), 'PATH_INVALID');
    expect(mock.calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* readContent                                                         */
/* ------------------------------------------------------------------ */

describe('readContent', () => {
  // (3)(4)(9) Reads a file with content, SHA, and size, using the Journal
  // root, preserving legitimate nested paths.
  it('reads a nested file under the Journal root with content, SHA, and size', async () => {
    const body = '# Title\n\nBody **bold** and [link](https://example.com)';
    const mock = createMock({
      getContent: (params) => {
        expect(params).toEqual({
          owner: OWNER,
          repo: REPO,
          path: 'Journal/2024/December/post.md',
        });
        return fileResponse(body, SHA_A);
      },
    });
    const a = adapter(mock.client, 'Journal');
    const file = await a.readContent(OWNER, REPO, '2024/December/post.md');
    expect(file).toEqual({
      type: 'file',
      path: '2024/December/post.md',
      content: body,
      sha: SHA_A,
      size: Buffer.byteLength(body, 'utf8'),
    });
  });

  // (4) Uses the configured `Journal` root.
  it('uses an explicitly configured Journal root', async () => {
    const mock = createMock({
      getContent: (params) => {
        expect(params.path).toBe('Journal/2024/December/post.md');
        return fileResponse('hi', SHA_A);
      },
    });
    const a = adapter(mock.client, 'Journal');
    expect(a.contentRoot).toBe('Journal');
    const file = await a.readContent(OWNER, REPO, '2024/December/post.md');
    expect(file.content).toBe('hi');
  });

  // (5) Uses the configured `src/posts` root (the shared default).
  it('uses the DEFAULT_CONTENT_ROOT (src/posts)', async () => {
    const mock = createMock({
      getContent: (params) => {
        expect(params.path).toBe('src/posts/drafts/hello.md');
        return fileResponse('hi', SHA_A);
      },
    });
    const a = adapter(mock.client, DEFAULT_CONTENT_ROOT);
    expect(a.contentRoot).toBe('src/posts');
    const file = await a.readContent(OWNER, REPO, 'drafts/hello.md');
    expect(file.content).toBe('hi');
  });

  // (10) Rejects empty paths for file operations.
  it('rejects an empty path before contacting GitHub', async () => {
    const mock = createMock();
    const a = adapter(mock.client, 'Journal');
    await expectAdapterError(() => a.readContent(OWNER, REPO, ''), 'PATH_INVALID');
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects absolute, traversal, and null-byte paths before contacting GitHub', async () => {
    const mock = createMock();
    const a = adapter(mock.client, 'Journal');
    await expectAdapterError(
      () => a.readContent(OWNER, REPO, '/etc/passwd'),
      'PATH_INVALID',
    );
    await expectAdapterError(
      () => a.readContent(OWNER, REPO, '../../outside.md'),
      'PATH_INVALID',
    );
    await expectAdapterError(
      () => a.readContent(OWNER, REPO, 'a\u0000b.md'),
      'PATH_INVALID',
    );
    expect(mock.calls).toHaveLength(0);
  });

  // Unicode coverage (early; Task 4.6 owns the dedicated round-trip work).
  it('round-trips Unicode content (accented, CJK, emoji) exactly', async () => {
    const body = 'Café au lait — 日本語のノート — 🚀✨';
    const mock = createMock({
      getContent: () => fileResponse(body, SHA_A),
    });
    const a = adapter(mock.client, 'Journal');
    const file = await a.readContent(OWNER, REPO, 'post.md');
    expect(file.content).toBe(body);
    expect(file.size).toBe(Buffer.byteLength(body, 'utf8'));
    expect(file.size).toBeGreaterThan(body.length);
  });

  // (20, part) Fails safely on non-file or malformed responses.
  it('fails safely on directory, symlink, and missing-content responses', async () => {
    const a = adapter(createMock({
      getContent: () => dirResponse([]),
    }).client, 'Journal');
    await expectAdapterError(() => a.readContent(OWNER, REPO, 'post.md'), 'INTERNAL_ERROR');

    const b = adapter(createMock({
      getContent: () => ({
        data: { type: 'symlink', sha: SHA_A, size: 1 },
      }),
    }).client, 'Journal');
    await expectAdapterError(() => b.readContent(OWNER, REPO, 'post.md'), 'INTERNAL_ERROR');

    const c = adapter(createMock({
      getContent: () => ({
        data: { type: 'file', sha: SHA_A, size: 1, encoding: 'none' },
      }),
    }).client, 'Journal');
    await expectAdapterError(() => c.readContent(OWNER, REPO, 'post.md'), 'INTERNAL_ERROR');
  });

  // Strict content decoding (review correction): a malformed GitHub payload
  // must fail safely, never silently become altered Markdown.

  it('reads a valid zero-byte file with empty base64 content', async () => {
    const mock = createMock({
      getContent: () => fileResponse('', SHA_A),
    });
    const a = adapter(mock.client, 'Journal');
    const file = await a.readContent(OWNER, REPO, 'post.md');
    expect(file).toMatchObject({
      type: 'file',
      path: 'post.md',
      content: '',
      sha: SHA_A,
      size: 0,
    });
  });

  it('rejects malformed or truncated base64 content', async () => {
    // Truncated: valid alphabet, but length is not a multiple of 4.
    const a = adapter(createMock({
      getContent: () => rawFileResponse('aGVsbG8', 1),
    }).client, 'Journal');
    await expectAdapterError(() => a.readContent(OWNER, REPO, 'post.md'), 'INTERNAL_ERROR');

    // Off-alphabet characters (length is a multiple of 4).
    const b = adapter(createMock({
      getContent: () => rawFileResponse('!!!!not-base64!!!!', 1),
    }).client, 'Journal');
    await expectAdapterError(() => b.readContent(OWNER, REPO, 'post.md'), 'INTERNAL_ERROR');

    // Padding in the middle of the string.
    const c = adapter(createMock({
      getContent: () => rawFileResponse('aG==Vw', 1),
    }).client, 'Journal');
    await expectAdapterError(() => c.readContent(OWNER, REPO, 'post.md'), 'INTERNAL_ERROR');
  });

  it('rejects byte sequences that are not valid UTF-8', async () => {
    // 0xFF 0xFE is not a valid UTF-8 sequence (lenient decoding would turn it
    // into replacement characters and silently alter the content).
    const raw = Buffer.from([0xff, 0xfe]).toString('base64');
    const a = adapter(createMock({
      getContent: () => rawFileResponse(raw, 2),
    }).client, 'Journal');
    const err = await expectAdapterError(
      () => a.readContent(OWNER, REPO, 'post.md'),
      'INTERNAL_ERROR',
    );
    // The safe error never exposes the raw payload.
    expect(err.detail.message).not.toContain(raw);
  });

  it('accepts line-wrapped base64 and rejects other stray whitespace', async () => {
    const body = 'Café — 日本語 — 🚀';
    const flat = base64(body);
    const size = Buffer.byteLength(body, 'utf8');

    const a = adapter(createMock({
      getContent: () => rawFileResponse(`${flat.slice(0, 4)}\r\n${flat.slice(4)}`, size),
    }).client, 'Journal');
    const file = await a.readContent(OWNER, REPO, 'post.md');
    expect(file.content).toBe(body);

    const b = adapter(createMock({
      getContent: () => rawFileResponse(`${flat.slice(0, 4)} ${flat.slice(4)}`, size),
    }).client, 'Journal');
    await expectAdapterError(() => b.readContent(OWNER, REPO, 'post.md'), 'INTERNAL_ERROR');
  });

  // (20, part) Upstream error mapping: 401 stays distinguishable, 429 vs
  // 403 stay distinct, and no raw text leaks.
  it('maps upstream errors without leaking raw responses', async () => {
    const body = 'TOP SECRET CONTENT XYZ';
    const a = adapter(createMock({
      getContent: () => {
        throw Object.assign(new Error(`Not Found: ${body}`), {
          status: 404,
          response: { headers: {} },
        });
      },
    }).client, 'Journal');
    const err = await expectAdapterError(
      () => a.readContent(OWNER, REPO, 'post.md'),
      'FILE_NOT_FOUND',
    );
    expect(err.detail.message).not.toContain('TOP SECRET');
  });

  it('keeps a definitive 401 distinguishable (UNAUTHORIZED)', async () => {
    const a = adapter(createMock({
      getContent: () => {
        throw httpError(401);
      },
    }).client, 'Journal');
    await expectAdapterError(() => a.readContent(OWNER, REPO, 'post.md'), 'UNAUTHORIZED');
  });

  it('distinguishes rate limiting from ordinary 403 denial', async () => {
    const rateLimited = adapter(createMock({
      getContent: () => {
        throw httpError(403, { 'x-ratelimit-remaining': '0' });
      },
    }).client, 'Journal');
    const err = await expectAdapterError(
      () => rateLimited.readContent(OWNER, REPO, 'post.md'),
      'RATE_LIMITED',
    );
    expect(err.detail.retryable).toBe(true);

    const denied = adapter(createMock({
      getContent: () => {
        throw httpError(403);
      },
    }).client, 'Journal');
    await expectAdapterError(
      () => denied.readContent(OWNER, REPO, 'post.md'),
      'REPO_NOT_ALLOWED',
    );
  });

  it('maps 429 with retry-after, 5xx, and network failures', async () => {
    const throttled = adapter(createMock({
      getContent: () => {
        throw httpError(429, { 'retry-after': '120' });
      },
    }).client, 'Journal');
    const err = await expectAdapterError(
      () => throttled.readContent(OWNER, REPO, 'post.md'),
      'RATE_LIMITED',
    );
    expect(err.detail.message).toContain('120');

    const down = adapter(createMock({
      getContent: () => {
        throw httpError(502);
      },
    }).client, 'Journal');
    await expectAdapterError(
      () => down.readContent(OWNER, REPO, 'post.md'),
      'GITHUB_UNAVAILABLE',
    );

    const network = adapter(createMock({
      getContent: () => {
        throw new Error('ECONNRESET');
      },
    }).client, 'Journal');
    await expectAdapterError(
      () => network.readContent(OWNER, REPO, 'post.md'),
      'GITHUB_UNAVAILABLE',
    );
  });
});

/* ------------------------------------------------------------------ */
/* createContent                                                       */
/* ------------------------------------------------------------------ */

describe('createContent', () => {
  // (11)(12)(18) Creates a file through the GitHub Contents API, encodes
  // UTF-8 as base64, and returns the new SHA.
  it('creates a file through the Contents API and returns path + new SHA', async () => {
    const mock = createMock({
      getContent: () => {
        throw httpError(404);
      },
    });
    const a = adapter(mock.client, 'Journal');
    const result = await a.createContent(
      OWNER,
      REPO,
      '2024/December/new.md',
      'Hello **world**',
    );
    expect(result).toEqual({ path: '2024/December/new.md', sha: SHA_NEW });
    const writes = mock.writeCalls();
    expect(writes).toHaveLength(1);
    expect(writes[0].params).toEqual({
      owner: OWNER,
      repo: REPO,
      path: 'Journal/2024/December/new.md',
      message: 'Create 2024/December/new.md',
      content: base64('Hello **world**'),
    });
  });

  // (12) Encodes UTF-8 content as base64 (Unicode case).
  it('encodes Unicode UTF-8 content as base64', async () => {
    const body = 'Héllo 世界 🎉';
    const mock = createMock({
      getContent: () => {
        throw httpError(404);
      },
    });
    const a = adapter(mock.client, 'Journal');
    await a.createContent(OWNER, REPO, 'post.md', body);
    const write = mock.writeCalls()[0].params;
    expect(write.content).toBe(base64(body));
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(body.length);
  });

  // (13) No fabricated committer metadata (and no sha on a create).
  it('sends no fabricated committer metadata and no sha on create', async () => {
    const mock = createMock({
      getContent: () => {
        throw httpError(404);
      },
    });
    const a = adapter(mock.client, 'Journal');
    await a.createContent(OWNER, REPO, 'post.md', 'content');
    const write = mock.writeCalls()[0].params;
    expect('author' in write).toBe(false);
    expect('committer' in write).toBe(false);
    expect('sha' in write).toBe(false);
  });

  // (14) Protects create against overwriting an existing file.
  it('rejects creating over an existing file (no write sent)', async () => {
    const mock = createMock({
      getContent: () => fileResponse('old content', SHA_A),
    });
    const a = adapter(mock.client, 'Journal');
    await expectAdapterError(
      () => a.createContent(OWNER, REPO, 'post.md', 'new content'),
      'FILE_EXISTS',
    );
    expect(mock.writeCalls()).toHaveLength(0);
  });

  it('rejects creating over an existing directory (no write sent)', async () => {
    const mock = createMock({
      getContent: () => dirResponse([]),
    });
    const a = adapter(mock.client, 'Journal');
    await expectAdapterError(
      () => a.createContent(OWNER, REPO, '2024', 'new content'),
      'FILE_EXISTS',
    );
    expect(mock.writeCalls()).toHaveLength(0);
  });

  it('fails FILE_EXISTS on a 409 race and never retries the write', async () => {
    let writes = 0;
    const mock = createMock({
      getContent: () => {
        throw httpError(404);
      },
      createOrUpdateFileContents: () => {
        writes += 1;
        throw httpError(409);
      },
    });
    const a = adapter(mock.client, 'Journal');
    await expectAdapterError(
      () => a.createContent(OWNER, REPO, 'post.md', 'new content'),
      'FILE_EXISTS',
    );
    expect(writes).toBe(1);
  });

  // (19) Rejects oversized content before contacting GitHub.
  it('rejects oversized content before contacting GitHub', async () => {
    const mock = createMock();
    const a = adapter(mock.client, 'Journal');
    await expectAdapterError(
      () => a.createContent(OWNER, REPO, 'big.md', 'x'.repeat(MAX_MARKDOWN_BYTES + 1)),
      'CONTENT_TOO_LARGE',
    );
    expect(mock.calls).toHaveLength(0);
  });

  // (10) Rejects empty paths for file operations.
  it('rejects an empty path before contacting GitHub', async () => {
    const mock = createMock();
    const a = adapter(mock.client, 'Journal');
    await expectAdapterError(
      () => a.createContent(OWNER, REPO, '', 'content'),
      'PATH_INVALID',
    );
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects invalid repository references before contacting GitHub', async () => {
    const mock = createMock();
    const a = adapter(mock.client, 'Journal');
    await expectAdapterError(
      () => a.createContent('bad owner', REPO, 'post.md', 'content'),
      'PATH_INVALID',
    );
    expect(mock.calls).toHaveLength(0);
  });

  it('sanitizes custom commit messages (newlines stripped, max 200 chars)', async () => {
    const mock = createMock({
      getContent: () => {
        throw httpError(404);
      },
    });
    const a = adapter(mock.client, 'Journal');
    await a.createContent(OWNER, REPO, 'post.md', 'content', 'line1\nline2\r\n  padded  ');
    expect(mock.writeCalls()[0].params.message).toBe('line1 line2   padded');

    const mock2 = createMock({
      getContent: () => {
        throw httpError(404);
      },
    });
    const b = adapter(mock2.client, 'Journal');
    await b.createContent(OWNER, REPO, 'post.md', 'content', 'y'.repeat(250));
    expect(mock2.writeCalls()[0].params.message).toBe('y'.repeat(200));
  });

  // (20, part) Fails safely on a malformed write response.
  it('fails safely on a malformed write response', async () => {
    const mock = createMock({
      getContent: () => {
        throw httpError(404);
      },
      createOrUpdateFileContents: () => ({ data: { content: { sha: 'nope' } } }),
    });
    const a = adapter(mock.client, 'Journal');
    await expectAdapterError(
      () => a.createContent(OWNER, REPO, 'post.md', 'content'),
      'INTERNAL_ERROR',
    );
  });

  // A definitive 401 from the write stays distinguishable.
  it('maps a 401 from the write to UNAUTHORIZED', async () => {
    const mock = createMock({
      getContent: () => {
        throw httpError(404);
      },
      createOrUpdateFileContents: () => {
        throw httpError(401);
      },
    });
    const a = adapter(mock.client, 'Journal');
    await expectAdapterError(
      () => a.createContent(OWNER, REPO, 'post.md', 'content'),
      'UNAUTHORIZED',
    );
  });
});

/* ------------------------------------------------------------------ */
/* updateContent                                                       */
/* ------------------------------------------------------------------ */

describe('updateContent', () => {
  // (15)(16)(18) Updates a file with the expected SHA, never omits or
  // substitutes it, and returns the new SHA.
  it('updates a file with the expected SHA and returns the new SHA', async () => {
    const mock = createMock({
      getContent: () => fileResponse('old content', SHA_A),
    });
    const a = adapter(mock.client, 'Journal');
    const result = await a.updateContent(
      OWNER,
      REPO,
      '2024/December/post.md',
      'new content',
      SHA_A,
    );
    expect(result).toEqual({ path: '2024/December/post.md', sha: SHA_NEW });
    const write = mock.writeCalls()[0].params;
    expect(write).toEqual({
      owner: OWNER,
      repo: REPO,
      path: 'Journal/2024/December/post.md',
      message: 'Update 2024/December/post.md',
      content: base64('new content'),
      sha: SHA_A,
    });
    expect('author' in write).toBe(false);
    expect('committer' in write).toBe(false);
  });

  // (16) Never omits or substitutes the expected SHA (case-normalized).
  it('sends the expected SHA exactly (upper-case input normalized)', async () => {
    const mock = createMock({
      getContent: () => fileResponse('old content', SHA_A),
    });
    const a = adapter(mock.client, 'Journal');
    await a.updateContent(OWNER, REPO, 'post.md', 'new content', SHA_A.toUpperCase());
    expect(mock.writeCalls()[0].params.sha).toBe(SHA_A);
  });

  // (17) Rejects SHA mismatches before sending a write, with currentSha.
  it('rejects a SHA mismatch before sending a write (with currentSha)', async () => {
    const mock = createMock({
      getContent: () => fileResponse('newer content', SHA_B),
    });
    const a = adapter(mock.client, 'Journal');
    const err = await expectAdapterError(
      () => a.updateContent(OWNER, REPO, 'post.md', 'mine', SHA_A),
      'SHA_CONFLICT',
    );
    expect(shaConflictCurrentSha(err)).toBe(SHA_B);
    expect(mock.writeCalls()).toHaveLength(0);
  });

  // (17) Rejects invalid or missing expected SHAs before contacting GitHub.
  it('rejects missing or invalid expected SHAs before contacting GitHub', async () => {
    const mock = createMock();
    const a = adapter(mock.client, 'Journal');
    await expectAdapterError(
      () => a.updateContent(OWNER, REPO, 'post.md', 'mine', ''),
      'PATH_INVALID',
    );
    await expectAdapterError(
      () => a.updateContent(OWNER, REPO, 'post.md', 'mine', 'abc123'),
      'PATH_INVALID',
    );
    await expectAdapterError(
      () => a.updateContent(OWNER, REPO, 'post.md', 'mine', 'a'.repeat(39)),
      'PATH_INVALID',
    );
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects updating a missing file (no write sent)', async () => {
    const mock = createMock({
      getContent: () => {
        throw httpError(404);
      },
    });
    const a = adapter(mock.client, 'Journal');
    await expectAdapterError(
      () => a.updateContent(OWNER, REPO, 'post.md', 'mine', SHA_A),
      'FILE_NOT_FOUND',
    );
    expect(mock.writeCalls()).toHaveLength(0);
  });

  it('on a 409 race, refetches once read-only and reports the current SHA', async () => {
    let reads = 0;
    let writes = 0;
    const mock = createMock({
      getContent: () => {
        reads += 1;
        if (reads === 1) {
          return fileResponse('old content', SHA_A);
        }
        return fileResponse('concurrent content', SHA_B);
      },
      createOrUpdateFileContents: () => {
        writes += 1;
        throw httpError(409);
      },
    });
    const a = adapter(mock.client, 'Journal');
    const err = await expectAdapterError(
      () => a.updateContent(OWNER, REPO, 'post.md', 'mine', SHA_A),
      'SHA_CONFLICT',
    );
    expect(shaConflictCurrentSha(err)).toBe(SHA_B);
    expect(reads).toBe(2);
    expect(writes).toBe(1);
  });

  it('on a 409 race whose refetch fails, still reports SHA_CONFLICT (no write retry)', async () => {
    let reads = 0;
    let writes = 0;
    const mock = createMock({
      getContent: () => {
        reads += 1;
        if (reads === 1) {
          return fileResponse('old content', SHA_A);
        }
        throw httpError(500);
      },
      createOrUpdateFileContents: () => {
        writes += 1;
        throw httpError(409);
      },
    });
    const a = adapter(mock.client, 'Journal');
    const err = await expectAdapterError(
      () => a.updateContent(OWNER, REPO, 'post.md', 'mine', SHA_A),
      'SHA_CONFLICT',
    );
    expect('currentSha' in err.detail).toBe(false);
    expect(reads).toBe(2);
    expect(writes).toBe(1);
  });

  // (19) Rejects oversized content before contacting GitHub.
  it('rejects oversized content before contacting GitHub', async () => {
    const mock = createMock();
    const a = adapter(mock.client, 'Journal');
    await expectAdapterError(
      () =>
        a.updateContent(OWNER, REPO, 'big.md', 'x'.repeat(MAX_MARKDOWN_BYTES + 1), SHA_A),
      'CONTENT_TOO_LARGE',
    );
    expect(mock.calls).toHaveLength(0);
  });

  // (10) Rejects empty paths for file operations.
  it('rejects an empty path before contacting GitHub', async () => {
    const mock = createMock();
    const a = adapter(mock.client, 'Journal');
    await expectAdapterError(
      () => a.updateContent(OWNER, REPO, '', 'mine', SHA_A),
      'PATH_INVALID',
    );
    expect(mock.calls).toHaveLength(0);
  });

  // (20, part) Fails safely on a malformed write response.
  it('fails safely on a malformed write response', async () => {
    const mock = createMock({
      getContent: () => fileResponse('old content', SHA_A),
      createOrUpdateFileContents: () => ({ data: {} }),
    });
    const a = adapter(mock.client, 'Journal');
    await expectAdapterError(
      () => a.updateContent(OWNER, REPO, 'post.md', 'new content', SHA_A),
      'INTERNAL_ERROR',
    );
  });
});

/* ------------------------------------------------------------------ */
/* Construction and client                                             */
/* ------------------------------------------------------------------ */

describe('construction and client', () => {
  it('rejects a malformed injected content root at construction', () => {
    const mock = createMock();
    expect(() => createContentAdapter({ client: mock.client, contentRoot: '../outside' }))
      .toThrow(ContentAdapterError);
  });

  it('exposes the server-resolved content root', () => {
    const mock = createMock();
    const a = createContentAdapter({ client: mock.client, contentRoot: 'src/posts' });
    expect(a.contentRoot).toBe('src/posts');
  });

  it('builds an offline authenticated client (no network calls)', () => {
    const client = createAuthenticatedContentClient('ghu_test_token');
    expect(typeof client.rest.repos.getContent).toBe('function');
    expect(typeof client.rest.repos.createOrUpdateFileContents).toBe('function');
  });
});

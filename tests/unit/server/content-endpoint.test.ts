/**
 * Task 4.2 — regression tests for the authenticated content-read endpoint.
 *
 * Exercises `GET /api/repos/{owner}/{repo}/content?path={relativePath}`
 * end-to-end through `createApp` over real HTTP on an ephemeral port:
 *
 * - The Task 3.4 boundary (`enforceContentBoundary`) is reused unchanged:
 *   session gate → Task 3.5 token refresh → a fresh `authorizeRepository`
 *   decision, before the handler runs.
 * - The Task 4.1 content adapter (`getContent`) is driven through the
 *   injectable `AppOptions.contentClientFactory`: every authenticated
 *   content request is served by a mock `ContentClient`, so no real GitHub
 *   credentials, tokens, or repositories are ever used. The factory
 *   records which access token the handler used to build its client,
 *   proving the client is constructed from the authorized-request
 *   credential (possibly refreshed) — and that boundary-denied requests
 *   never construct one.
 *
 * Scenarios covered: content-root and nested directory listings (immediate
 * children only, canonical relative paths), raw UTF-8 Markdown file reads
 * (no server-side rendering or sanitization), path normalization (traversal
 * that stays inside the root, empty/`.`/trailing-slash paths),
 * `PATH_INVALID` rejections before any upstream request, the shared
 * upstream error mapping (404/401/403/429/rate-limited 403/5xx/network),
 * fail-closed handling of malformed upstream data, boundary denials before
 * client construction, refresh integration, and credential hygiene.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../../src/server/index.js';
import type { ContentClient } from '../../../src/server/content/types.js';

/* ------------------------------------------------------------------ */
/* Test-only credential constants (obviously fake)                    */
/* ------------------------------------------------------------------ */

const CLIENT_ID = 'Iv1.ab1112223334445c';
const CLIENT_SECRET = 'test-client-secret-0123456789abcdef0123456789';
const CALLBACK = 'https://example.com/api/auth/github/callback';
const SESSION_KEY =
  '3a7bd3e2360a3d29eea436fcfbefe70c434e20d53060c66e0c2f6a3f4a9c7e58';

const ACCESS_TOKEN = 'ghu_test_access_token_value';
const REFRESH_TOKEN = 'ghr_test_refresh_token_value';
const REFRESHED_ACCESS_TOKEN = 'ghu_test_refreshed_access_token_value';
const REFRESHED_REFRESH_TOKEN = 'ghr_test_refreshed_refresh_token_value';
const AUTH_CODE = 'test-authorization-code-123';

const TOKEN_RESPONSE = {
  access_token: ACCESS_TOKEN,
  refresh_token: REFRESH_TOKEN,
  expires_in: 28800,
  refresh_token_expires_in: 15897600,
  token_type: 'bearer',
  scope: 'repo',
};

const LOGIN = 'octo-tester';

const PROFILE = {
  login: LOGIN,
  name: 'Octo Tester',
  avatar_url: 'https://avatars.example/octo.png',
};

/** An installation on the test user's account with full contents access. */
const INSTALLATION_FULL = {
  id: 111,
  account: { login: LOGIN, id: 9001 },
  permissions: { contents: 'write' },
  suspended_at: null,
};

/** A writable repository under the test user's account. */
const REPO_WRITE = {
  owner: { login: LOGIN },
  name: 'notes',
  private: true,
  permissions: { admin: true, push: true, pull: true },
};

/** A read-only repository under the test user's account. */
const REPO_READ = {
  owner: { login: LOGIN },
  name: 'docs',
  private: false,
  permissions: { admin: false, push: false, pull: true },
};

/** 40-character lowercase hex blob SHAs (valid per the content rules). */
const BLOB_SHA = 'a'.repeat(40);
const DIR_SHA = 'b'.repeat(40);
const OTHER_SHA = 'c'.repeat(40);

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function ghJson(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function installationsEnvelope(installations: unknown[]): {
  total_count: number;
  installations: unknown[];
} {
  return { total_count: installations.length, installations };
}

function repositoriesEnvelope(repositories: unknown[]): {
  total_count: number;
  repositories: unknown[];
} {
  return { total_count: repositories.length, repositories };
}

/**
 * A GitHub-style HTTP error as Octokit would throw it: an integer status
 * plus (optionally) response headers. The content adapter's shared mapping
 * reads exactly these fields.
 */
function httpError(
  status: number,
  headers: Record<string, string> = {},
): Error & { status: number; headers: Record<string, string> } {
  const err = new Error(`GitHub API ${status}`) as Error & {
    status: number;
    headers: Record<string, string>;
  };
  err.status = status;
  err.headers = headers;
  return err;
}

/**
 * A well-formed file payload for the upstream Contents API: base64 UTF-8
 * content, a valid blob SHA, and the exact UTF-8 byte size.
 */
function fileFixture(
  content: string,
  sha: string = BLOB_SHA,
): Record<string, unknown> {
  const bytes = Buffer.from(content, 'utf8');
  return {
    type: 'file',
    sha,
    size: bytes.length,
    encoding: 'base64',
    content: bytes.toString('base64'),
  };
}

/** A well-formed directory-listing entry. */
function dirEntry(
  name: string,
  type: 'file' | 'dir',
  sha: string = BLOB_SHA,
  size: number = 0,
): Record<string, unknown> {
  return { name, type, sha, size };
}

/**
 * Upstream Contents API payloads keyed by the FULL repository path the
 * adapter requests (content root prefixed: `src/posts`,
 * `src/posts/2026/...`).
 */
type UpstreamData = Record<string, unknown>;

interface ContentFixture {
  readonly data?: UpstreamData;
  /** Override: every contents request fails with this status. */
  readonly status?: number;
  /** Headers for the status-override error (rate-limit markers, etc.). */
  readonly headers?: Record<string, string>;
  /** When true, contents requests reject with a network failure. */
  readonly networkFailure?: boolean;
}

interface Harness {
  readonly server: Server;
  readonly base: string;
  readonly fetchImpl: ReturnType<typeof vi.fn>;
  readonly dir: string;
  /** Access tokens handed to the injected content-client factory, in order. */
  readonly factoryTokens: string[];
  /** Full repository paths requested from the mock content client, in order. */
  readonly requestedPaths: string[];
  setContentFixture(fixture: ContentFixture): void;
}

const harnesses: Harness[] = [];
const logSpy = vi.spyOn(console, 'log');
const errSpy = vi.spyOn(console, 'error');

function allLogs(): string[] {
  return [...logSpy.mock.calls, ...errSpy.mock.calls].map((c) =>
    c.map((x) => (typeof x === 'string' ? x : String(x))).join(' '),
  );
}

const BASE_NOW = 1_750_000_000_000;

async function createHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gitdatnote-content-'));
  const env: Record<string, string | undefined> = {
    GITHUB_APP_CLIENT_ID: CLIENT_ID,
    GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET,
    GITHUB_OAUTH_CALLBACK_URL: CALLBACK,
    SESSION_ENCRYPTION_KEY: SESSION_KEY,
    SESSION_DB_PATH: join(dir, 'sessions.db'),
  };
  const now = () => BASE_NOW;
  const fetchImpl = vi.fn();
  const factoryTokens: string[] = [];
  const requestedPaths: string[] = [];
  let fixture: ContentFixture = {};
  const contentClientFactory = (accessToken: string): ContentClient => {
    factoryTokens.push(accessToken);
    return {
      rest: {
        repos: {
          async getContent(params: {
            owner: string;
            repo: string;
            path: string;
          }): Promise<{ data: unknown }> {
            requestedPaths.push(params.path);
            if (fixture.networkFailure) {
              throw new TypeError('fetch failed');
            }
            if (fixture.status !== undefined) {
              throw httpError(fixture.status, fixture.headers ?? {});
            }
            const body = fixture.data?.[params.path];
            if (body === undefined) {
              throw httpError(404);
            }
            return { data: body };
          },
          async createOrUpdateFileContents(): Promise<{ data: unknown }> {
            throw new Error(
              'Task 4.2 is read-only; writes are not expected here',
            );
          },
        },
      },
    };
  };
  const server = createApp({ env, fetchImpl, now, contentClientFactory });
  const port = await listen(server);
  const harness: Harness = {
    server,
    base: `http://127.0.0.1:${port}`,
    fetchImpl,
    dir,
    factoryTokens,
    requestedPaths,
    setContentFixture: (f: ContentFixture): void => {
      fixture = f;
    },
  };
  harnesses.push(harness);
  mockGithub(harness);
  return harness;
}

function listen(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server has no port'));
        return;
      }
      resolve(address.port);
    });
  });
}

interface IntegrationMockOptions {
  readonly installations?: unknown;
  readonly repos?: unknown;
  readonly reposByInstallation?: Record<number, unknown[]>;
  readonly installationsStatus?: number;
  readonly reposStatus?: number;
  readonly networkFailure?: boolean;
  /**
   * Ordered responses for `/login/oauth/access_token`; the last entry
   * repeats for any further calls. Omitted → always `TOKEN_RESPONSE`.
   * This is how the refresh tests model sign-in vs. refreshed credentials.
   */
  readonly tokenResponses?: Record<string, unknown>[];
}

function mockGithub(h: Harness, opts: IntegrationMockOptions = {}): void {
  let tokenCalls = 0;
  h.fetchImpl.mockImplementation(async (input: string): Promise<Response> => {
    if (opts.networkFailure) throw new TypeError('fetch failed');
    const url = new URL(input);
    if (url.pathname === '/login/oauth/access_token') {
      const list = opts.tokenResponses;
      const body =
        list === undefined
          ? TOKEN_RESPONSE
          : list[tokenCalls] ?? list[list.length - 1] ?? TOKEN_RESPONSE;
      tokenCalls += 1;
      return ghJson(200, body);
    }
    if (url.pathname === '/user') {
      return ghJson(200, PROFILE);
    }
    if (url.pathname === '/user/installations') {
      const installations = opts.installations ?? [INSTALLATION_FULL];
      return ghJson(
        opts.installationsStatus ?? 200,
        Array.isArray(installations) ? installationsEnvelope(installations) : installations,
      );
    }
    if (
      url.pathname.startsWith('/user/installations/') &&
      url.pathname.endsWith('/repositories')
    ) {
      const idMatch = url.pathname.match(
        /^\/user\/installations\/(\d+)\/repositories$/,
      );
      const repos =
        (idMatch !== null
          ? opts.reposByInstallation?.[Number(idMatch[1])]
          : undefined) ??
        opts.repos ??
        [REPO_WRITE, REPO_READ];
      return ghJson(
        opts.reposStatus ?? 200,
        Array.isArray(repos) ? repositoriesEnvelope(repos) : repos,
      );
    }
    return ghJson(404, { message: 'Not Found' });
  });
}

function closeHarness(h: Harness): void {
  h.server.close();
  h.server.closeAllConnections();
  rmSync(h.dir, { recursive: true, force: true });
}

afterEach(() => {
  logSpy.mockClear();
  errSpy.mockClear();
});

afterAll(() => {
  for (const h of harnesses) {
    closeHarness(h);
  }
  logSpy.mockRestore();
  errSpy.mockRestore();
});

/**
 * The established three-step sign-in: start → callback with code/state →
 * session cookie. Returns the `gitdatnote_session` cookie value.
 */
async function completeSignin(
  h: Harness,
  opts: IntegrationMockOptions = {},
): Promise<string> {
  mockGithub(h, opts);
  const start = await fetch(h.base + '/api/auth/github/start', {
    redirect: 'manual',
  });
  expect(start.status).toBe(302);
  const location = start.headers.get('location');
  expect(location).toBeTypeOf('string');
  const pendingCookie = start.headers
    .getSetCookie()
    .find((c) => c.startsWith('gitdatnote_pending_auth='));
  expect(pendingCookie).toBeTypeOf('string');
  const startUrl = new URL(location as string);
  const state = startUrl.searchParams.get('state');
  expect(state).toBeTypeOf('string');

  const cb = await fetch(
    h.base +
      '/api/auth/github/callback?code=' +
      AUTH_CODE +
      '&state=' +
      encodeURIComponent(state ?? ''),
    { headers: { cookie: pendingCookie as string }, redirect: 'manual' },
  );
  expect(cb.status).toBe(302);
  const sessionCookie = cb.headers
    .getSetCookie()
    .find((c) => c.startsWith('gitdatnote_session='));
  expect(sessionCookie).toBeTypeOf('string');
  return sessionCookie as string;
}

/** Fetch `/api/session` and return the per-session CSRF token. */
async function csrfTokenFor(h: Harness, sessionCookie: string): Promise<string> {
  const res = await fetch(h.base + '/api/session', {
    headers: { cookie: sessionCookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.csrfToken).toBeTypeOf('string');
  return body.csrfToken as string;
}

async function get(
  h: Harness,
  path: string,
  cookie?: string,
): Promise<{ status: number; body: string; json: unknown; code: string | undefined }> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers.cookie = cookie;
  const res = await fetch(h.base + path, { headers });
  const body = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(body);
  } catch {
    json = null;
  }
  return { status: res.status, body, json, code: codeOf(json) };
}

async function head(
  h: Harness,
  path: string,
  cookie?: string,
): Promise<{ status: number }> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers.cookie = cookie;
  const res = await fetch(h.base + path, { method: 'HEAD', headers });
  await res.text();
  return { status: res.status };
}

async function post(
  h: Harness,
  path: string,
  cookie?: string,
  csrf?: string,
): Promise<{ status: number; body: string; json: unknown; code: string | undefined }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (cookie !== undefined) headers.cookie = cookie;
  if (csrf !== undefined) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(h.base + path, {
    method: 'POST',
    headers,
    body: '{}',
  });
  const body = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(body);
  } catch {
    json = null;
  }
  return { status: res.status, body, json, code: codeOf(json) };
}

/**
 * The `code` field of a standard error response, if present. The
 * established server writes two equivalent envelopes: the flat
 * `ErrorDetail` (401/CSRF paths) and the nested `{ error: detail }`
 * (sendApiNotFound/sendJsonError paths). Both are accepted here.
 */
function codeOf(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const obj = json as Record<string, unknown>;
  if (typeof obj.code === 'string') return obj.code;
  const error = obj.error;
  if (typeof error === 'object' && error !== null) {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** Standard content-endpoint URL for the writable `notes` repository. */
const CONTENT_URL = `/api/repos/${LOGIN}/notes/content`;

/* ------------------------------------------------------------------ */
/* 1) Directory listings                                              */
/* ------------------------------------------------------------------ */

describe('content endpoint — directory listings (integration)', () => {
  it('lists the content root when no path query is given', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    h.setContentFixture({
      data: {
        'src/posts': [
          dirEntry('2026', 'dir', DIR_SHA),
          dirEntry('index.md', 'file', BLOB_SHA, 42),
        ],
      },
    });
    const res = await get(h, CONTENT_URL, cookie);
    expect(res.status).toBe(200);
    const body = res.json as Record<string, unknown>;
    expect(body.type).toBe('directory');
    expect(body.path).toBe('');
    expect(body.children).toEqual([
      { name: '2026', type: 'dir', sha: DIR_SHA, size: 0 },
      { name: 'index.md', type: 'file', sha: BLOB_SHA, size: 42 },
    ]);
    // One upstream Contents API call, with the content-root prefix.
    expect(h.requestedPaths).toEqual(['src/posts']);
    // The client was built from the session's own (unrefreshed) token.
    expect(h.factoryTokens).toEqual([ACCESS_TOKEN]);
  });

  it('lists only the immediate children of a nested directory', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    h.setContentFixture({
      data: {
        'src/posts/2026': [
          dirEntry('note.md', 'file', BLOB_SHA, 120),
          dirEntry('sub', 'dir', DIR_SHA),
        ],
        'src/posts/2026/sub': [dirEntry('deep.md', 'file', OTHER_SHA, 5)],
      },
    });
    const res = await get(
      h,
      `${CONTENT_URL}?path=${encodeURIComponent('2026')}`,
      cookie,
    );
    expect(res.status).toBe(200);
    const body = res.json as Record<string, unknown>;
    expect(body.type).toBe('directory');
    expect(body.path).toBe('2026');
    // Non-recursive: the nested `sub` listing is never requested.
    expect(body.children).toEqual([
      { name: 'note.md', type: 'file', sha: BLOB_SHA, size: 120 },
      { name: 'sub', type: 'dir', sha: DIR_SHA, size: 0 },
    ]);
    expect(h.requestedPaths).toEqual(['src/posts/2026']);
  });

  it('treats an explicitly empty path query as the content root', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    h.setContentFixture({
      data: { 'src/posts': [dirEntry('index.md', 'file', BLOB_SHA, 1)] },
    });
    const res = await get(h, `${CONTENT_URL}?path=`, cookie);
    expect(res.status).toBe(200);
    const body = res.json as Record<string, unknown>;
    expect(body.type).toBe('directory');
    expect(body.path).toBe('');
    expect(h.requestedPaths).toEqual(['src/posts']);
  });

  it('canonicalizes traversal that stays inside the root (no second request)', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    h.setContentFixture({
      data: {
        'src/posts/2026/note.md': fileFixture('# note'),
      },
    });
    const res = await get(
      h,
      `${CONTENT_URL}?path=${encodeURIComponent('2026/../2026/note.md')}`,
      cookie,
    );
    expect(res.status).toBe(200);
    const body = res.json as Record<string, unknown>;
    expect(body.type).toBe('file');
    expect(body.path).toBe('2026/note.md');
    // One request to the canonical repository path.
    expect(h.requestedPaths).toEqual(['src/posts/2026/note.md']);
  });

  it('canonicalizes a trailing slash on a directory path', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    h.setContentFixture({
      data: { 'src/posts/2026': [dirEntry('note.md', 'file', BLOB_SHA, 3)] },
    });
    const res = await get(
      h,
      `${CONTENT_URL}?path=${encodeURIComponent('2026/')}`,
      cookie,
    );
    expect(res.status).toBe(200);
    const body = res.json as Record<string, unknown>;
    expect(body.type).toBe('directory');
    expect(body.path).toBe('2026');
  });

  it('treats "." and fully-collapsing traversal as the content root', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    h.setContentFixture({
      data: { 'src/posts': [dirEntry('index.md', 'file', BLOB_SHA, 1)] },
    });
    for (const raw of ['.', '2026/..']) {
      const res = await get(
        h,
        `${CONTENT_URL}?path=${encodeURIComponent(raw)}`,
        cookie,
      );
      expect(res.status).toBe(200);
      const body = res.json as Record<string, unknown>;
      expect(body.type).toBe('directory');
      expect(body.path).toBe('');
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2) File reads                                                       */
/* ------------------------------------------------------------------ */

describe('content endpoint — file reads (integration)', () => {
  it('returns raw UTF-8 Markdown without rendering or sanitizing', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const markdown =
      '# Café ☕\n\n<script>alert("x")</script>\n\n**bold** and a [link](/n/2026/note)\n';
    h.setContentFixture({
      data: {
        'src/posts/2026/note.md': fileFixture(markdown, BLOB_SHA),
      },
    });
    const res = await get(
      h,
      `${CONTENT_URL}?path=${encodeURIComponent('2026/note.md')}`,
      cookie,
    );
    expect(res.status).toBe(200);
    const body = res.json as Record<string, unknown>;
    expect(body.type).toBe('file');
    expect(body.path).toBe('2026/note.md');
    expect(body.sha).toBe(BLOB_SHA);
    expect(body.size).toBe(Buffer.from(markdown, 'utf8').length);
    // Exact raw bytes: unicode intact, HTML embedded verbatim — no
    // server-side rendering or sanitization.
    expect(body.content).toBe(markdown);
    expect(res.body).toContain('<script>');
  });

  it('returns an empty file as an empty content string', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    h.setContentFixture({
      data: {
        'src/posts/empty.md': fileFixture(''),
      },
    });
    const res = await get(
      h,
      `${CONTENT_URL}?path=${encodeURIComponent('empty.md')}`,
      cookie,
    );
    expect(res.status).toBe(200);
    const body = res.json as Record<string, unknown>;
    expect(body.type).toBe('file');
    expect(body.path).toBe('empty.md');
    expect(body.content).toBe('');
    expect(body.size).toBe(0);
  });

  it('dispatches a nonempty path by the upstream shape (file or directory)', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    h.setContentFixture({
      data: {
        'src/posts/2026': [dirEntry('note.md', 'file', BLOB_SHA, 3)],
      },
    });
    // A directory-shaped response for a path that looks like either.
    const dir = await get(
      h,
      `${CONTENT_URL}?path=${encodeURIComponent('2026')}`,
      cookie,
    );
    expect(dir.status).toBe(200);
    expect((dir.json as Record<string, unknown>).type).toBe('directory');
    // A file-shaped response for the same kind of path.
    h.setContentFixture({
      data: { 'src/posts/2026': fileFixture('hello') },
    });
    const file = await get(
      h,
      `${CONTENT_URL}?path=${encodeURIComponent('2026')}`,
      cookie,
    );
    expect(file.status).toBe(200);
    expect((file.json as Record<string, unknown>).type).toBe('file');
  });
});

/* ------------------------------------------------------------------ */
/* 3) Path validation (shared validator, before any upstream request)  */
/* ------------------------------------------------------------------ */

describe('content endpoint — path validation (integration)', () => {
  it('rejects traversal that escapes the content root with PATH_INVALID', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    h.setContentFixture({
      data: { 'src/posts': [dirEntry('index.md', 'file', BLOB_SHA, 1)] },
    });
    for (const raw of ['../secrets.md', '../../etc/passwd', '2026/../../other/..']) {
      const res = await get(
        h,
        `${CONTENT_URL}?path=${encodeURIComponent(raw)}`,
        cookie,
      );
      expect(res.status).toBe(422);
      expect(res.code).toBe('PATH_INVALID');
    }
    // No Contents API request was ever sent for the rejected paths.
    expect(h.requestedPaths).toEqual([]);
  });

  it('rejects absolute paths with PATH_INVALID', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const res = await get(
      h,
      `${CONTENT_URL}?path=${encodeURIComponent('/etc/passwd')}`,
      cookie,
    );
    expect(res.status).toBe(422);
    expect(res.code).toBe('PATH_INVALID');
    // Also when the slashes arrive percent-encoded.
    const res2 = await get(h, `${CONTENT_URL}?path=%2Fetc%2Fpasswd`, cookie);
    expect(res2.status).toBe(422);
    expect(res2.code).toBe('PATH_INVALID');
    expect(h.requestedPaths).toEqual([]);
  });

  it('rejects backslash paths with PATH_INVALID', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const res = await get(
      h,
      `${CONTENT_URL}?path=${encodeURIComponent('2026\\secret.md')}`,
      cookie,
    );
    expect(res.status).toBe(422);
    expect(res.code).toBe('PATH_INVALID');
    expect(h.requestedPaths).toEqual([]);
  });

  it('answers PATH_INVALID without leaking upstream data or credentials', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const res = await get(
      h,
      `${CONTENT_URL}?path=${encodeURIComponent('../x')}`,
      cookie,
    );
    expect(res.status).toBe(422);
    expect(res.body).not.toContain(ACCESS_TOKEN);
    expect(res.body).not.toContain(REFRESH_TOKEN);
    for (const line of allLogs()) {
      expect(line).not.toContain(ACCESS_TOKEN);
      expect(line).not.toContain(REFRESH_TOKEN);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 4) Upstream error mapping (shared mapping, session semantics)       */
/* ------------------------------------------------------------------ */

describe('content endpoint — upstream error mapping (integration)', () => {
  it('maps a missing path to 404 FILE_NOT_FOUND and keeps the session valid', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const res = await get(
      h,
      `${CONTENT_URL}?path=${encodeURIComponent('nope.md')}`,
      cookie,
    );
    expect(res.status).toBe(404);
    expect(res.code).toBe('FILE_NOT_FOUND');
    // The session was not invalidated: a valid follow-up read succeeds.
    h.setContentFixture({
      data: { 'src/posts': [dirEntry('index.md', 'file', BLOB_SHA, 1)] },
    });
    const followup = await get(h, CONTENT_URL, cookie);
    expect(followup.status).toBe(200);
  });

  it('maps a GitHub 401 to 401 UNAUTHORIZED and invalidates the session', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    h.setContentFixture({ status: 401 });
    const res = await get(h, CONTENT_URL, cookie);
    expect(res.status).toBe(401);
    expect(res.code).toBe('UNAUTHORIZED');
    // The definitive 401 proved the credential invalid: the session is
    // gone, so a follow-up read cannot even reach the content client.
    const followup = await get(h, CONTENT_URL, cookie);
    expect(followup.status).toBe(401);
    expect(followup.code).toBe('UNAUTHORIZED');
  });

  it('maps a GitHub 403 to 403 REPO_NOT_ALLOWED and keeps the session valid', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    h.setContentFixture({ status: 403 });
    const res = await get(h, CONTENT_URL, cookie);
    expect(res.status).toBe(403);
    expect(res.code).toBe('REPO_NOT_ALLOWED');
    h.setContentFixture({
      data: { 'src/posts': [dirEntry('index.md', 'file', BLOB_SHA, 1)] },
    });
    const followup = await get(h, CONTENT_URL, cookie);
    expect(followup.status).toBe(200);
  });

  it('maps a 403 with an exhausted rate-limit window to 429 RATE_LIMITED', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    h.setContentFixture({
      status: 403,
      headers: { 'X-RateLimit-Remaining': '0' },
    });
    const res = await get(h, CONTENT_URL, cookie);
    expect(res.status).toBe(429);
    expect(res.code).toBe('RATE_LIMITED');
    // Rate limiting does not invalidate the session.
    h.setContentFixture({
      data: { 'src/posts': [dirEntry('index.md', 'file', BLOB_SHA, 1)] },
    });
    const followup = await get(h, CONTENT_URL, cookie);
    expect(followup.status).toBe(200);
  });

  it('maps a GitHub 429 to 429 RATE_LIMITED', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    h.setContentFixture({ status: 429, headers: { 'Retry-After': '12' } });
    const res = await get(h, CONTENT_URL, cookie);
    expect(res.status).toBe(429);
    expect(res.code).toBe('RATE_LIMITED');
  });

  it('maps a GitHub 5xx to 502 GITHUB_UNAVAILABLE and keeps the session valid', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    h.setContentFixture({ status: 500 });
    const res = await get(h, CONTENT_URL, cookie);
    expect(res.status).toBe(502);
    expect(res.code).toBe('GITHUB_UNAVAILABLE');
    h.setContentFixture({
      data: { 'src/posts': [dirEntry('index.md', 'file', BLOB_SHA, 1)] },
    });
    const followup = await get(h, CONTENT_URL, cookie);
    expect(followup.status).toBe(200);
  });

  it('maps a network failure to 502 GITHUB_UNAVAILABLE', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    h.setContentFixture({ networkFailure: true });
    const res = await get(h, CONTENT_URL, cookie);
    expect(res.status).toBe(502);
    expect(res.code).toBe('GITHUB_UNAVAILABLE');
  });
});

/* ------------------------------------------------------------------ */
/* 5) Malformed upstream data fails closed                             */
/* ------------------------------------------------------------------ */

describe('content endpoint — malformed upstream data fails closed (integration)', () => {
  it('rejects a file payload with an unknown type (e.g. symlink)', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    h.setContentFixture({
      data: {
        'src/posts/link.md': {
          type: 'symlink',
          sha: BLOB_SHA,
          size: 1,
          encoding: 'base64',
          content: Buffer.from('x', 'utf8').toString('base64'),
        },
      },
    });
    const res = await get(
      h,
      `${CONTENT_URL}?path=${encodeURIComponent('link.md')}`,
      cookie,
    );
    expect(res.status).toBe(500);
    expect(res.code).toBe('INTERNAL_ERROR');
  });

  it('rejects a bare directory object returned for a file-shaped path', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    h.setContentFixture({
      data: {
        'src/posts/2026': { type: 'dir', sha: DIR_SHA, size: 0 },
      },
    });
    const res = await get(
      h,
      `${CONTENT_URL}?path=${encodeURIComponent('2026')}`,
      cookie,
    );
    expect(res.status).toBe(500);
    expect(res.code).toBe('INTERNAL_ERROR');
  });

  it('rejects a file payload with an invalid blob SHA', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    h.setContentFixture({
      data: {
        'src/posts/bad.md': fileFixture('x', 'not-a-sha'),
      },
    });
    const res = await get(
      h,
      `${CONTENT_URL}?path=${encodeURIComponent('bad.md')}`,
      cookie,
    );
    expect(res.status).toBe(500);
    expect(res.code).toBe('INTERNAL_ERROR');
  });

  it('rejects a file payload with unparseable base64 content', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    h.setContentFixture({
      data: {
        'src/posts/bad.md': {
          type: 'file',
          sha: BLOB_SHA,
          size: 1,
          encoding: 'base64',
          content: 'not-valid-base64!!!',
        },
      },
    });
    const res = await get(
      h,
      `${CONTENT_URL}?path=${encodeURIComponent('bad.md')}`,
      cookie,
    );
    expect(res.status).toBe(500);
    expect(res.code).toBe('INTERNAL_ERROR');
  });

  it('rejects a non-object upstream payload', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    h.setContentFixture({
      data: { 'src/posts/strange': 'just a string' },
    });
    const res = await get(
      h,
      `${CONTENT_URL}?path=${encodeURIComponent('strange')}`,
      cookie,
    );
    expect(res.status).toBe(500);
    expect(res.code).toBe('INTERNAL_ERROR');
  });

  it('rejects directory entries with unknown types (e.g. symlinks)', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    h.setContentFixture({
      data: {
        'src/posts': [
          dirEntry('ok.md', 'file', BLOB_SHA, 1),
          // A symlink entry is not a plain file/dir: the adapter must refuse.
          { name: 'link', type: 'symlink', sha: BLOB_SHA, size: 1 },
        ],
      },
    });
    const res = await get(h, CONTENT_URL, cookie);
    expect(res.status).toBe(500);
    expect(res.code).toBe('INTERNAL_ERROR');
  });

  it('never echoes credentials in fail-closed 500 responses', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    h.setContentFixture({
      data: { 'src/posts/strange': 'just a string' },
    });
    const res = await get(
      h,
      `${CONTENT_URL}?path=${encodeURIComponent('strange')}`,
      cookie,
    );
    expect(res.status).toBe(500);
    expect(res.body).not.toContain(ACCESS_TOKEN);
    expect(res.body).not.toContain(REFRESH_TOKEN);
    for (const line of allLogs()) {
      expect(line).not.toContain(ACCESS_TOKEN);
      expect(line).not.toContain(REFRESH_TOKEN);
      expect(line).not.toContain(CLIENT_SECRET);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 6) The authorization boundary is reused, not reimplemented          */
/* ------------------------------------------------------------------ */

describe('content endpoint — authorization boundary (integration)', () => {
  it('rejects unauthenticated reads with 401 and never constructs a content client', async () => {
    const h = await createHarness();
    const res = await get(h, CONTENT_URL);
    expect(res.status).toBe(401);
    expect(res.code).toBe('UNAUTHORIZED');
    expect(h.factoryTokens).toEqual([]);
    expect(h.requestedPaths).toEqual([]);
  });

  it('denies reads for a repository outside the App installation without constructing a content client', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const res = await get(h, `/api/repos/someone-else/notes/content`, cookie);
    expect(res.status).toBe(403);
    expect(res.code).toBe('REPO_NOT_ALLOWED');
    expect(h.factoryTokens).toEqual([]);
    expect(h.requestedPaths).toEqual([]);
  });

  it('denies reads for a repository excluded from the installation selection without constructing a content client', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const res = await get(h, `/api/repos/${LOGIN}/unlisted/content`, cookie);
    expect(res.status).toBe(403);
    expect(res.code).toBe('REPO_NOT_ALLOWED');
    expect(h.factoryTokens).toEqual([]);
    expect(h.requestedPaths).toEqual([]);
  });

  it('lets a read-only user pass read authorization on a GET subpath, then answers the standard 404 without constructing a content client', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    // `docs` is read-only (pull: true, push: false): the restored GET read
    // authorization passes, but no handler is registered beneath /content
    // yet (later tasks), so the standard 404 is the safe response.
    const res = await get(h, `/api/repos/${LOGIN}/docs/content/sub`, cookie);
    expect(res.status).toBe(404);
    expect(res.code).toBe('FILE_NOT_FOUND');
    expect(h.factoryTokens).toEqual([]);
    expect(h.requestedPaths).toEqual([]);
  });

  it('lets a writable user pass read authorization on a GET subpath, then answers the standard 404 without constructing a content client', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const res = await get(h, `/api/repos/${LOGIN}/notes/content/sub`, cookie);
    // Read authorization passes for the writable repo, but no handler is
    // registered beneath /content yet (later tasks): 404.
    expect(res.status).toBe(404);
    expect(res.code).toBe('FILE_NOT_FOUND');
    expect(h.factoryTokens).toEqual([]);
    expect(h.requestedPaths).toEqual([]);
  });

  it('answers HEAD on /content through the read boundary without a handler (standard 404)', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const res = await head(h, CONTENT_URL, cookie);
    expect(res.status).toBe(404);
    expect(h.factoryTokens).toEqual([]);
    expect(h.requestedPaths).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 7) Credentials: which token builds the client, refresh integration  */
/* ------------------------------------------------------------------ */

describe('content endpoint — credentials (integration)', () => {
  it('builds the content client from the session access token (no refresh needed)', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    h.setContentFixture({
      data: { 'src/posts': [dirEntry('index.md', 'file', BLOB_SHA, 1)] },
    });
    const res = await get(h, CONTENT_URL, cookie);
    expect(res.status).toBe(200);
    expect(h.factoryTokens).toEqual([ACCESS_TOKEN]);
  });

  it('uses the refreshed access token when the stored token is near expiry', async () => {
    const h = await createHarness();
    // Sign-in stores a token that expires in 30 seconds — inside the
    // 60-second refresh safety window — so the boundary must refresh
    // before authorizing, and the handler must build its client from the
    // refreshed credential.
    const cookie = await completeSignin(h, {
      tokenResponses: [
        { ...TOKEN_RESPONSE, expires_in: 30 },
        {
          access_token: REFRESHED_ACCESS_TOKEN,
          refresh_token: REFRESHED_REFRESH_TOKEN,
          expires_in: 28800,
          refresh_token_expires_in: 15897600,
          token_type: 'bearer',
          scope: 'repo',
        },
      ],
    });
    h.setContentFixture({
      data: { 'src/posts': [dirEntry('index.md', 'file', BLOB_SHA, 1)] },
    });
    const res = await get(h, CONTENT_URL, cookie);
    expect(res.status).toBe(200);
    expect(h.factoryTokens).toEqual([REFRESHED_ACCESS_TOKEN]);
  });

  it('does not leak credentials in responses or server logs', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    h.setContentFixture({
      data: { 'src/posts': [dirEntry('index.md', 'file', BLOB_SHA, 1)] },
    });
    const denied = await get(h, `/api/repos/${LOGIN}/unlisted/content`, cookie);
    const allowed = await get(h, CONTENT_URL, cookie);
    expect(allowed.status).toBe(200);
    const csrf = await csrfTokenFor(h, cookie);
    const mutation = await post(h, CONTENT_URL, cookie, csrf);
    for (const res of [denied, allowed, mutation]) {
      expect(res.body).not.toContain(ACCESS_TOKEN);
      expect(res.body).not.toContain(REFRESH_TOKEN);
    }
    for (const line of allLogs()) {
      expect(line).not.toContain(ACCESS_TOKEN);
      expect(line).not.toContain(REFRESH_TOKEN);
      expect(line).not.toContain(CLIENT_SECRET);
    }
  });
});

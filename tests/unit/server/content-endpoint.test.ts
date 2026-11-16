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
import { createConnection } from 'node:net';
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
const NEW_SHA = 'd'.repeat(40);

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
  /**
   * Task 4.3: the create-write result. `status` makes the write throw that
   * HTTP status (e.g. a concurrent create's 409); `data` is returned
   * verbatim as the write payload (malformed-shape tests); otherwise a
   * well-formed success payload is returned, carrying `sha` (default
   * `NEW_SHA`).
   */
  readonly create?: {
    readonly sha?: string;
    readonly status?: number;
    readonly data?: unknown;
  };
  /**
   * Task 4.4 review correction: stateful upstream read sequence. When
   * set, each contents read returns the next entry in order (the last
   * entry repeats if more reads arrive); it takes precedence over
   * `data` and `status`. An entry is a `data`-style payload object, or
   * a number making the read throw that HTTP status.
   */
  readonly readSequence?: Array<UpstreamData | number>;
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
  /**
   * Write params handed to the mock client (Task 4.3 create writes and
   * Task 4.4 update writes), in order. `sha` is present only for the
   * Task 4.4 update writes, which are protected by an expected SHA.
   */
  readonly createdCalls: Array<{
    path: string;
    message: string;
    content: string;
    /** The expected SHA an update write was protected with. */
    sha?: string;
  }>;
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
  const createdCalls: Array<{
    path: string;
    message: string;
    content: string;
    sha?: string;
  }> = [];
  let fixture: ContentFixture = {};
  let readsServed = 0;
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
            if (fixture.readSequence !== undefined) {
              const entry = fixture.readSequence[
                Math.min(readsServed, fixture.readSequence.length - 1)
              ];
              readsServed += 1;
              if (typeof entry === 'number') {
                throw httpError(entry);
              }
              return { data: entry };
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
          async createOrUpdateFileContents(params: {
            owner: string;
            repo: string;
            path: string;
            message: string;
            content: string;
            sha?: string;
          }): Promise<{ data: unknown }> {
            createdCalls.push({
              path: params.path,
              message: params.message,
              content: params.content,
              sha: params.sha,
            });
            const create = fixture.create;
            if (create === undefined) {
              throw new Error('no create fixture configured for this write');
            }
            if (create.status !== undefined) {
              throw httpError(create.status);
            }
            return {
              data: create.data ?? { content: { sha: create.sha ?? NEW_SHA } },
            };
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
    createdCalls,
    setContentFixture: (f: ContentFixture): void => {
      fixture = f;
      readsServed = 0;
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
  rawBody: string = '{}',
): Promise<{ status: number; body: string; json: unknown; code: string | undefined }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (cookie !== undefined) headers.cookie = cookie;
  if (csrf !== undefined) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(h.base + path, {
    method: 'POST',
    headers,
    body: rawBody,
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

/** Like `post`, but with the PUT method (Task 4.4 update endpoint). */
async function put(
  h: Harness,
  path: string,
  cookie?: string,
  csrf?: string,
  rawBody: string = '{}',
): Promise<{ status: number; body: string; json: unknown; code: string | undefined }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (cookie !== undefined) headers.cookie = cookie;
  if (csrf !== undefined) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(h.base + path, {
    method: 'PUT',
    headers,
    body: rawBody,
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

/**
 * Task 4.3 regression helper: a raw-socket create upload that never
 * completes. The request declares `declared` body bytes, `partial` of
 * them are sent, and — coordinated through the socket's own write
 * callback, so the server has observed the partial body first (no
 * arbitrary sleep) — the socket is then either destroyed (an aborted
 * upload) or cleanly ended (an incomplete body).
 *
 * The helper resolves on the client-side terminal event for that fate:
 * `'close'` after a local destroy, or `'finish'` once the FIN has been
 * flushed to the OS for a clean half-close. It does not wait for the
 * server to close the connection, because a half-closed upload the
 * server is answering with nothing legitimately leaves the socket
 * open; the incomplete body falls short of the declared
 * `Content-Length`, so the reader can never settle `'ok'` — the
 * no-client-construction / no-upstream-write assertions are valid at
 * any point after this resolves, with no server round trip required.
 *
 * Socket cleanup (removing only its own listeners and destroying the
 * socket) runs on both success and failure; a finite 2 s cap rejects
 * with a descriptive error if the socket never settles, so a
 * server-side regression can never produce a false pass.
 */
async function incompleteUpload(
  h: Harness,
  cookie: string,
  csrf: string,
  declared: number,
  partial: Buffer,
  abort: boolean,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const port = Number(new URL(h.base).port);
    const socket = createConnection(port, '127.0.0.1');
    let done = false;
    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (err !== undefined) reject(err);
      else resolve();
    };
    // A hung socket must fail the test, never silently pass.
    const timer = setTimeout(
      () => {
        finish(
          new Error(
            'incompleteUpload timed out after 2000 ms: the upload socket never settled',
          ),
        );
      },
      2000,
    );
    socket.once('error', (err: NodeJS.ErrnoException) => {
      // The server dropping an aborted upload is expected client-side
      // behavior; anything else is a real failure.
      finish(err.code === 'ECONNRESET' || err.code === 'EPIPE' ? undefined : err);
    });
    if (abort) {
      socket.once('close', () => {
        finish();
      });
    } else {
      // 'finish' fires once the FIN has been flushed to the OS — the
      // deterministic terminal event for a clean half-close.
      socket.once('finish', () => {
        finish();
      });
    }
    socket.write(
      `POST /api/repos/${LOGIN}/notes/content HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: application/json\r\n' +
        `Content-Length: ${declared}\r\n` +
        `Cookie: ${cookie}\r\n` +
        `X-CSRF-Token: ${csrf}\r\n` +
        '\r\n',
    );
    // Deterministic handoff: the write callback fires once `partial`
    // (and everything written before it, in order) has been flushed to
    // the OS, so the server has observed the partial body before the
    // socket's fate is decided.
    socket.write(partial, () => {
      if (done) return;
      if (abort) socket.destroy();
      else socket.end();
    });
  });
}

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
/* 6) Malformed upstream data fails closed                             */
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
/* 5) File creation (Task 4.3)                                         */
/* ------------------------------------------------------------------ */

describe('content endpoint — file creation (integration)', () => {
  const createBody = (payload: Record<string, unknown>): string =>
    JSON.stringify(payload);

  it('creates a new file: 201 with the relative path and the new blob SHA', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const csrf = await csrfTokenFor(h, cookie);
    h.setContentFixture({ data: {}, create: {} });
    const res = await post(
      h,
      CONTENT_URL,
      cookie,
      csrf,
      createBody({ path: '2026/hello-world.md', content: '# Hello world' }),
    );
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ path: '2026/hello-world.md', sha: NEW_SHA });
    // One client, built from the session token, for one pre-check + write.
    expect(h.factoryTokens).toEqual([ACCESS_TOKEN]);
    expect(h.requestedPaths).toEqual(['src/posts/2026/hello-world.md']);
    expect(h.createdCalls).toEqual([
      {
        path: 'src/posts/2026/hello-world.md',
        // Default commit message: `Create {path}`.
        message: 'Create 2026/hello-world.md',
        content: Buffer.from('# Hello world', 'utf8').toString('base64'),
      },
    ]);
    await closeHarness(h);
  });

  it('uses an explicit commit message, normalized (CRLF runs to space, trimmed)', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const csrf = await csrfTokenFor(h, cookie);
    h.setContentFixture({ data: {}, create: {} });
    const res = await post(
      h,
      CONTENT_URL,
      cookie,
      csrf,
      createBody({
        path: 'note.md',
        content: 'body',
        message: '  Add a note\r\nnext line  ',
      }),
    );
    expect(res.status).toBe(201);
    expect(h.createdCalls[0].message).toBe('Add a note next line');
    await closeHarness(h);
  });

  it('refuses to overwrite an existing file with 409 FILE_EXISTS (no write sent)', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const csrf = await csrfTokenFor(h, cookie);
    h.setContentFixture({
      data: { 'src/posts/note.md': fileFixture('# existing') },
    });
    const res = await post(
      h,
      CONTENT_URL,
      cookie,
      csrf,
      createBody({ path: 'note.md', content: '# new' }),
    );
    expect(res.status).toBe(409);
    expect(res.code).toBe('FILE_EXISTS');
    expect(h.createdCalls).toEqual([]);
    await closeHarness(h);
  });

  it('refuses to create where a directory exists with 409 FILE_EXISTS (no write sent)', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const csrf = await csrfTokenFor(h, cookie);
    h.setContentFixture({
      data: { 'src/posts/2026': [dirEntry('a.md', 'file', BLOB_SHA, 1)] },
    });
    const res = await post(
      h,
      CONTENT_URL,
      cookie,
      csrf,
      createBody({ path: '2026', content: 'x' }),
    );
    expect(res.status).toBe(409);
    expect(res.code).toBe('FILE_EXISTS');
    expect(h.createdCalls).toEqual([]);
    await closeHarness(h);
  });

  it('maps a concurrent-create 409 from the write to 409 FILE_EXISTS', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const csrf = await csrfTokenFor(h, cookie);
    h.setContentFixture({ data: {}, create: { status: 409 } });
    const res = await post(
      h,
      CONTENT_URL,
      cookie,
      csrf,
      createBody({ path: 'note.md', content: 'x' }),
    );
    expect(res.status).toBe(409);
    expect(res.code).toBe('FILE_EXISTS');
    // The write was attempted (the pre-check saw no existing entry).
    expect(h.createdCalls.length).toBe(1);
    await closeHarness(h);
  });

  it('rejects invalid paths with 422 PATH_INVALID before any upstream request', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const csrf = await csrfTokenFor(h, cookie);
    h.setContentFixture({ data: {}, create: {} });
    for (const bad of ['../escape.md', '/absolute.md', '2026\\secret.md', '']) {
      const res = await post(
        h,
        CONTENT_URL,
        cookie,
        csrf,
        createBody({ path: bad, content: 'x' }),
      );
      expect(res.status).toBe(422);
      expect(res.code).toBe('PATH_INVALID');
    }
    expect(h.requestedPaths).toEqual([]);
    expect(h.createdCalls).toEqual([]);
    await closeHarness(h);
  });

  it('rejects content over 1 MB with 422 CONTENT_TOO_LARGE, but accepts exactly 1 MB', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const csrf = await csrfTokenFor(h, cookie);
    h.setContentFixture({ data: {}, create: {} });
    const tooLarge = 'x'.repeat(1024 * 1024 + 1);
    const res = await post(
      h,
      CONTENT_URL,
      cookie,
      csrf,
      createBody({ path: 'big.md', content: tooLarge }),
    );
    expect(res.status).toBe(422);
    expect(res.code).toBe('CONTENT_TOO_LARGE');
    const exact = 'x'.repeat(1024 * 1024);
    const ok = await post(
      h,
      CONTENT_URL,
      cookie,
      csrf,
      createBody({ path: 'max.md', content: exact }),
    );
    expect(ok.status).toBe(201);
    await closeHarness(h);
  });

  it('rejects malformed bodies with 422 PATH_INVALID and never constructs a content client', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const csrf = await csrfTokenFor(h, cookie);
    for (const raw of [
      'not json',
      '["array"]',
      'null',
      '{"path": 7, "content": "x"}',
      '{"content": "x"}',
      '{}',
    ]) {
      const res = await post(h, CONTENT_URL, cookie, csrf, raw);
      expect(res.status).toBe(422);
      expect(res.code).toBe('PATH_INVALID');
    }
    expect(h.factoryTokens).toEqual([]);
    await closeHarness(h);
  });

  it('rejects present non-string message values (null, number, boolean, array, object) with 422 PATH_INVALID and never constructs a content client', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const csrf = await csrfTokenFor(h, cookie);
    for (const message of [null, 7, true, ['add'], { note: 'add' }]) {
      const res = await post(
        h,
        CONTENT_URL,
        cookie,
        csrf,
        createBody({ path: 'n.md', content: 'x', message }),
      );
      expect(res.status).toBe(422);
      expect(res.code).toBe('PATH_INVALID');
    }
    expect(h.factoryTokens).toEqual([]);
    expect(h.createdCalls).toEqual([]);
    // An omitted message is still accepted.
    h.setContentFixture({ data: {}, create: {} });
    const ok = await post(
      h,
      CONTENT_URL,
      cookie,
      csrf,
      createBody({ path: 'n.md', content: 'x' }),
    );
    expect(ok.status).toBe(201);
    expect(h.factoryTokens.length).toBe(1);
    await closeHarness(h);
  });

  it('settles an aborted upload (client destroys the socket mid-body) without creating content or crashing the server', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const csrf = await csrfTokenFor(h, cookie);
    const partial = Buffer.from('{"path": "n.md", "content": "tr');
    await incompleteUpload(h, cookie, csrf, 4096, partial, true);
    // The incomplete body never reaches the adapter: no client was
    // constructed and no upstream write was attempted.
    expect(h.factoryTokens).toEqual([]);
    expect(h.createdCalls).toEqual([]);
    // The server is still alive: a follow-up create succeeds.
    h.setContentFixture({ data: {}, create: {} });
    const ok = await post(
      h,
      CONTENT_URL,
      cookie,
      csrf,
      createBody({ path: 'n.md', content: 'x' }),
    );
    expect(ok.status).toBe(201);
    await closeHarness(h);
  });

  it('never parses a body cleanly closed with fewer bytes than its declared Content-Length', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const csrf = await csrfTokenFor(h, cookie);
    const partial = Buffer.from('{"path": "n.md", "content": "tr');
    await incompleteUpload(h, cookie, csrf, 4096, partial, false);
    // Partial JSON is never parsed into content, and no client is built.
    expect(h.factoryTokens).toEqual([]);
    expect(h.createdCalls).toEqual([]);
    // The server stayed up and answers a complete create normally.
    h.setContentFixture({ data: {}, create: {} });
    const ok = await post(
      h,
      CONTENT_URL,
      cookie,
      csrf,
      createBody({ path: 'n.md', content: 'x' }),
    );
    expect(ok.status).toBe(201);
    await closeHarness(h);
  });

  it('rejects a body over the size cap with 422 CONTENT_TOO_LARGE and never constructs a content client', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const csrf = await csrfTokenFor(h, cookie);
    const raw =
      '{"path": "big.md", "content": "' + 'x'.repeat(3 * 1024 * 1024) + '"}';
    const res = await post(h, CONTENT_URL, cookie, csrf, raw);
    expect(res.status).toBe(422);
    expect(res.code).toBe('CONTENT_TOO_LARGE');
    expect(h.factoryTokens).toEqual([]);
    expect(h.createdCalls).toEqual([]);
    await closeHarness(h);
  });

  it('maps upstream errors from the pre-check and invalidates the session only on 401', async () => {
    const cases: Array<{
      fixture: ContentFixture;
      status: number;
      code: string;
    }> = [
      { fixture: { data: {}, status: 403 }, status: 403, code: 'REPO_NOT_ALLOWED' },
      {
        fixture: { data: {}, status: 429, headers: { 'Retry-After': '5' } },
        status: 429,
        code: 'RATE_LIMITED',
      },
      { fixture: { data: {}, status: 502 }, status: 502, code: 'GITHUB_UNAVAILABLE' },
      {
        fixture: { data: {}, networkFailure: true },
        status: 502,
        code: 'GITHUB_UNAVAILABLE',
      },
    ];
    for (const c of cases) {
      const h = await createHarness();
      const cookie = await completeSignin(h);
      const csrf = await csrfTokenFor(h, cookie);
      h.setContentFixture(c.fixture);
      const res = await post(
        h,
        CONTENT_URL,
        cookie,
        csrf,
        createBody({ path: 'n.md', content: 'x' }),
      );
      expect(res.status).toBe(c.status);
      expect(res.code).toBe(c.code);
      // 403/429/5xx/network never invalidate: a follow-up create succeeds.
      h.setContentFixture({ data: {}, create: {} });
      const followup = await post(
        h,
        CONTENT_URL,
        cookie,
        csrf,
        createBody({ path: 'n.md', content: 'x' }),
      );
      expect(followup.status).toBe(201);
      await closeHarness(h);
    }
  });

  it('maps a definitive GitHub 401 to UNAUTHORIZED and invalidates the session', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const csrf = await csrfTokenFor(h, cookie);
    h.setContentFixture({ data: {}, status: 401 });
    const res = await post(
      h,
      CONTENT_URL,
      cookie,
      csrf,
      createBody({ path: 'n.md', content: 'x' }),
    );
    expect(res.status).toBe(401);
    expect(res.code).toBe('UNAUTHORIZED');
    // Session invalidated: a follow-up create is unauthenticated.
    const followup = await post(
      h,
      CONTENT_URL,
      cookie,
      csrf,
      createBody({ path: 'n.md', content: 'x' }),
    );
    expect(followup.status).toBe(401);
    expect(followup.code).toBe('UNAUTHORIZED');
    expect(h.createdCalls).toEqual([]);
    await closeHarness(h);
  });

  it('fails closed on a malformed write payload with 500 INTERNAL_ERROR', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const csrf = await csrfTokenFor(h, cookie);
    for (const data of [{}, { content: {} }, { content: { sha: 'not-a-sha' } }]) {
      h.setContentFixture({ data: {}, create: { data } });
      const res = await post(
        h,
        CONTENT_URL,
        cookie,
        csrf,
        createBody({ path: 'n.md', content: 'x' }),
      );
      expect(res.status).toBe(500);
      expect(res.code).toBe('INTERNAL_ERROR');
    }
    // Each attempt reached the write (and only the write).
    expect(h.createdCalls.length).toBe(3);
    await closeHarness(h);
  });

  it('denies create on boundary failure without constructing a content client', async () => {
    // Unauthenticated.
    let h = await createHarness();
    let res = await post(
      h,
      CONTENT_URL,
      undefined,
      undefined,
      createBody({ path: 'n.md', content: 'x' }),
    );
    expect(res.status).toBe(401);
    expect(res.code).toBe('UNAUTHORIZED');
    expect(h.factoryTokens).toEqual([]);
    await closeHarness(h);

    // Authenticated but no CSRF token.
    h = await createHarness();
    const cookie = await completeSignin(h);
    res = await post(
      h,
      CONTENT_URL,
      cookie,
      undefined,
      createBody({ path: 'n.md', content: 'x' }),
    );
    expect(res.status).toBe(403);
    expect(res.code).toBe('CSRF_INVALID');
    expect(h.factoryTokens).toEqual([]);
    await closeHarness(h);

    // Write CSRF-validated but a read-only repository.
    h = await createHarness();
    const cookie2 = await completeSignin(h);
    const csrf = await csrfTokenFor(h, cookie2);
    res = await post(
      h,
      `/api/repos/${LOGIN}/docs/content`,
      cookie2,
      csrf,
      createBody({ path: 'n.md', content: 'x' }),
    );
    expect(res.status).toBe(403);
    expect(res.code).toBe('REPO_NOT_ALLOWED');
    expect(h.factoryTokens).toEqual([]);
    expect(h.createdCalls).toEqual([]);
    await closeHarness(h);
  });

  it('builds the client from the refreshed access token when the stored token is near expiry', async () => {
    const h = await createHarness();
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
    h.setContentFixture({ data: {}, create: {} });
    const csrf = await csrfTokenFor(h, cookie);
    const res = await post(
      h,
      CONTENT_URL,
      cookie,
      csrf,
      createBody({ path: 'n.md', content: 'x' }),
    );
    expect(res.status).toBe(201);
    expect(h.factoryTokens).toEqual([REFRESHED_ACCESS_TOKEN]);
    await closeHarness(h);
  });
});

/* ------------------------------------------------------------------ */
/* 7) The authorization boundary is reused, not reimplemented          */
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
/* 8) Credentials: which token builds the client, refresh integration  */
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
      create: { sha: NEW_SHA },
    });
    const denied = await get(h, `/api/repos/${LOGIN}/unlisted/content`, cookie);
    const allowed = await get(h, CONTENT_URL, cookie);
    expect(allowed.status).toBe(200);
    const csrf = await csrfTokenFor(h, cookie);
    const mutation = await post(
      h,
      CONTENT_URL,
      cookie,
      csrf,
      JSON.stringify({ path: 'leak-article.md', content: '# Leak check' }),
    );
    expect(mutation.status).toBe(201);
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

/* 9) File update (Task 4.4) — SHA-protected PUT */
describe('content endpoint — file update (integration)', () => {
  it('updates an existing file: 200 with the relative path and the new blob SHA', async () => {
    const h = await createHarness();
    try {
      const cookie = await completeSignin(h);
      const csrf = await csrfTokenFor(h, cookie);
      h.setContentFixture({
        data: { 'src/posts/note.md': fileFixture('# old', BLOB_SHA) },
        create: { sha: NEW_SHA },
      });
      const res = await put(
        h,
        CONTENT_URL,
        cookie,
        csrf,
        JSON.stringify({
          path: 'note.md',
          content: '# new',
          expectedSha: BLOB_SHA,
        }),
      );
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ path: 'note.md', sha: NEW_SHA });
      expect(h.factoryTokens).toEqual([ACCESS_TOKEN]);
      expect(h.requestedPaths).toEqual(['src/posts/note.md']);
      expect(h.createdCalls).toEqual([
        {
          path: 'src/posts/note.md',
          message: 'Update note.md',
          content: Buffer.from('# new').toString('base64'),
          sha: BLOB_SHA,
        },
      ]);
      await closeHarness(h);
    } finally {
      await closeHarness(h);
    }
  });

  it('uses the normalized explicit commit message when one is provided', async () => {
    const h = await createHarness();
    try {
      const cookie = await completeSignin(h);
      const csrf = await csrfTokenFor(h, cookie);
      h.setContentFixture({
        data: { 'src/posts/note.md': fileFixture('# old', BLOB_SHA) },
        create: { sha: NEW_SHA },
      });
      const res = await put(
        h,
        CONTENT_URL,
        cookie,
        csrf,
        JSON.stringify({
          path: 'note.md',
          content: '# new',
          expectedSha: BLOB_SHA,
          message: '  Fix typo\r\nsecond  ',
        }),
      );
      expect(res.status).toBe(200);
      expect(h.createdCalls[0]?.message).toBe('Fix typo second');
      await closeHarness(h);
    } finally {
      await closeHarness(h);
    }
  });

  it('rejects a stale expectedSha with 409 SHA_CONFLICT including the current SHA', async () => {
    const h = await createHarness();
    try {
      const cookie = await completeSignin(h);
      const csrf = await csrfTokenFor(h, cookie);
      h.setContentFixture({
        data: { 'src/posts/note.md': fileFixture('# other', OTHER_SHA) },
      });
      const res = await put(
        h,
        CONTENT_URL,
        cookie,
        csrf,
        JSON.stringify({
          path: 'note.md',
          content: '# new',
          expectedSha: BLOB_SHA,
        }),
      );
      expect(res.status).toBe(409);
      expect(res.code).toBe('SHA_CONFLICT');
      const error = (res.json as { error: Record<string, unknown> }).error;
      expect(error.currentSha).toBe(OTHER_SHA);
      expect(h.createdCalls).toEqual([]);
      expect(h.requestedPaths).toEqual(['src/posts/note.md']);
      await closeHarness(h);
    } finally {
      await closeHarness(h);
    }
  });

  it('rejects a missing path with 404 FILE_NOT_FOUND without writing', async () => {
    const h = await createHarness();
    try {
      const cookie = await completeSignin(h);
      const csrf = await csrfTokenFor(h, cookie);
      h.setContentFixture({ data: {} });
      const res = await put(
        h,
        CONTENT_URL,
        cookie,
        csrf,
        JSON.stringify({
          path: 'note.md',
          content: '# new',
          expectedSha: BLOB_SHA,
        }),
      );
      expect(res.status).toBe(404);
      expect(res.code).toBe('FILE_NOT_FOUND');
      expect(h.createdCalls).toEqual([]);
      expect(h.requestedPaths).toEqual(['src/posts/note.md']);
      await closeHarness(h);
    } finally {
      await closeHarness(h);
    }
  });

  it('rejects a directory path with 404 FILE_NOT_FOUND without writing', async () => {
    const h = await createHarness();
    try {
      const cookie = await completeSignin(h);
      const csrf = await csrfTokenFor(h, cookie);
      h.setContentFixture({
        data: { 'src/posts/2026': [dirEntry('index.md', 'file', BLOB_SHA, 1)] },
      });
      const res = await put(
        h,
        CONTENT_URL,
        cookie,
        csrf,
        JSON.stringify({
          path: '2026',
          content: '# new',
          expectedSha: BLOB_SHA,
        }),
      );
      expect(res.status).toBe(404);
      expect(res.code).toBe('FILE_NOT_FOUND');
      expect(h.createdCalls).toEqual([]);
      expect(h.requestedPaths).toEqual(['src/posts/2026']);
      await closeHarness(h);
    } finally {
      await closeHarness(h);
    }
  });

  it('maps a concurrent-update 409 from the write to 409 SHA_CONFLICT after one read-only refetch', async () => {
    const h = await createHarness();
    try {
      const cookie = await completeSignin(h);
      const csrf = await csrfTokenFor(h, cookie);
      // Stateful upstream sequence: the pre-check read sees BLOB_SHA,
      // the update write races a concurrent update (409), and the one
      // read-only refetch observes the concurrent writer's OTHER_SHA.
      h.setContentFixture({
        readSequence: [
          fileFixture('# old', BLOB_SHA),
          fileFixture('# concurrent', OTHER_SHA),
        ],
        create: { status: 409 },
      });
      const res = await put(
        h,
        CONTENT_URL,
        cookie,
        csrf,
        JSON.stringify({
          path: 'note.md',
          content: '# new',
          expectedSha: BLOB_SHA,
        }),
      );
      expect(res.status).toBe(409);
      expect(res.code).toBe('SHA_CONFLICT');
      // The current SHA must come from the refetch (OTHER_SHA), not the
      // pre-check (BLOB_SHA).
      const error = (res.json as { error: Record<string, unknown> }).error;
      expect(error.currentSha).toBe(OTHER_SHA);
      // Exactly one update attempt, protected with the caller's SHA —
      // no write retry after the conflict.
      expect(h.createdCalls).toEqual([
        {
          path: 'src/posts/note.md',
          message: 'Update note.md',
          content: Buffer.from('# new').toString('base64'),
          sha: BLOB_SHA,
        },
      ]);
      // Exactly two upstream reads: the pre-check plus one refetch.
      expect(h.requestedPaths).toEqual(['src/posts/note.md', 'src/posts/note.md']);
      await closeHarness(h);
    } finally {
      await closeHarness(h);
    }
  });

  it('reports 409 SHA_CONFLICT without a fabricated currentSha when the post-conflict refetch fails, and keeps the session valid', async () => {
    const h = await createHarness();
    try {
      const cookie = await completeSignin(h);
      const csrf = await csrfTokenFor(h, cookie);
      // Pre-check read passes with BLOB_SHA, the update write races
      // (409), and the one read-only refetch fails with a 500: the
      // conflict must still be reported, without inventing a current
      // SHA and without retrying the write.
      h.setContentFixture({
        readSequence: [fileFixture('# old', BLOB_SHA), 500],
        create: { status: 409 },
      });
      const res = await put(
        h,
        CONTENT_URL,
        cookie,
        csrf,
        JSON.stringify({
          path: 'note.md',
          content: '# new',
          expectedSha: BLOB_SHA,
        }),
      );
      expect(res.status).toBe(409);
      expect(res.code).toBe('SHA_CONFLICT');
      const error = (res.json as { error: Record<string, unknown> }).error;
      expect('currentSha' in error).toBe(false);
      // One update attempt (no second write, no automatic retry)...
      expect(h.createdCalls).toEqual([
        {
          path: 'src/posts/note.md',
          message: 'Update note.md',
          content: Buffer.from('# new').toString('base64'),
          sha: BLOB_SHA,
        },
      ]);
      // ...and exactly two upstream reads (pre-check + failed refetch).
      expect(h.requestedPaths).toEqual(['src/posts/note.md', 'src/posts/note.md']);
      // The failed refetch was a 500, not a definitive 401: the session
      // stays valid — a follow-up read with the same cookie still 200s.
      h.setContentFixture({
        data: { 'src/posts': [dirEntry('note.md', 'file', BLOB_SHA, 4)] },
      });
      const followup = await get(h, CONTENT_URL, cookie);
      expect(followup.status).toBe(200);
      await closeHarness(h);
    } finally {
      await closeHarness(h);
    }
  });

  it('rejects a missing expectedSha with 422 PATH_INVALID and never builds a content client', async () => {
    const h = await createHarness();
    try {
      const cookie = await completeSignin(h);
      const csrf = await csrfTokenFor(h, cookie);
      const res = await put(
        h,
        CONTENT_URL,
        cookie,
        csrf,
        JSON.stringify({ path: 'note.md', content: '# new' }),
      );
      expect(res.status).toBe(422);
      expect(res.code).toBe('PATH_INVALID');
      expect(h.factoryTokens).toEqual([]);
      expect(h.requestedPaths).toEqual([]);
      expect(h.createdCalls).toEqual([]);
      await closeHarness(h);
    } finally {
      await closeHarness(h);
    }
  });

  it('rejects a malformed expectedSha with 422 PATH_INVALID before any upstream request', async () => {
    const h = await createHarness();
    try {
      const cookie = await completeSignin(h);
      const csrf = await csrfTokenFor(h, cookie);
      h.setContentFixture({
        data: { 'src/posts/note.md': fileFixture('# old', BLOB_SHA) },
      });
      for (const badSha of ['not-a-sha', 'a'.repeat(39), '', 'a'.repeat(41)]) {
        const res = await put(
          h,
          CONTENT_URL,
          cookie,
          csrf,
          JSON.stringify({ path: 'note.md', content: '# new', expectedSha: badSha }),
        );
        expect(res.status).toBe(422);
        expect(res.code).toBe('PATH_INVALID');
      }
      // One local client per request — the SHA check rejects before any
      // upstream request, so no path is ever requested.
      expect(h.factoryTokens.length).toBe(4);
      expect(h.requestedPaths).toEqual([]);
      expect(h.createdCalls).toEqual([]);
      await closeHarness(h);
    } finally {
      await closeHarness(h);
    }
  });

  it('rejects an invalid path with 422 PATH_INVALID before any upstream request', async () => {
    const h = await createHarness();
    try {
      const cookie = await completeSignin(h);
      const csrf = await csrfTokenFor(h, cookie);
      h.setContentFixture({
        data: { 'src/posts/note.md': fileFixture('# old', BLOB_SHA) },
      });
      for (const badPath of ['../escape.md', '/absolute.md', '2026\\secret.md', '']) {
        const res = await put(
          h,
          CONTENT_URL,
          cookie,
          csrf,
          JSON.stringify({ path: badPath, content: '# new', expectedSha: BLOB_SHA }),
        );
        expect(res.status).toBe(422);
        expect(res.code).toBe('PATH_INVALID');
      }
      // One local client per request — path validation rejects before any
      // upstream request, so no path is ever requested.
      expect(h.factoryTokens.length).toBe(4);
      expect(h.requestedPaths).toEqual([]);
      expect(h.createdCalls).toEqual([]);
      await closeHarness(h);
    } finally {
      await closeHarness(h);
    }
  });

  it('accepts exactly 1 MB of content and rejects content over 1 MB with 422 CONTENT_TOO_LARGE', async () => {
    const h = await createHarness();
    try {
      const cookie = await completeSignin(h);
      const csrf = await csrfTokenFor(h, cookie);
      h.setContentFixture({
        data: { 'src/posts/note.md': fileFixture('# old', BLOB_SHA) },
        create: { sha: NEW_SHA },
      });
      const exact = 'x'.repeat(1024 * 1024);
      const ok = await put(
        h,
        CONTENT_URL,
        cookie,
        csrf,
        JSON.stringify({ path: 'note.md', content: exact, expectedSha: BLOB_SHA }),
      );
      expect(ok.status).toBe(200);
      const over = await put(
        h,
        CONTENT_URL,
        cookie,
        csrf,
        JSON.stringify({ path: 'note.md', content: exact + 'x', expectedSha: BLOB_SHA }),
      );
      expect(over.status).toBe(422);
      expect(over.code).toBe('CONTENT_TOO_LARGE');
      await closeHarness(h);
    } finally {
      await closeHarness(h);
    }
  });

  it('rejects malformed bodies with 422 PATH_INVALID and never builds a content client', async () => {
    const h = await createHarness();
    try {
      const cookie = await completeSignin(h);
      const csrf = await csrfTokenFor(h, cookie);
      const rawBodies = [
        'not json at all',
        '["an","array"]',
        'null',
        JSON.stringify({ path: 7, content: 'x', expectedSha: BLOB_SHA }),
        JSON.stringify({ content: 'x', expectedSha: BLOB_SHA }),
        JSON.stringify({ path: 'n.md', content: 'x' }),
        JSON.stringify({ path: 'n.md', content: 'x', expectedSha: 7 }),
      ];
      for (const rawBody of rawBodies) {
        const res = await put(h, CONTENT_URL, cookie, csrf, rawBody);
        expect(res.status).toBe(422);
        expect(res.code).toBe('PATH_INVALID');
      }
      expect(h.factoryTokens).toEqual([]);
      expect(h.requestedPaths).toEqual([]);
      expect(h.createdCalls).toEqual([]);
      await closeHarness(h);
    } finally {
      await closeHarness(h);
    }
  });

  it('rejects a present non-string message with 422 PATH_INVALID and never builds a client', async () => {
    const h = await createHarness();
    try {
      const cookie = await completeSignin(h);
      const csrf = await csrfTokenFor(h, cookie);
      const badMessages: unknown[] = [null, 7, true, [], {}];
      for (const message of badMessages) {
        const res = await put(
          h,
          CONTENT_URL,
          cookie,
          csrf,
          JSON.stringify({ path: 'n.md', content: 'x', expectedSha: BLOB_SHA, message }),
        );
        expect(res.status).toBe(422);
        expect(res.code).toBe('PATH_INVALID');
      }
      expect(h.factoryTokens).toEqual([]);
      expect(h.requestedPaths).toEqual([]);
      expect(h.createdCalls).toEqual([]);
      await closeHarness(h);
    } finally {
      await closeHarness(h);
    }
  });

  it('rejects an over-cap request body with 422 CONTENT_TOO_LARGE and never builds a client', async () => {
    const h = await createHarness();
    try {
      const cookie = await completeSignin(h);
      const csrf = await csrfTokenFor(h, cookie);
      const rawBody = JSON.stringify({
        path: 'big.md',
        content: 'x'.repeat(3 * 1024 * 1024),
        expectedSha: BLOB_SHA,
      });
      const res = await put(h, CONTENT_URL, cookie, csrf, rawBody);
      expect(res.status).toBe(422);
      expect(res.code).toBe('CONTENT_TOO_LARGE');
      expect(h.factoryTokens).toEqual([]);
      expect(h.requestedPaths).toEqual([]);
      await closeHarness(h);
    } finally {
      await closeHarness(h);
    }
  });

  it('maps upstream errors without invalidating the session', async () => {
    const h = await createHarness();
    try {
      const cookie = await completeSignin(h);
      const csrf = await csrfTokenFor(h, cookie);
      const cases = [
        { fixture: { data: {}, status: 403 }, status: 403, code: 'REPO_NOT_ALLOWED' },
        { fixture: { data: {}, status: 429 }, status: 429, code: 'RATE_LIMITED' },
        { fixture: { data: {}, status: 502 }, status: 502, code: 'GITHUB_UNAVAILABLE' },
        { fixture: { data: {}, networkFailure: true }, status: 502, code: 'GITHUB_UNAVAILABLE' },
      ];
      for (const { fixture, status, code } of cases) {
        h.setContentFixture(fixture);
        const res = await put(
          h,
          CONTENT_URL,
          cookie,
          csrf,
          JSON.stringify({ path: 'note.md', content: '# new', expectedSha: BLOB_SHA }),
        );
        expect(res.status).toBe(status);
        expect(res.code).toBe(code);
      }
      const s = await get(h, '/api/session', cookie);
      expect(s.status).toBe(200);
      await closeHarness(h);
    } finally {
      await closeHarness(h);
    }
  });

  it('invalidates the session on a definitive upstream 401', async () => {
    const h = await createHarness();
    try {
      const cookie = await completeSignin(h);
      const csrf = await csrfTokenFor(h, cookie);
      h.setContentFixture({ data: {}, status: 401 });
      const res = await put(
        h,
        CONTENT_URL,
        cookie,
        csrf,
        JSON.stringify({ path: 'note.md', content: '# new', expectedSha: BLOB_SHA }),
      );
      expect(res.status).toBe(401);
      expect(res.code).toBe('UNAUTHORIZED');
      // Session invalidated: a follow-up update is unauthenticated.
      const followup = await put(
        h,
        CONTENT_URL,
        cookie,
        csrf,
        JSON.stringify({ path: 'note.md', content: '# new', expectedSha: BLOB_SHA }),
      );
      expect(followup.status).toBe(401);
      expect(followup.code).toBe('UNAUTHORIZED');
      await closeHarness(h);
    } finally {
      await closeHarness(h);
    }
  });

  it('fails closed with 500 INTERNAL_ERROR when the write payload is malformed', async () => {
    const h = await createHarness();
    try {
      const cookie = await completeSignin(h);
      const csrf = await csrfTokenFor(h, cookie);
      h.setContentFixture({
        data: { 'src/posts/note.md': fileFixture('# old', BLOB_SHA) },
        create: { data: { content: 'not-an-object' } },
      });
      const res = await put(
        h,
        CONTENT_URL,
        cookie,
        csrf,
        JSON.stringify({ path: 'note.md', content: '# new', expectedSha: BLOB_SHA }),
      );
      expect(res.status).toBe(500);
      expect(res.code).toBe('INTERNAL_ERROR');
      await closeHarness(h);
    } finally {
      await closeHarness(h);
    }
  });

  it('enforces the CSRF and write-authorization boundaries with zero client construction', async () => {
    // Unauthenticated.
    let h = await createHarness();
    let res = await put(h, CONTENT_URL);
    expect(res.status).toBe(401);
    expect(res.code).toBe('UNAUTHORIZED');
    expect(h.factoryTokens).toEqual([]);
    await closeHarness(h);

    // Authenticated but missing the CSRF token.
    h = await createHarness();
    const cookie = await completeSignin(h);
    res = await put(h, CONTENT_URL, cookie);
    expect(res.status).toBe(403);
    expect(res.code).toBe('CSRF_INVALID');
    expect(h.factoryTokens).toEqual([]);
    await closeHarness(h);

    // Write CSRF-validated but a read-only repository.
    h = await createHarness();
    const writeCookie = await completeSignin(h);
    const csrf = await csrfTokenFor(h, writeCookie);
    res = await put(
      h,
      `/api/repos/${LOGIN}/docs/content`,
      writeCookie,
      csrf,
      JSON.stringify({ path: 'n.md', content: 'x', expectedSha: BLOB_SHA }),
    );
    expect(res.status).toBe(403);
    expect(res.code).toBe('REPO_NOT_ALLOWED');
    expect(h.factoryTokens).toEqual([]);
    expect(h.createdCalls).toEqual([]);
    await closeHarness(h);
  });

  it('builds the client from the refreshed access token when the stored token is near expiry', async () => {
    const h = await createHarness();
    try {
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
        data: { 'src/posts/note.md': fileFixture('# old', BLOB_SHA) },
        create: { sha: NEW_SHA },
      });
      const csrf = await csrfTokenFor(h, cookie);
      const res = await put(
        h,
        CONTENT_URL,
        cookie,
        csrf,
        JSON.stringify({ path: 'note.md', content: '# new', expectedSha: BLOB_SHA }),
      );
      expect(res.status).toBe(200);
      expect(h.factoryTokens).toEqual([REFRESHED_ACCESS_TOKEN]);
      await closeHarness(h);
    } finally {
      await closeHarness(h);
    }
  });
});

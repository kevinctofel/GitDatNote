/**
 * Task 3.4 — repository authorization tests.
 *
 * Two layers:
 *
 * 1. Service-level tests exercise `authorizeRepository` directly with the
 *    injectable GitHub transport: every required positive/negative case
 *    from the task (user + App permission matrix, installation/selection
 *    membership, malformed permissions, upstream status mapping, network
 *    failure, changed permissions, duplicates).
 *
 * 2. Integration tests run the full `createApp` server over real HTTP on
 *    an ephemeral port: the future content-operation boundary
 *    (`/api/repos/{owner}/{repo}/content`) behind the Task 3.3 CSRF
 *    boundary, plus repository-discovery flag truthfulness and the
 *    credential-hygiene guarantees.
 *
 * All upstream GitHub traffic is mocked; no real GitHub credentials,
 * tokens, or live repositories are used. Every credential-shaped value is
 * an obviously fake test constant.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../../src/server/index.js';
import { authorizeRepository } from '../../../src/server/auth/authorization.js';
import type { RepositoryAuthorization } from '../../../src/server/auth/authorization.js';
import {
  type FetchImpl,
  fetchAllPages,
  listAccessibleRepositories,
} from '../../../src/server/auth/github.js';
import { AuthError } from '../../../src/server/auth/types.js';
import {
  matchContentRepositoryRef,
} from '../../../src/server/middleware/repositoryAuth.js';
import type { StoredSession } from '../../../src/server/session/types.js';

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

/** The same account but read-only contents permission. */
const INSTALLATION_READ = {
  id: 111,
  account: { login: LOGIN, id: 9001 },
  permissions: { contents: 'read' },
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

/* ------------------------------------------------------------------ */
/* Service-level helpers                                              */
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

/**
 * Wrap list items in GitHub's documented response envelope
 * (https://docs.github.com/en/rest/apps/installations). Both list endpoints
 * return JSON objects containing the array — never bare arrays.
 */
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

interface GitHubScenario {
  installations?: Array<Record<string, unknown>>;
  /** Repository list per installation id; missing id → 404. */
  reposByInstallation?: Record<number, unknown[]>;
  installationsStatus?: number;
  /** Per-installation status for the repositories endpoint. */
  reposStatusByInstallation?: Record<number, number>;
  headers?: Record<string, string>;
  /** When set, fetch rejects (network failure). */
  networkFailure?: boolean;
  /** Raw body override for /user/installations (bypasses envelope wrapping). */
  rawInstallationsBody?: unknown;
  /** Raw body override for the repositories endpoint (bypasses envelope wrapping). */
  rawReposBody?: unknown;
}

function fetchFor(scenario: GitHubScenario): FetchImpl {
  const mock = vi.fn(async (input: string): Promise<Response> => {
    if (scenario.networkFailure) {
      throw new TypeError('fetch failed');
    }
    const url = new URL(input);
    if (url.pathname === '/user/installations') {
      return ghJson(
        scenario.installationsStatus ?? 200,
        scenario.rawInstallationsBody ??
          installationsEnvelope(scenario.installations ?? [INSTALLATION_FULL]),
        scenario.headers,
      );
    }
    const match = url.pathname.match(/^\/user\/installations\/(\d+)\/repositories$/);
    if (match !== null) {
      const id = Number(match[1]);
      const status = scenario.reposStatusByInstallation?.[id] ?? 200;
      const repos = scenario.reposByInstallation?.[id];
      if (repos === undefined) {
        return ghJson(status === 200 ? 404 : status, { message: 'Not Found' });
      }
      return ghJson(
        status,
        scenario.rawReposBody ?? repositoriesEnvelope(repos),
        scenario.headers,
      );
    }
    return ghJson(404, { message: 'Not Found' });
  });
  return mock as FetchImpl;
}

const NOW = 1_750_000_000_000;

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    sessionId: 'sess-test',
    credentials: {
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
    },
    githubLogin: LOGIN,
    githubAvatarUrl: null,
    expiresAt: NOW + 3_600_000,
    ...overrides,
  } as StoredSession;
}

async function authorize(
  session: StoredSession | null,
  owner: string,
  repo: string,
  access: 'read' | 'write',
  scenario: GitHubScenario,
): Promise<RepositoryAuthorization> {
  return authorizeRepository(session, owner, repo, access, {
    fetchImpl: fetchFor(scenario),
  });
}

/* ------------------------------------------------------------------ */
/* 1) Service-level authorization cases                               */
/* ------------------------------------------------------------------ */

describe('authorizeRepository (service level)', () => {
  it('allows read when both the user and the App installation have read access', async () => {
    const result = await authorize(
      makeSession(),
      LOGIN,
      'notes',
      'read',
      { reposByInstallation: { 111: [REPO_WRITE] } },
    );
    expect(result).toEqual({ status: 'authorized', owner: LOGIN, repo: 'notes', access: 'read' });
  });

  it('allows write when both the user and the App installation have write access', async () => {
    const result = await authorize(
      makeSession(),
      LOGIN,
      'notes',
      'write',
      { reposByInstallation: { 111: [REPO_WRITE] } },
    );
    expect(result).toEqual({ status: 'authorized', owner: LOGIN, repo: 'notes', access: 'write' });
  });

  it('allows read but denies write when the user has only read permission', async () => {
    const scenario = { reposByInstallation: { 111: [REPO_READ] } };
    await expect(authorize(makeSession(), LOGIN, 'docs', 'read', scenario)).resolves.toEqual({
      status: 'authorized',
      owner: LOGIN,
      repo: 'docs',
      access: 'read',
    });
    await expect(authorize(makeSession(), LOGIN, 'docs', 'write', scenario)).resolves.toEqual({
      status: 'denied',
    });
  });

  it('denies write when the user has write access but the App installation is read-only', async () => {
    const scenario = {
      installations: [INSTALLATION_READ],
      reposByInstallation: { 111: [REPO_WRITE] },
    };
    await expect(authorize(makeSession(), LOGIN, 'notes', 'read', scenario)).resolves.toEqual({
      status: 'authorized',
      owner: LOGIN,
      repo: 'notes',
      access: 'read',
    });
    await expect(authorize(makeSession(), LOGIN, 'notes', 'write', scenario)).resolves.toEqual({
      status: 'denied',
    });
  });

  it('denies write when the App installation has write access but the user is read-only', async () => {
    const scenario = { reposByInstallation: { 111: [REPO_READ] } };
    await expect(authorize(makeSession(), LOGIN, 'docs', 'write', scenario)).resolves.toEqual({
      status: 'denied',
    });
  });

  it('denies access when the App has no installation for the requested owner', async () => {
    const scenario = {
      installations: [{ id: 111, account: { login: 'other-owner', id: 9002 }, permissions: { contents: 'write' }, suspended_at: null }],
      reposByInstallation: { 111: [REPO_WRITE] },
    };
    await expect(authorize(makeSession(), LOGIN, 'notes', 'read', scenario)).resolves.toEqual({
      status: 'denied',
    });
  });

  it('denies access when the repository is excluded from the installation selection', async () => {
    const scenario = { reposByInstallation: { 111: [REPO_READ] } };
    await expect(authorize(makeSession(), LOGIN, 'unlisted', 'read', scenario)).resolves.toEqual({
      status: 'denied',
    });
  });

  it('denies access for a repository belonging to another owner', async () => {
    const scenario = { reposByInstallation: { 111: [REPO_WRITE] } };
    await expect(authorize(makeSession(), 'someone-else', 'notes', 'read', scenario)).resolves.toEqual({
      status: 'denied',
    });
  });

  it('denies access when the authenticated user requests an unrelated repository', async () => {
    const scenario = { reposByInstallation: { 111: [REPO_WRITE] } };
    await expect(authorize(makeSession(), LOGIN, 'unrelated', 'read', scenario)).resolves.toEqual({
      status: 'denied',
    });
  });

  it('denies read when the installation has no contents permission at all', async () => {
    const scenario = {
      installations: [{ id: 111, account: { login: LOGIN, id: 9001 }, permissions: {}, suspended_at: null }],
      reposByInstallation: { 111: [REPO_WRITE] },
    };
    await expect(authorize(makeSession(), LOGIN, 'notes', 'read', scenario)).resolves.toEqual({
      status: 'denied',
    });
  });

  it('denies access for malformed or missing permission fields', async () => {
    const malformedUserPermissions = [
      { ...REPO_WRITE, permissions: undefined },
      { ...REPO_WRITE, permissions: null },
      { ...REPO_WRITE, permissions: 'yes' },
      { ...REPO_WRITE, permissions: { pull: 'true' } },
      { ...REPO_WRITE, permissions: { push: true } },
    ];
    for (const entry of malformedUserPermissions) {
      const scenario = { reposByInstallation: { 111: [entry] } };
      await expect(authorize(makeSession(), LOGIN, 'notes', 'read', scenario)).resolves.toEqual({
        status: 'denied',
      });
    }
    const malformedInstallationPermissions = [{}, ['write'], 'write', null, { contents: 'yes' }];
    for (const permissions of malformedInstallationPermissions) {
      const scenario = {
        installations: [{ id: 111, account: { login: LOGIN, id: 9001 }, permissions, suspended_at: null }],
        reposByInstallation: { 111: [REPO_WRITE] },
      };
      await expect(authorize(makeSession(), LOGIN, 'notes', 'read', scenario)).resolves.toEqual({
        status: 'denied',
      });
    }
  });

  it('denies access when the installation account is missing or malformed', async () => {
    const badAccounts: Array<Record<string, unknown>> = [
      { id: 111, permissions: { contents: 'write' }, suspended_at: null },
      { id: 111, account: null, permissions: { contents: 'write' }, suspended_at: null },
      { id: 111, account: { login: '' }, permissions: { contents: 'write' }, suspended_at: null },
    ];
    for (const entry of badAccounts) {
      const scenario = { installations: [entry], reposByInstallation: { 111: [REPO_WRITE] } };
      await expect(authorize(makeSession(), LOGIN, 'notes', 'read', scenario)).resolves.toEqual({
        status: 'denied',
      });
    }
  });

  it('safely denies when GitHub returns 404 for the repository list (private/inaccessible)', async () => {
    const scenario = {
      reposByInstallation: {},
      reposStatusByInstallation: { 111: 404 },
      installations: [INSTALLATION_FULL],
    };
    await expect(authorize(makeSession(), LOGIN, 'notes', 'read', scenario)).resolves.toEqual({
      status: 'denied',
    });
  });

  it('safely denies when GitHub returns 404 for the installation list', async () => {
    const scenario = { installationsStatus: 404 };
    await expect(authorize(makeSession(), LOGIN, 'notes', 'read', scenario)).resolves.toEqual({
      status: 'denied',
    });
  });

  it('returns unauthorized when GitHub returns 401', async () => {
    const scenario = { installationsStatus: 401 };
    await expect(authorize(makeSession(), LOGIN, 'notes', 'read', scenario)).resolves.toEqual({
      status: 'unauthorized',
    });
  });

  it('denies when GitHub returns a plain 403 (permission denial, never a success)', async () => {
    const scenario = { installationsStatus: 403 };
    await expect(authorize(makeSession(), LOGIN, 'notes', 'read', scenario)).resolves.toEqual({
      status: 'denied',
    });
  });

  it('propagates a rate limit (429, or 403 with X-RateLimit-Remaining: 0) to the caller', async () => {
    await expect(
      authorize(makeSession(), LOGIN, 'notes', 'read', { installationsStatus: 429 }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(
      authorize(
        makeSession(),
        LOGIN,
        'notes',
        'read',
        { installationsStatus: 403, headers: { 'X-RateLimit-Remaining': '0' } },
      ),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('propagates a GitHub 5xx as GITHUB_UNAVAILABLE to the caller', async () => {
    await expect(
      authorize(makeSession(), LOGIN, 'notes', 'read', { installationsStatus: 500 }),
    ).rejects.toMatchObject({ code: 'GITHUB_UNAVAILABLE' });
  });

  it('grants no authorization on network failure', async () => {
    await expect(
      authorize(makeSession(), LOGIN, 'notes', 'read', { networkFailure: true }),
    ).rejects.toMatchObject({ code: 'GITHUB_UNAVAILABLE' });
  });

  it('returns unauthorized for a null session without any upstream request', async () => {
    const fetchImpl = fetchFor({});
    const result = await authorizeRepository(null, LOGIN, 'notes', 'read', { fetchImpl });
    expect(result).toEqual({ status: 'unauthorized' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('denies malformed repository references locally, before any upstream request', async () => {
    const cases: Array<[string, string]> = [
      ['', 'notes'],
      ['owner with spaces', 'notes'],
      ['owner', ''],
      ['owner', 'bad/name'],
      ['x'.repeat(40), 'notes'],
    ];
    for (const [owner, repo] of cases) {
      const fetchImpl = fetchFor({});
      const result = await authorizeRepository(makeSession(), owner, repo, 'read', { fetchImpl });
      expect(result).toEqual({ status: 'denied' });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('matches owner and repository case-insensitively (GitHub semantics)', async () => {
    const scenario = { reposByInstallation: { 111: [REPO_WRITE] } };
    await expect(authorize(makeSession(), LOGIN.toUpperCase(), 'Notes', 'read', scenario)).resolves.toEqual({
      status: 'authorized',
      owner: LOGIN.toUpperCase(),
      repo: 'Notes',
      access: 'read',
    });
  });

  it('skips suspended installations when selecting the App installation', async () => {
    const scenario = {
      installations: [
        { id: 111, account: { login: LOGIN, id: 9001 }, permissions: { contents: 'write' }, suspended_at: '2026-01-01T00:00:00Z' },
      ],
      reposByInstallation: { 111: [REPO_WRITE] },
    };
    await expect(authorize(makeSession(), LOGIN, 'notes', 'read', scenario)).resolves.toEqual({
      status: 'denied',
    });
  });

  it('uses the lowest-id active installation when several match (deterministic)', async () => {
    const scenario = {
      installations: [
        { id: 222, account: { login: LOGIN, id: 9001 }, permissions: { contents: 'read' }, suspended_at: null },
        { id: 111, account: { login: LOGIN, id: 9001 }, permissions: { contents: 'write' }, suspended_at: null },
      ],
      reposByInstallation: {
        111: [REPO_WRITE],
        222: [REPO_WRITE],
      },
    };
    // Installation 111 (write) is selected first; write is allowed.
    await expect(authorize(makeSession(), LOGIN, 'notes', 'write', scenario)).resolves.toEqual({
      status: 'authorized',
      owner: LOGIN,
      repo: 'notes',
      access: 'write',
    });
  });

  it('honors the current permission when it changed after an earlier discovery', async () => {
    const mutable = { reposByInstallation: { 111: [REPO_WRITE] } };
    // Discovery-time state: write allowed.
    await expect(authorize(makeSession(), LOGIN, 'notes', 'write', mutable)).resolves.toEqual({
      status: 'authorized',
      owner: LOGIN,
      repo: 'notes',
      access: 'write',
    });
    // Permission downgraded (read-only) after discovery: current state wins.
    mutable.reposByInstallation = { 111: [REPO_READ] };
    await expect(authorize(makeSession(), LOGIN, 'notes', 'write', mutable)).resolves.toEqual({
      status: 'denied',
    });
  });

  it('denies when the repository was removed from the App installation after discovery', async () => {
    const mutable = { reposByInstallation: { 111: [REPO_WRITE, REPO_READ] } };
    await expect(authorize(makeSession(), LOGIN, 'notes', 'read', mutable)).resolves.toEqual({
      status: 'authorized',
      owner: LOGIN,
      repo: 'notes',
      access: 'read',
    });
    mutable.reposByInstallation = { 111: [REPO_READ] };
    await expect(authorize(makeSession(), LOGIN, 'notes', 'read', mutable)).resolves.toEqual({
      status: 'denied',
    });
  });

  it('fails closed on duplicate repository entries with inconsistent permissions', async () => {
    const scenario = {
      reposByInstallation: {
        111: [
          { ...REPO_WRITE, name: 'notes' },
          { ...REPO_READ, name: 'notes' },
        ],
      },
    };
    await expect(authorize(makeSession(), LOGIN, 'notes', 'write', scenario)).resolves.toEqual({
      status: 'denied',
    });
  });

  it('authorizes duplicate repository entries when all entries agree', async () => {
    const scenario = {
      reposByInstallation: {
        111: [REPO_WRITE, { ...REPO_WRITE }],
      },
    };
    await expect(authorize(makeSession(), LOGIN, 'notes', 'write', scenario)).resolves.toEqual({
      status: 'authorized',
      owner: LOGIN,
      repo: 'notes',
      access: 'write',
    });
  });

  it('exposes no credentials or installation details in the authorized result', async () => {
    const result = await authorize(
      makeSession(),
      LOGIN,
      'notes',
      'write',
      { reposByInstallation: { 111: [REPO_WRITE] } },
    );
    expect(result).toEqual({ status: 'authorized', owner: LOGIN, repo: 'notes', access: 'write' });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain(REFRESH_TOKEN);
    expect(serialized).not.toContain('contents');
  });
});

/* ------------------------------------------------------------------ */
/* 2) Integration tests: content boundary + discovery over real HTTP  */
/* ------------------------------------------------------------------ */

interface Harness {
  server: Server;
  base: string;
  fetchImpl: ReturnType<typeof vi.fn>;
  dir: string;
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
  const dir = mkdtempSync(join(tmpdir(), 'gitdatnote-authz-'));
  const env: Record<string, string | undefined> = {
    GITHUB_APP_CLIENT_ID: CLIENT_ID,
    GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET,
    GITHUB_OAUTH_CALLBACK_URL: CALLBACK,
    SESSION_ENCRYPTION_KEY: SESSION_KEY,
    SESSION_DB_PATH: join(dir, 'sessions.db'),
  };
  const current = BASE_NOW;
  const now = () => current;
  const fetchImpl = vi.fn();
  const server = createApp({ env, fetchImpl, now });
  const port = await listen(server);
  const harness: Harness = { server, base: `http://127.0.0.1:${port}`, fetchImpl, dir };
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
  installations?: unknown;
  repos?: unknown;
  /** Repository list per installation id (takes precedence over `repos`). */
  reposByInstallation?: Record<number, unknown[]>;
  installationsStatus?: number;
  reposStatus?: number;
  networkFailure?: boolean;
}

function mockGithub(h: Harness, opts: IntegrationMockOptions = {}): void {
  h.fetchImpl.mockImplementation(async (input: string) => {
    if (opts.networkFailure) throw new TypeError('fetch failed');
    const url = new URL(input);
    if (url.pathname === '/login/oauth/access_token') {
      return ghJson(200, TOKEN_RESPONSE);
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
    if (url.pathname.startsWith('/user/installations/') && url.pathname.endsWith('/repositories')) {
      const idMatch = url.pathname.match(/^\/user\/installations\/(\d+)\/repositories$/);
      const repos =
        (idMatch !== null ? opts.reposByInstallation?.[Number(idMatch[1])] : undefined) ??
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

async function closeHarness(h: Harness): Promise<void> {
  await new Promise<void>((resolve) => h.server.close(() => resolve()));
  try {
    h.server.closeAllConnections();
  } catch {
    /* ignore */
  }
  rmSync(h.dir, { recursive: true, force: true });
}

afterEach(() => {
  logSpy.mockClear();
  errSpy.mockClear();
});

afterAll(async () => {
  for (const h of harnesses) {
    await closeHarness(h);
  }
  logSpy.mockRestore();
  errSpy.mockRestore();
});

async function completeSignin(h: Harness, opts: IntegrationMockOptions = {}): Promise<string> {
  mockGithub(h, opts);
  const start = await fetch(h.base + '/api/auth/github/start', { redirect: 'manual' });
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
    h.base + '/api/auth/github/callback?code=' + AUTH_CODE + '&state=' + encodeURIComponent(state ?? ''),
    { headers: { cookie: pendingCookie as string }, redirect: 'manual' },
  );
  expect(cb.status).toBe(302);
  const sessionCookie = cb.headers.getSetCookie().find((c) => c.startsWith('gitdatnote_session='));
  expect(sessionCookie).toBeTypeOf('string');
  return sessionCookie as string;
}

/** Fetch /api/session and return the per-session CSRF token. */
async function csrfTokenFor(h: Harness, sessionCookie: string): Promise<string> {
  const res = await fetch(h.base + '/api/session', { headers: { cookie: sessionCookie } });
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

async function post(
  h: Harness,
  path: string,
  cookie?: string,
  csrf?: string,
): Promise<{ status: number; body: string; json: unknown; code: string | undefined }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie !== undefined) headers.cookie = cookie;
  if (csrf !== undefined) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(h.base + path, { method: 'POST', headers, body: '{}' });
  const body = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(body);
  } catch {
    json = null;
  }
  return { status: res.status, body, json, code: codeOf(json) };
}

describe('future content-operation boundary (integration)', () => {
  it('rejects unauthenticated content reads with 401 UNAUTHORIZED', async () => {
    const h = await createHarness();
    const res = await get(h, `/api/repos/${LOGIN}/notes/content`);
    expect(res.status).toBe(401);
    expect(res.code).toBe('UNAUTHORIZED');
    await closeHarness(h);
  });

  it('rejects unauthenticated content mutations with 401 UNAUTHORIZED (CSRF boundary first)', async () => {
    const h = await createHarness();
    const res = await post(h, `/api/repos/${LOGIN}/notes/content`);
    expect(res.status).toBe(401);
    expect(res.code).toBe('UNAUTHORIZED');
    await closeHarness(h);
  });

  it('allows an authenticated, authorized read to reach the (not-yet-existing) handler: standard 404', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const res = await get(h, `/api/repos/${LOGIN}/notes/content`, cookie);
    // The boundary passed (no 403); no content handler exists yet, so the
    // established standard 404 is the safe response.
    expect(res.status).toBe(404);
    expect(res.code).toBe('FILE_NOT_FOUND');
    await closeHarness(h);
  });

  it('denies a content read when the user has only read access and write was required (mutation path)', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    // POST on the read-only repository: CSRF passes (valid token), then the
    // authorization boundary denies with REPO_NOT_ALLOWED.
    const csrf = await csrfTokenFor(h, cookie);
    const res = await post(h, `/api/repos/${LOGIN}/docs/content`, cookie, csrf);
    expect(res.status).toBe(403);
    expect(res.code).toBe('REPO_NOT_ALLOWED');
    await closeHarness(h);
  });

  it('keeps the CSRF boundary intact: mutation without a CSRF token is CSRF_INVALID, not authorized', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const res = await post(h, `/api/repos/${LOGIN}/notes/content`, cookie);
    expect(res.status).toBe(403);
    expect(res.code).toBe('CSRF_INVALID');
    await closeHarness(h);
  });

  it('allows an authenticated, authorized, CSRF-validated write to reach the standard 404', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const csrf = await csrfTokenFor(h, cookie);
    const res = await post(h, `/api/repos/${LOGIN}/notes/content`, cookie, csrf);
    expect(res.status).toBe(404);
    expect(res.code).toBe('FILE_NOT_FOUND');
    await closeHarness(h);
  });

  it('denies a content read for a repository outside the App installation (403 REPO_NOT_ALLOWED)', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const res = await get(h, `/api/repos/someone-else/notes/content`, cookie);
    expect(res.status).toBe(403);
    expect(res.code).toBe('REPO_NOT_ALLOWED');
    await closeHarness(h);
  });

  it('denies a content read for a repository excluded from the installation selection', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const res = await get(h, `/api/repos/${LOGIN}/unlisted/content`, cookie);
    expect(res.status).toBe(403);
    expect(res.code).toBe('REPO_NOT_ALLOWED');
    await closeHarness(h);
  });

  it('maps GitHub 401 to 401 UNAUTHORIZED on the content boundary', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    mockGithub(h, { installationsStatus: 401 });
    const res = await get(h, `/api/repos/${LOGIN}/notes/content`, cookie);
    expect(res.status).toBe(401);
    expect(res.code).toBe('UNAUTHORIZED');
    await closeHarness(h);
  });

  it('maps a GitHub 403 (permission denial) to 403 REPO_NOT_ALLOWED on the content boundary', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    mockGithub(h, { installationsStatus: 403 });
    const res = await get(h, `/api/repos/${LOGIN}/notes/content`, cookie);
    expect(res.status).toBe(403);
    expect(res.code).toBe('REPO_NOT_ALLOWED');
    await closeHarness(h);
  });

  it('maps a GitHub 404 to a safe 403 REPO_NOT_ALLOWED (no existence leak)', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    mockGithub(h, { installationsStatus: 404 });
    const res = await get(h, `/api/repos/${LOGIN}/notes/content`, cookie);
    expect(res.status).toBe(403);
    expect(res.code).toBe('REPO_NOT_ALLOWED');
    await closeHarness(h);
  });

  it('maps a GitHub rate limit to 429 RATE_LIMITED on the content boundary', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    mockGithub(h, { installationsStatus: 429 });
    const res = await get(h, `/api/repos/${LOGIN}/notes/content`, cookie);
    expect(res.status).toBe(429);
    expect(res.code).toBe('RATE_LIMITED');
    await closeHarness(h);
  });

  it('maps a GitHub 5xx to 502 GITHUB_UNAVAILABLE on the content boundary', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    mockGithub(h, { installationsStatus: 500 });
    const res = await get(h, `/api/repos/${LOGIN}/notes/content`, cookie);
    expect(res.status).toBe(502);
    expect(res.code).toBe('GITHUB_UNAVAILABLE');
    await closeHarness(h);
  });

  it('maps a network failure to 502 GITHUB_UNAVAILABLE (no authorization granted)', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    mockGithub(h, { networkFailure: true });
    const res = await get(h, `/api/repos/${LOGIN}/notes/content`, cookie);
    expect(res.status).toBe(502);
    expect(res.code).toBe('GITHUB_UNAVAILABLE');
    await closeHarness(h);
  });

  it('does not leak credentials in responses or server logs', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const denied = await get(h, `/api/repos/${LOGIN}/unlisted/content`, cookie);
    const allowed = await get(h, `/api/repos/${LOGIN}/notes/content`, cookie);
    const csrf = await csrfTokenFor(h, cookie);
    const mutation = await post(h, `/api/repos/${LOGIN}/notes/content`, cookie, csrf);
    for (const res of [denied, allowed, mutation]) {
      expect(res.body).not.toContain(ACCESS_TOKEN);
      expect(res.body).not.toContain(REFRESH_TOKEN);
    }
    for (const line of allLogs()) {
      expect(line).not.toContain(ACCESS_TOKEN);
      expect(line).not.toContain(REFRESH_TOKEN);
      expect(line).not.toContain(CLIENT_SECRET);
    }
    await closeHarness(h);
  });
});

describe('matchContentRepositoryRef', () => {
  it('parses owner and repo from content paths', () => {
    expect(matchContentRepositoryRef('/api/repos/acme/blog/content')).toEqual({
      owner: 'acme',
      repo: 'blog',
    });
    expect(matchContentRepositoryRef('/api/repos/acme/blog/content/2026/notes.md')).toEqual({
      owner: 'acme',
      repo: 'blog',
    });
  });

  it('rejects non-content paths', () => {
    expect(matchContentRepositoryRef('/api/repos/acme/blog')).toBeNull();
    expect(matchContentRepositoryRef('/api/repositories')).toBeNull();
    expect(matchContentRepositoryRef('/api/repos/acme')).toBeNull();
    expect(matchContentRepositoryRef('/api/auth/github/start')).toBeNull();
  });
});

describe('repository discovery flags (integration)', () => {
  it('returns truthful read/write flags under the dual-permission model', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h);
    const res = await get(h, '/api/repositories', cookie);
    expect(res.status).toBe(200);
    const body = (res.json as unknown) as Array<Record<string, unknown>>;
    const byName = Object.fromEntries(body.map((r) => [r.name as string, r]));
    // User push+pull and installation contents=write → writable.
    expect(byName['notes']).toEqual({
      owner: LOGIN,
      name: 'notes',
      contentRoot: 'src/posts',
      canRead: true,
      canWrite: true,
      private: true,
    });
    // User pull only → read-only, never writable.
    expect(byName['docs']).toEqual({
      owner: LOGIN,
      name: 'docs',
      contentRoot: 'src/posts',
      canRead: true,
      canWrite: false,
      private: false,
    });
    await closeHarness(h);
  });

  it('marks everything read-only when the installation is read-only, even if the user can push', async () => {
    const h = await createHarness();
    const cookie = await completeSignin(h, { installations: [INSTALLATION_READ] });
    const res = await get(h, '/api/repositories', cookie);
    expect(res.status).toBe(200);
    const body = (res.json as unknown) as Array<Record<string, unknown>>;
    const byName = Object.fromEntries(body.map((r) => [r.name as string, r]));
    expect(byName['notes']).toMatchObject({ canRead: true, canWrite: false });
    expect(byName['docs']).toMatchObject({ canRead: true, canWrite: false });
    await closeHarness(h);
  });

  it('omits repositories whose installation lacks contents permission entirely', async () => {
    // Intended behavior, consistent with OpenSpec: an installation with no
    // contents permission cannot operate any repository through GitDatNote,
    // so none of its repositories appear in discovery at all (even when the
    // connected user has full push/pull there). Read-only installations
    // still list their repositories, with write access disabled — asserted
    // here by exact entries so the check cannot pass vacuously.
    const h = await createHarness();
    const cookie = await completeSignin(h, {
      installations: [
        { id: 111, account: { login: LOGIN, id: 9001 }, permissions: {}, suspended_at: null },
        { id: 222, account: { login: LOGIN, id: 9002 }, permissions: { contents: 'read' }, suspended_at: null },
      ],
      reposByInstallation: {
        // The user has full push/pull here, but the App has no contents
        // permission, so these repositories must not be discoverable.
        111: [
          {
            owner: { login: LOGIN },
            name: 'hidden',
            private: true,
            permissions: { admin: true, push: true, pull: true },
          },
        ],
        222: [REPO_WRITE, REPO_READ],
      },
    });
    const res = await get(h, '/api/repositories', cookie);
    expect(res.status).toBe(200);
    const body = (res.json as unknown) as Array<Record<string, unknown>>;
    // Exactly the read-only installation's repositories — nothing from the
    // no-contents installation.
    expect(body.map((entry) => entry.name)).toEqual(['notes', 'docs']);
    for (const entry of body) {
      expect(entry.canRead).toBe(true);
      expect(entry.canWrite).toBe(false);
    }
    await closeHarness(h);
  });
});

/* ------------------------------------------------------------------ */
/* GitHub list response envelope (task 3.4 compatibility regression)  */
/* ------------------------------------------------------------------ */
/*
 * GitHub's documented list endpoints return JSON objects containing the
 * array — never bare arrays (https://docs.github.com/en/rest/apps/installations):
 *
 *   GET /user/installations                 -> { total_count, installations: [...] }
 *   GET /user/installations/{id}/repositories -> { total_count, repositories: [...] }
 *
 * The shared `fetchAllPages` parser must accept exactly those envelopes and
 * reject everything else safely.
 */

describe('GitHub list response envelope (regression)', () => {
  it('accepts a valid installations envelope', async () => {
    const fetchImpl = vi.fn(async () =>
      ghJson(200, {
        total_count: 2,
        installations: [INSTALLATION_FULL, INSTALLATION_READ],
      }),
    );
    const result = await fetchAllPages(
      '/user/installations',
      ACCESS_TOKEN,
      fetchImpl,
      'installations',
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 111, suspended_at: null });
    expect(result[1]).toMatchObject({ id: 111 });
  });

  it('accepts a valid repositories envelope', async () => {
    const fetchImpl = vi.fn(async () =>
      ghJson(200, {
        total_count: 2,
        repository_selection: 'all',
        repositories: [REPO_WRITE, REPO_READ],
      }),
    );
    const result = await fetchAllPages(
      '/user/installations/111/repositories',
      ACCESS_TOKEN,
      fetchImpl,
      'repositories',
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ owner: { login: LOGIN }, name: 'notes' });
  });

  it('aggregates multi-page envelopes correctly', async () => {
    const third = {
      owner: { login: LOGIN },
      name: 'third',
      private: false,
      permissions: { push: true, pull: true },
    };
    const fetchImpl = vi.fn(async (input: string) => {
      const page = Number(new URL(input).searchParams.get('page') ?? 1);
      if (page === 1) {
        return ghJson(
          200,
          { total_count: 3, repositories: [REPO_WRITE, REPO_READ] },
          { link: '<https://api.github.com/user/installations/111/repositories?page=2> rel="next"' },
        );
      }
      return ghJson(200, { total_count: 3, repositories: [third] });
    });
    const result = await fetchAllPages(
      '/user/installations/111/repositories',
      ACCESS_TOKEN,
      fetchImpl,
      'repositories',
    );
    expect(
      result.map((entry) => (entry as Record<string, unknown>).name),
    ).toEqual(['notes', 'docs', 'third']);
  });

  it('rejects missing or malformed envelope fields safely', async () => {
    const badBodies: unknown[] = [
      { installations: [INSTALLATION_FULL] }, // missing total_count
      { total_count: '2', installations: [] }, // non-integer total_count
      { total_count: 1, repos: [REPO_WRITE] }, // wrong field name
      { total_count: 1, installations: REPO_WRITE }, // field is not an array
      { total_count: 1, repositories: [REPO_WRITE] }, // repositories envelope on /user/installations
      { total_count: 0, repositories: [REPO_WRITE] }, // installations field missing entirely
      'not an object',
      null,
    ];
    for (const body of badBodies) {
      const fetchImpl = vi.fn(async () => ghJson(200, body));
      await expect(
        fetchAllPages('/user/installations', ACCESS_TOKEN, fetchImpl, 'installations'),
      ).rejects.toMatchObject({ code: 'INTERNAL' });
    }
    // A malformed envelope must never authorize — the service fails closed.
    const result = await authorize(
      makeSession(),
      LOGIN,
      'notes',
      'read',
      { rawInstallationsBody: [INSTALLATION_FULL], reposByInstallation: { 111: [REPO_WRITE] } },
    ).catch((error: unknown) => ({ threw: error instanceof AuthError ? error.code : null }));
    expect(result).toEqual({ threw: 'INTERNAL' });
  });

  it('does not accept a bare array as a valid list response', async () => {
    for (const body of [[REPO_WRITE], [], [INSTALLATION_FULL]]) {
      const fetchImpl = vi.fn(async () => ghJson(200, body));
      await expect(
        fetchAllPages('/user/installations', ACCESS_TOKEN, fetchImpl, 'installations'),
      ).rejects.toMatchObject({ code: 'INTERNAL' });
      await expect(
        fetchAllPages(
          '/user/installations/111/repositories',
          ACCESS_TOKEN,
          fetchImpl,
          'repositories',
        ),
      ).rejects.toMatchObject({ code: 'INTERNAL' });
    }
  });

  it('permission checks work with realistic GitHub response objects', async () => {
    // Read: user pull + installation contents read/write → authorized.
    expect(
      await authorize(makeSession(), LOGIN, 'docs', 'read', {
        installations: [INSTALLATION_FULL],
        reposByInstallation: { 111: [REPO_READ] },
      }),
    ).toEqual({ status: 'authorized', owner: LOGIN, repo: 'docs', access: 'read' });
    // Write: read-only repository (user push: false) → denied.
    expect(
      await authorize(makeSession(), LOGIN, 'docs', 'write', {
        installations: [INSTALLATION_FULL],
        reposByInstallation: { 111: [REPO_READ] },
      }),
    ).toEqual({ status: 'denied' });
    // Write: writable repository but read-only installation → denied.
    expect(
      await authorize(makeSession(), LOGIN, 'notes', 'write', {
        installations: [INSTALLATION_READ],
        reposByInstallation: { 111: [REPO_WRITE] },
      }),
    ).toEqual({ status: 'denied' });
  });

  it('an authorized repository can be discovered and authorized using realistic mocks', async () => {
    const discoveryFetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/user/installations') {
        return ghJson(200, { total_count: 1, installations: [INSTALLATION_FULL] });
      }
      return ghJson(200, { total_count: 2, repositories: [REPO_WRITE, REPO_READ] });
    });
    const repos = await listAccessibleRepositories(ACCESS_TOKEN, discoveryFetch);
    expect(repos).toHaveLength(2);
    const byName = Object.fromEntries(repos.map((entry) => [entry.name, entry]));
    expect(byName['notes']).toMatchObject({ canRead: true, canWrite: true, isPrivate: true });
    expect(byName['docs']).toMatchObject({ canRead: true, canWrite: false, isPrivate: false });

    // The same realistic fixtures authorize the writable repository.
    expect(
      await authorize(makeSession(), LOGIN, 'notes', 'write', {
        installations: [INSTALLATION_FULL],
        reposByInstallation: { 111: [REPO_WRITE, REPO_READ] },
      }),
    ).toEqual({ status: 'authorized', owner: LOGIN, repo: 'notes', access: 'write' });
  });

  it('untrusted pagination links still fail without partial success or token leakage', async () => {
    const fetchImpl = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/user/installations' && (url.searchParams.get('page') ?? '1') === '1') {
        return ghJson(
          200,
          { total_count: 2, installations: [INSTALLATION_FULL] },
          { link: '<https://evil.example.net/user/installations?page=2> rel="next"' },
        );
      }
      return ghJson(404, { message: 'Not Found' });
    });
    await expect(
      fetchAllPages('/user/installations', ACCESS_TOKEN, fetchImpl, 'installations'),
    ).rejects.toMatchObject({ code: 'DISCOVERY_LINK_UNTRUSTED' });
    // The untrusted origin is never requested, so the access token never
    // leaves the trusted GitHub API origin.
    const hosts = fetchImpl.mock.calls.map((call) => new URL(call[0] as string).host);
    expect(hosts).toEqual(['api.github.com']);
  });
});
/**
 * Task 3.2 — GitHub App authentication tests.
 *
 * Exercises the full authorization lifecycle over real HTTP on ephemeral
 * ports with every upstream GitHub request mocked via the injectable
 * `fetchImpl` and all databases created under the OS temp dir. A
 * deterministic injected clock keeps expiration tests flake-free.
 *
 * No real GitHub credentials, tokens, or live repositories are used; all
 * credential-shaped values are obviously fake test constants.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../../src/server/index.js';
import { resolveAuthConfig } from '../../../src/server/auth/index.js';
import { PENDING_AUTH_TTL_MS } from '../../../src/server/auth/config.js';

/* ------------------------------------------------------------------ */
/* Test-only credential constants (obviously fake)                    */
/* ------------------------------------------------------------------ */

const CLIENT_ID = 'Iv1.ab1112223334445c'; // GitHub App client ID (alphanumeric; NOT the numeric App ID)
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

const PROFILE = {
  login: 'octo-tester',
  name: 'Octo Tester',
  avatar_url: 'https://avatars.example/octo.png',
};

const DEFAULT_REPOS = [
  {
    owner: { login: 'octo-tester' },
    name: 'notes',
    private: true,
    permissions: { admin: true, push: true, pull: true },
  },
  {
    owner: { login: 'octo-tester' },
    name: 'docs',
    private: false,
    permissions: { admin: false, push: false, pull: true },
  },
  {
    owner: { login: 'ghost' },
    name: 'mystery',
    private: false,
    permissions: { admin: false, push: false, pull: false },
  },
];

const BASE_NOW = 1_750_000_000_000; // fixed deterministic clock start
const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ */
/* Harness: app + temp DB + mock fetch + injected clock               */
/* ------------------------------------------------------------------ */

interface Harness {
  server: Server;
  base: string;
  now: () => number;
  setNow: (t: number) => void;
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

async function createHarness(
  envOverrides: Record<string, string | undefined> = {},
  nowStart = BASE_NOW,
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gitdatnote-auth-'));
  const env: Record<string, string | undefined> = {
    GITHUB_APP_CLIENT_ID: CLIENT_ID,
    GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET,
    GITHUB_OAUTH_CALLBACK_URL: CALLBACK,
    SESSION_ENCRYPTION_KEY: SESSION_KEY,
    SESSION_DB_PATH: join(dir, 'sessions.db'),
    ...envOverrides,
  };
  let current = nowStart;
  const now = () => current;
  const fetchImpl = vi.fn();
  const server = createApp({ env, fetchImpl, now });
  const port = await listen(server);
  const harness: Harness = {
    server,
    base: `http://127.0.0.1:${port}`,
    now,
    setNow: (t: number) => {
      current = t;
    },
    fetchImpl,
    dir,
  };
  harnesses.push(harness);
  // Default GitHub mock so every flow has a working upstream by default;
  // tests that need specific behavior override it via `mockGithub(h, opts)`.
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

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

interface GitHubMockOptions {
  profile?: Record<string, unknown>;
  repos?: unknown;
  installations?: unknown;
  token?: unknown;
  tokenStatus?: number;
  userStatus?: number;
  installationsStatus?: number;
}

function mockGithub(h: Harness, opts: GitHubMockOptions = {}): void {
  const profile = { ...PROFILE, ...opts.profile };
  h.fetchImpl.mockImplementation(async (input: string) => {
    const url = new URL(input);
    if (url.pathname === '/login/oauth/access_token') {
      return json(opts.tokenStatus ?? 200, opts.token ?? TOKEN_RESPONSE);
    }
    if (url.pathname === '/user') {
      return json(opts.userStatus ?? 200, profile);
    }
    if (url.pathname === '/user/installations') {
      return json(
        opts.installationsStatus ?? 200,
        opts.installations ?? [{ id: 111, account: { login: PROFILE.login } }],
      );
    }
    if (
      url.pathname.startsWith('/user/installations/') &&
      url.pathname.endsWith('/repositories')
    ) {
      return json(200, opts.repos ?? DEFAULT_REPOS);
    }
    return json(404, { message: 'Not Found' });
  });
}

interface StartResult {
  location: string;
  state: string;
  challenge: string;
  pendingCookie: string;
}

async function startAuth(h: Harness): Promise<StartResult> {
  const res = await fetch(h.base + '/api/auth/github/start', { redirect: 'manual' });
  expect(res.status).toBe(302);
  const location = res.headers.get('location');
  expect(location).toBeTypeOf('string');
  if (location === null) throw new Error('start did not return a Location header');
  const cookies = res.headers.getSetCookie();
  const pendingCookie = cookies.find((c) => c.startsWith('gitdatnote_pending_auth='));
  expect(pendingCookie).toBeTypeOf('string');
  if (pendingCookie === undefined) throw new Error('start did not set the pending-auth cookie');
  const url = new URL(location);
  const state = url.searchParams.get('state');
  const challenge = url.searchParams.get('code_challenge');
  expect(state).toBeTypeOf('string');
  expect(challenge).toBeTypeOf('string');
  return { location, state: state as string, challenge: challenge as string, pendingCookie: pendingCookie as string };
}

interface CallbackResult {
  status: number;
  location: string | null;
  cookies: string[];
}

async function doCallback(
  h: Harness,
  search: string,
  cookie?: string,
): Promise<CallbackResult> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers.cookie = cookie;
  const res = await fetch(h.base + '/api/auth/github/callback' + search, {
    headers,
    redirect: 'manual',
  });
  return {
    status: res.status,
    location: res.headers.get('location'),
    cookies: res.headers.getSetCookie(),
  };
}

function parseCookie(cookie: string): { name: string; value: string; attrs: Record<string, string> } {
  const [pair, ...rest] = cookie.split(';').map((s) => s.trim());
  const eq = pair.indexOf('=');
  const name = pair.slice(0, eq);
  const value = pair.slice(eq + 1);
  const attrs: Record<string, string> = {};
  for (const attr of rest) {
    const i = attr.indexOf('=');
    if (i === -1) attrs[attr] = '';
    else attrs[attr.slice(0, i)] = attr.slice(i + 1);
  }
  return { name, value, attrs };
}

async function sessionWithCookie(
  h: Harness,
  cookie: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(h.base + '/api/session', {
    headers: { cookie },
  });
  return { status: res.status, body: await res.json() };
}

interface SigninResult {
  sessionCookie: string;
  sessionCookieValue: string;
  state: string;
  challenge: string;
}

/** Start + valid callback; returns the issued session cookie. */
async function completeSignin(
  h: Harness,
  opts: GitHubMockOptions = {},
): Promise<SigninResult> {
  mockGithub(h, opts);
  const start = await startAuth(h);
  const cb = await doCallback(h, `?code=${AUTH_CODE}&state=${start.state}`, start.pendingCookie);
  expect(cb.status).toBe(302);
  expect(cb.location).toBe('/');
  const sessionCookie = cb.cookies.find((c) => c.startsWith('gitdatnote_session='));
  expect(sessionCookie).toBeTypeOf('string');
  // The pending binding cookie must be cleared on success.
  const pending = cb.cookies.find((c) => c.startsWith('gitdatnote_pending_auth='));
  expect(pending).toBeDefined();
  const pendingParsed = parseCookie(pending as string);
  expect(pendingParsed.value).toBe('');
  expect(pendingParsed.attrs['Max-Age']).toBe('0');
  const parsed = parseCookie(sessionCookie as string);
  return {
    sessionCookie: sessionCookie as string,
    sessionCookieValue: parsed.value,
    state: start.state,
    challenge: start.challenge,
  };
}

/* ------------------------------------------------------------------ */
/* resolveAuthConfig                                                   */
/* ------------------------------------------------------------------ */

describe('resolveAuthConfig', () => {
  const base = {
    GITHUB_APP_CLIENT_ID: CLIENT_ID,
    GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET,
    GITHUB_OAUTH_CALLBACK_URL: CALLBACK,
  };

  it('accepts a valid configuration', () => {
    const result = resolveAuthConfig(base);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.config.clientId).toBe(CLIENT_ID);
      expect(result.config.clientSecret).toBe(CLIENT_SECRET);
      expect(result.config.callbackUrl).toBe(CALLBACK);
    }
  });

  it('rejects a missing client id', () => {
    const rest: Record<string, string> = { ...base };
    delete rest.GITHUB_APP_CLIENT_ID;
    expect(resolveAuthConfig(rest)).toEqual({
      status: 'unconfigured',
      reason: 'missing_client_id',
    });
  });

  it('accepts valid GitHub App client IDs (alphanumeric, not the numeric App ID)', () => {
    for (const id of ['Iv1.ab1112223334445c', 'Iv23f8doAlphaNumer1c']) {
      const result = resolveAuthConfig({ ...base, GITHUB_APP_CLIENT_ID: id });
      expect(result.status).toBe('ok');
    }
  });

  it('rejects numeric App IDs, malformed, and over-long client ids', () => {
    // Purely numeric values are GitHub App IDs, not App client IDs.
    expect(
      resolveAuthConfig({ ...base, GITHUB_APP_CLIENT_ID: '1234567890' }),
    ).toEqual({ status: 'unconfigured', reason: 'invalid_client_id' });
    // Wrong prefix casing.
    expect(
      resolveAuthConfig({ ...base, GITHUB_APP_CLIENT_ID: 'iv1.ab1112223334445c' }),
    ).toEqual({ status: 'unconfigured', reason: 'invalid_client_id' });
    // Too short after the prefix.
    expect(
      resolveAuthConfig({ ...base, GITHUB_APP_CLIENT_ID: 'Iv12345' }),
    ).toEqual({ status: 'unconfigured', reason: 'invalid_client_id' });
    // Over-long dotted form (41 chars after the dot).
    expect(
      resolveAuthConfig({ ...base, GITHUB_APP_CLIENT_ID: 'Iv1.' + 'a'.repeat(41) }),
    ).toEqual({ status: 'unconfigured', reason: 'invalid_client_id' });
    // Over-long plain form (41 alphanumerics after the prefix).
    expect(
      resolveAuthConfig({ ...base, GITHUB_APP_CLIENT_ID: 'Iv' + 'a'.repeat(41) }),
    ).toEqual({ status: 'unconfigured', reason: 'invalid_client_id' });
    // Garbage trailing character on a numeric App ID.
    expect(
      resolveAuthConfig({ ...base, GITHUB_APP_CLIENT_ID: '123456789012345678901a' }),
    ).toEqual({ status: 'unconfigured', reason: 'invalid_client_id' });
    expect(
      resolveAuthConfig({ ...base, GITHUB_APP_CLIENT_ID: '' }),
    ).toEqual({ status: 'unconfigured', reason: 'missing_client_id' });
  });

  it('rejects a missing client secret', () => {
    const rest: Record<string, string> = { ...base };
    delete rest.GITHUB_APP_CLIENT_SECRET;
    expect(resolveAuthConfig(rest)).toEqual({
      status: 'unconfigured',
      reason: 'missing_client_secret',
    });
  });

  it('rejects a client secret containing whitespace', () => {
    expect(
      resolveAuthConfig({ ...base, GITHUB_APP_CLIENT_SECRET: 'secret with a space' }),
    ).toEqual({ status: 'unconfigured', reason: 'invalid_client_secret' });
  });

  it('rejects a callback URL with a query string or fragment', () => {
    expect(
      resolveAuthConfig({ ...base, GITHUB_OAUTH_CALLBACK_URL: 'https://example.com/cb?x=1' }),
    ).toEqual({ status: 'unconfigured', reason: 'invalid_callback_url' });
    expect(
      resolveAuthConfig({ ...base, GITHUB_OAUTH_CALLBACK_URL: 'https://example.com/cb#frag' }),
    ).toEqual({ status: 'unconfigured', reason: 'invalid_callback_url' });
  });

  it('rejects a callback URL with userinfo or a non-HTTP scheme', () => {
    expect(
      resolveAuthConfig({ ...base, GITHUB_OAUTH_CALLBACK_URL: 'https://user@example.com/cb' }),
    ).toEqual({ status: 'unconfigured', reason: 'invalid_callback_url' });
    expect(
      resolveAuthConfig({ ...base, GITHUB_OAUTH_CALLBACK_URL: 'ftp://example.com/cb' }),
    ).toEqual({ status: 'unconfigured', reason: 'invalid_callback_url' });
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/auth/github/start                                          */
/* ------------------------------------------------------------------ */

describe('GET /api/auth/github/start', () => {
  it('redirects to GitHub with client_id, callback, state, offline_access, and PKCE S256', async () => {
    const h = await createHarness();
    const start = await startAuth(h);
    const url = new URL(start.location);
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(url.searchParams.get('scope')).toBe('offline_access');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(start.state);
    expect(start.state).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get('code_challenge')).toBe(start.challenge);
    expect(start.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    await closeHarness(h);
  });

  it('binds the pending state to the browser with a secure short-lived cookie', async () => {
    const h = await createHarness();
    const start = await startAuth(h);
    const cookie = parseCookie(start.pendingCookie);
    expect(cookie.name).toBe('gitdatnote_pending_auth');
    expect(cookie.value).toBe(start.state); // binding: cookie value === URL state
    expect(cookie.attrs.HttpOnly).toBe('');
    expect(cookie.attrs['SameSite']).toBe('Lax');
    expect(cookie.attrs['Path']).toBe('/');
    expect(cookie.attrs['Max-Age']).toBe('600');
    expect(cookie.attrs['Secure']).toBeUndefined(); // not in development mode
    await closeHarness(h);
  });

  it('generates a distinct state for each start', async () => {
    const h = await createHarness();
    const first = await startAuth(h);
    const second = await startAuth(h);
    expect(first.state).not.toBe(second.state);
    expect(second.state).toMatch(/^[0-9a-f]{64}$/);
    await closeHarness(h);
  });

  it('fails safely with a fixed error destination when configuration is missing', async () => {
    const h = await createHarness({ GITHUB_APP_CLIENT_ID: undefined });
    const res = await fetch(h.base + '/api/auth/github/start', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/error?reason=auth_unconfigured');
    expect(h.fetchImpl).not.toHaveBeenCalled();
    await closeHarness(h);
  });

  it('never logs the state, the secret, or the binding cookie', async () => {
    const h = await createHarness();
    const start = await startAuth(h);
    const logs = allLogs().join('\n');
    expect(logs).not.toContain(start.state);
    expect(logs).not.toContain(CLIENT_SECRET);
    expect(logs).not.toContain(start.pendingCookie);
    await closeHarness(h);
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/auth/github/callback                                       */
/* ------------------------------------------------------------------ */

describe('GET /api/auth/github/callback', () => {
  it('completes sign-in: PKCE token exchange, profile fetch, encrypted session, fixed redirect', async () => {
    const h = await createHarness();
    const { sessionCookie, sessionCookieValue, state, challenge } = await completeSignin(h);
    void state;

    // Token exchange used the stored verifier (PKCE round trip) and
    // server-side client credentials.
    const tokenCall = h.fetchImpl.mock.calls.find(
      (c) => new URL(c[0] as string).pathname === '/login/oauth/access_token',
    );
    expect(tokenCall).toBeDefined();
    const tokenBody = JSON.parse((tokenCall![1] as RequestInit).body as string) as Record<
      string,
      string
    >;
    expect(tokenBody.client_id).toBe(CLIENT_ID);
    expect(tokenBody.client_secret).toBe(CLIENT_SECRET);
    expect(tokenBody.code).toBe(AUTH_CODE);
    expect(tokenBody.redirect_uri).toBe(CALLBACK);
    expect(typeof tokenBody.code_verifier).toBe('string');
    expect(tokenBody.code_verifier.length).toBeGreaterThanOrEqual(43);
    const computedChallenge = createHash('sha256')
      .update(tokenBody.code_verifier)
      .digest('base64url');
    expect(computedChallenge).toBe(challenge);

    // Session cookie: 64 hex id, secure attributes, path root.
    const cookie = parseCookie(sessionCookie);
    expect(cookie.value).toMatch(/^[0-9a-f]{64}$/);
    expect(cookie.attrs.HttpOnly).toBe('');
    expect(cookie.attrs['SameSite']).toBe('Lax');
    expect(cookie.attrs['Path']).toBe('/');
    expect(cookie.attrs['Max-Age']).toBe('604800'); // 7 days

    // Session endpoint reports identity + CSRF token, no credentials.
    const session = await sessionWithCookie(h, `gitdatnote_session=${sessionCookieValue}`);
    expect(session.status).toBe(200);
    const body = session.body as Record<string, unknown>;
    expect(body.connected).toBe(true);
    expect(body.user).toEqual({
      login: PROFILE.login,
      name: PROFILE.name,
      avatarUrl: PROFILE.avatar_url,
    });
    expect(typeof body.csrfToken).toBe('string');
    expect((body.csrfToken as string).length).toBe(64);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain(REFRESH_TOKEN);
    expect(serialized).not.toContain(AUTH_CODE);
    expect(serialized).not.toContain(state);
    await closeHarness(h);
  });

  it('falls back to the login handle when the GitHub name is null', async () => {
    const h = await createHarness();
    const { sessionCookie } = await completeSignin(h, {
      profile: { ...PROFILE, name: null },
    });
    const session = await sessionWithCookie(h, sessionCookie);
    const body = session.body as Record<string, unknown>;
    expect(body.connected).toBe(true);
    expect((body.user as Record<string, unknown>).name).toBe(PROFILE.login);
    await closeHarness(h);
  });

  it('rejects consent denial with a safe fixed reason', async () => {
    const h = await createHarness();
    const start = await startAuth(h);
    const cb = await doCallback(
      h,
      `?error=access_denied&state=${start.state}`,
      start.pendingCookie,
    );
    expect(cb.status).toBe(302);
    expect(cb.location).toBe('/error?reason=consent_denied');
    expect(h.fetchImpl).not.toHaveBeenCalled();
    await closeHarness(h);
  });

  it('rejects a missing code', async () => {
    const h = await createHarness();
    const start = await startAuth(h);
    const cb = await doCallback(h, `?state=${start.state}`, start.pendingCookie);
    expect(cb.location).toBe('/error?reason=state_invalid');
    await closeHarness(h);
  });

  it('rejects a malformed state', async () => {
    const h = await createHarness();
    const cb = await doCallback(h, '?code=x&state=short-state');
    expect(cb.location).toBe('/error?reason=state_invalid');
    await closeHarness(h);
  });

  it('rejects a callback without the pending-auth cookie (no browser binding)', async () => {
    const h = await createHarness();
    const start = await startAuth(h);
    const cb = await doCallback(h, `?code=${AUTH_CODE}&state=${start.state}`);
    expect(cb.location).toBe('/error?reason=state_invalid');
    expect(h.fetchImpl).not.toHaveBeenCalled();
    await closeHarness(h);
  });

  it('rejects a swapped cookie state (authorization-response swapping)', async () => {
    const h = await createHarness();
    const start = await startAuth(h);
    // A different browser (different binding cookie) presents this state.
    const cb = await doCallback(
      h,
      `?code=${AUTH_CODE}&state=${start.state}`,
      'gitdatnote_pending_auth=' + 'f'.repeat(64),
    );
    expect(cb.location).toBe('/error?reason=state_invalid');
    expect(h.fetchImpl).not.toHaveBeenCalled();
    await closeHarness(h);
  });

  it('rejects an expired pending state', async () => {
    const h = await createHarness();
    const start = await startAuth(h);
    h.setNow(h.now() + PENDING_AUTH_TTL_MS + 1);
    const cb = await doCallback(h, `?code=${AUTH_CODE}&state=${start.state}`, start.pendingCookie);
    expect(cb.location).toBe('/error?reason=state_expired');
    expect(h.fetchImpl).not.toHaveBeenCalled();
    await closeHarness(h);
  });

  it('rejects state replay after a successful callback', async () => {
    const h = await createHarness();
    mockGithub(h);
    const start = await startAuth(h);
    const first = await doCallback(h, `?code=${AUTH_CODE}&state=${start.state}`, start.pendingCookie);
    expect(first.location).toBe('/');
    const callsAfterFirst = h.fetchImpl.mock.calls.length;
    const second = await doCallback(h, `?code=${AUTH_CODE}&state=${start.state}`, start.pendingCookie);
    expect(second.location).toBe('/error?reason=state_replayed');
    // No second token exchange happened.
    expect(h.fetchImpl.mock.calls.length).toBe(callsAfterFirst);
    await closeHarness(h);
  });

  it('consumes the state even when the token exchange fails (no retry replay)', async () => {
    const h = await createHarness();
    mockGithub(h, { tokenStatus: 401 });
    const start = await startAuth(h);
    const first = await doCallback(h, `?code=${AUTH_CODE}&state=${start.state}`, start.pendingCookie);
    expect(first.location).toBe('/error?reason=token_error');
    const second = await doCallback(h, `?code=${AUTH_CODE}&state=${start.state}`, start.pendingCookie);
    expect(second.location).toBe('/error?reason=state_replayed');
    // The failed exchange must not have created any session.
    const tokenCalls = h.fetchImpl.mock.calls.filter(
      (c) => new URL(c[0] as string).pathname === '/login/oauth/access_token',
    );
    expect(tokenCalls.length).toBe(1);
    await closeHarness(h);
  });

  it('rejects a failed token exchange (401) without creating a session', async () => {
    const h = await createHarness();
    mockGithub(h, { tokenStatus: 401 });
    const start = await startAuth(h);
    const cb = await doCallback(h, `?code=${AUTH_CODE}&state=${start.state}`, start.pendingCookie);
    expect(cb.location).toBe('/error?reason=token_error');
    const sessionCookies = cb.cookies.filter((c) => c.startsWith('gitdatnote_session='));
    expect(sessionCookies.length).toBe(0);
    await closeHarness(h);
  });

  it('rejects a token response missing the refresh token', async () => {
    const h = await createHarness();
    const partial: Record<string, string | number> = { ...TOKEN_RESPONSE };
    delete partial.refresh_token;
    mockGithub(h, { token: partial });
    const start = await startAuth(h);
    const cb = await doCallback(h, `?code=${AUTH_CODE}&state=${start.state}`, start.pendingCookie);
    expect(cb.location).toBe('/error?reason=token_error');
    await closeHarness(h);
  });

  it('rejects a token response missing the access-token lifetime', async () => {
    const h = await createHarness();
    const partial: Record<string, string | number> = { ...TOKEN_RESPONSE };
    delete partial.expires_in;
    mockGithub(h, { token: partial });
    const start = await startAuth(h);
    const cb = await doCallback(h, `?code=${AUTH_CODE}&state=${start.state}`, start.pendingCookie);
    expect(cb.location).toBe('/error?reason=token_error');
    await closeHarness(h);
  });

  it('rejects a non-JSON token response', async () => {
    const h = await createHarness();
    h.fetchImpl.mockImplementation(async (input: string) => {
      if (new URL(input).pathname === '/login/oauth/access_token') {
        return new Response('not json at all', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      return json(200, {});
    });
    const start = await startAuth(h);
    const cb = await doCallback(h, `?code=${AUTH_CODE}&state=${start.state}`, start.pendingCookie);
    expect(cb.location).toBe('/error?reason=token_error');
    await closeHarness(h);
  });

  it('rejects a profile fetch failure (404) as profile_error', async () => {
    const h = await createHarness();
    mockGithub(h, { userStatus: 404 });
    const start = await startAuth(h);
    const cb = await doCallback(h, `?code=${AUTH_CODE}&state=${start.state}`, start.pendingCookie);
    expect(cb.location).toBe('/error?reason=profile_error');
    await closeHarness(h);
  });

  it('maps a GitHub 500 to github_unavailable', async () => {
    const h = await createHarness();
    mockGithub(h, { userStatus: 500 });
    const start = await startAuth(h);
    const cb = await doCallback(h, `?code=${AUTH_CODE}&state=${start.state}`, start.pendingCookie);
    expect(cb.location).toBe('/error?reason=github_unavailable');
    await closeHarness(h);
  });

  it('rejects a profile without a login handle', async () => {
    const h = await createHarness();
    mockGithub(h, { profile: { login: undefined, name: 'No Login', avatar_url: 'x' } });
    const start = await startAuth(h);
    const cb = await doCallback(h, `?code=${AUTH_CODE}&state=${start.state}`, start.pendingCookie);
    expect(cb.location).toBe('/error?reason=profile_error');
    await closeHarness(h);
  });

  it('never logs tokens, codes, state, or secrets; the callback log line has no query string', async () => {
    const h = await createHarness();
    const { state } = await completeSignin(h);
    const logs = allLogs().join('\n');
    expect(logs).not.toContain(ACCESS_TOKEN);
    expect(logs).not.toContain(REFRESH_TOKEN);
    expect(logs).not.toContain(AUTH_CODE);
    expect(logs).not.toContain(state);
    expect(logs).not.toContain(CLIENT_SECRET);
    const callbackLine = allLogs().find((l) => l.includes('/api/auth/github/callback'));
    expect(callbackLine).toBeDefined();
    expect(callbackLine).not.toContain('?');
    await closeHarness(h);
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/session                                                    */
/* ------------------------------------------------------------------ */

describe('GET /api/session', () => {
  it('returns a consistent disconnected response without a cookie', async () => {
    const h = await createHarness();
    const res = await fetch(h.base + '/api/session');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
    await closeHarness(h);
  });

  it('treats a malformed session cookie as disconnected', async () => {
    const h = await createHarness();
    const res = await fetch(h.base + '/api/session', {
      headers: { cookie: 'gitdatnote_session=not-a-valid-session-id' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
    await closeHarness(h);
  });

  it('treats an expired session as disconnected', async () => {
    const h = await createHarness();
    const { sessionCookie } = await completeSignin(h);
    h.setNow(h.now() + 7 * DAY_MS + 1000);
    const session = await sessionWithCookie(h, sessionCookie);
    expect(session.body).toEqual({ connected: false });
    await closeHarness(h);
  });
});

/* ------------------------------------------------------------------ */
/* POST /api/auth/logout                                               */
/* ------------------------------------------------------------------ */

describe('POST /api/auth/logout', () => {
  it('rejects logout without an authenticated session (401)', async () => {
    const h = await createHarness();
    const res = await fetch(h.base + '/api/auth/logout', { method: 'POST' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('UNAUTHORIZED');
    await closeHarness(h);
  });

  it('rejects logout without a CSRF header (403) and keeps the session valid', async () => {
    const h = await createHarness();
    const { sessionCookie } = await completeSignin(h);
    const res = await fetch(h.base + '/api/auth/logout', {
      method: 'POST',
      headers: { cookie: sessionCookie },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('CSRF_INVALID');
    const session = await sessionWithCookie(h, sessionCookie);
    expect((session.body as Record<string, unknown>).connected).toBe(true);
    await closeHarness(h);
  });

  it('rejects an invalid CSRF token (403) and keeps the session valid', async () => {
    const h = await createHarness();
    const { sessionCookie } = await completeSignin(h);
    const res = await fetch(h.base + '/api/auth/logout', {
      method: 'POST',
      headers: {
        cookie: sessionCookie,
        'X-CSRF-Token': 'f'.repeat(64),
      },
    });
    expect(res.status).toBe(403);
    const session = await sessionWithCookie(h, sessionCookie);
    expect((session.body as Record<string, unknown>).connected).toBe(true);
    await closeHarness(h);
  });

  it('does not accept the CSRF token from a query parameter', async () => {
    const h = await createHarness();
    const { sessionCookie } = await completeSignin(h);
    const session = await sessionWithCookie(h, sessionCookie);
    const csrf = (session.body as Record<string, unknown>).csrfToken as string;
    const res = await fetch(h.base + `/api/auth/logout?token=${csrf}`, {
      method: 'POST',
      headers: { cookie: sessionCookie },
    });
    expect(res.status).toBe(403);
    const after = await sessionWithCookie(h, sessionCookie);
    expect((after.body as Record<string, unknown>).connected).toBe(true);
    await closeHarness(h);
  });

  it('deletes the session and clears the cookie with a valid CSRF token (204)', async () => {
    const h = await createHarness();
    const { sessionCookie } = await completeSignin(h);
    const session = await sessionWithCookie(h, sessionCookie);
    const csrf = (session.body as Record<string, unknown>).csrfToken as string;
    const res = await fetch(h.base + '/api/auth/logout', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'X-CSRF-Token': csrf },
    });
    expect(res.status).toBe(204);
    const cleared = res.headers.getSetCookie().find((c) => c.startsWith('gitdatnote_session='));
    expect(cleared).toBeDefined();
    expect(parseCookie(cleared as string).value).toBe('');
    expect(parseCookie(cleared as string).attrs['Max-Age']).toBe('0');
    const after = await sessionWithCookie(h, sessionCookie);
    expect(after.body).toEqual({ connected: false });
    await closeHarness(h);
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/repositories                                               */
/* ------------------------------------------------------------------ */

describe('GET /api/repositories', () => {
  it('requires authentication (401 without a session)', async () => {
    const h = await createHarness();
    const res = await fetch(h.base + '/api/repositories');
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('UNAUTHORIZED');
    expect(h.fetchImpl).not.toHaveBeenCalled();
    await closeHarness(h);
  });

  it('rejects an expired session (401)', async () => {
    const h = await createHarness();
    const { sessionCookie } = await completeSignin(h);
    h.setNow(h.now() + 7 * DAY_MS + 1000);
    h.fetchImpl.mockClear();
    const res = await fetch(h.base + '/api/repositories', {
      headers: { cookie: sessionCookie },
    });
    expect(res.status).toBe(401);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    await closeHarness(h);
  });

  it('returns truthful permissions with the default content root', async () => {
    const h = await createHarness();
    const { sessionCookie } = await completeSignin(h);
    const res = await fetch(h.base + '/api/repositories', {
      headers: { cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(3);
    const byName = Object.fromEntries(body.map((r) => [r.name as string, r]));
    expect(byName['notes']).toEqual({
      owner: 'octo-tester',
      name: 'notes',
      contentRoot: 'src/posts',
      canRead: true,
      canWrite: true,
      private: true,
    });
    expect(byName['docs']).toEqual({
      owner: 'octo-tester',
      name: 'docs',
      contentRoot: 'src/posts',
      canRead: true,
      canWrite: false,
      private: false,
    });
    // List membership never implies write access.
    expect(byName['mystery']).toEqual({
      owner: 'ghost',
      name: 'mystery',
      contentRoot: 'src/posts',
      canRead: false,
      canWrite: false,
      private: false,
    });
    await closeHarness(h);
  });

  it('uses the session access token, never an app-wide privileged token', async () => {
    const h = await createHarness();
    const { sessionCookie } = await completeSignin(h);
    await fetch(h.base + '/api/repositories', {
      headers: { cookie: sessionCookie },
    });
    expect(h.fetchImpl).toHaveBeenCalled();
    for (const call of h.fetchImpl.mock.calls) {
      const url = new URL(call[0] as string);
      if (url.hostname === 'api.github.com') {
        const headers = (call[1] as RequestInit).headers as Record<string, string>;
        expect(headers['Authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
        expect(headers['User-Agent']).toBe('GitDatNote/2.0');
      }
    }
    await closeHarness(h);
  });

  it('dedupes repositories across installations', async () => {
    const h = await createHarness();
    mockGithub(h, {
      installations: [
        { id: 1, account: { login: 'a' } },
        { id: 2, account: { login: 'b' } },
      ],
    });
    const { sessionCookie } = await completeSignin(h);
    const res = await fetch(h.base + '/api/repositories', {
      headers: { cookie: sessionCookie },
    });
    const body = (await res.json()) as Array<Record<string, unknown>>;
    // Both installations list the same repos; the first occurrence wins.
    expect(body.map((r) => `${r.owner}/${r.name}`)).toEqual([
      'octo-tester/notes',
      'octo-tester/docs',
      'ghost/mystery',
    ]);
    await closeHarness(h);
  });

  it('returns an empty list when the user has no installations', async () => {
    const h = await createHarness();
    const { sessionCookie } = await completeSignin(h, { installations: [] });
    const res = await fetch(h.base + '/api/repositories', {
      headers: { cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    await closeHarness(h);
  });

  it('skips malformed repository entries', async () => {
    const h = await createHarness();
    const { sessionCookie } = await completeSignin(h, {
      repos: [
        null,
        { name: 'no-owner' },
        { owner: { login: '' }, name: 'empty-owner' },
        {
          owner: { login: 'octo-tester' },
          name: 'ok-repo',
          private: false,
          permissions: { pull: true, push: true },
        },
      ],
    });
    const res = await fetch(h.base + '/api/repositories', {
      headers: { cookie: sessionCookie },
    });
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('ok-repo');
    expect(body[0].canRead).toBe(true);
    expect(body[0].canWrite).toBe(true);
    await closeHarness(h);
  });

  it('maps a rate-limited GitHub response to 429 RATE_LIMITED', async () => {
    const h = await createHarness();
    const { sessionCookie } = await completeSignin(h, { installationsStatus: 429 });
    const res = await fetch(h.base + '/api/repositories', {
      headers: { cookie: sessionCookie },
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('RATE_LIMITED');
    await closeHarness(h);
  });

  it('maps a GitHub 500 to 502 GITHUB_UNAVAILABLE', async () => {
    const h = await createHarness();
    const { sessionCookie } = await completeSignin(h, { installationsStatus: 500 });
    const res = await fetch(h.base + '/api/repositories', {
      headers: { cookie: sessionCookie },
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('GITHUB_UNAVAILABLE');
    await closeHarness(h);
  });

  it('discovers repositories across multiple pages of both list endpoints', async () => {
    const h = await createHarness();
    const { sessionCookie } = await completeSignin(h);
    h.fetchImpl.mockClear();
    h.fetchImpl.mockImplementation(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/user/installations') {
        const page = Number(url.searchParams.get('page') ?? '1');
        if (page === 1) {
          return json(200, [{ id: 111, account: { login: 'a' } }], {
            link: '<https://api.github.com/user/installations?per_page=100&page=2> rel="next"',
          });
        }
        return json(200, [{ id: 222, account: { login: 'b' } }]);
      }
      if (url.pathname === '/user/installations/111/repositories') {
        return json(200, DEFAULT_REPOS);
      }
      if (url.pathname === '/user/installations/222/repositories') {
        return json(200, [
          {
            owner: { login: 'octo-tester' },
            name: 'more-notes',
            private: false,
            permissions: { pull: true, push: false },
          },
        ]);
      }
      return json(404, { message: 'Not Found' });
    });
    const res = await fetch(h.base + '/api/repositories', {
      headers: { cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    // Complete list from both installations, in order, deduplicated.
    expect(body.map((r) => `${r.owner}/${r.name}`)).toEqual([
      'octo-tester/notes',
      'octo-tester/docs',
      'ghost/mystery',
      'octo-tester/more-notes',
    ]);
    await closeHarness(h);
  });

  it('fails safely on a cross-origin pagination Link (no partial list, no token to the untrusted origin)', async () => {
    const h = await createHarness();
    const { sessionCookie } = await completeSignin(h);
    h.fetchImpl.mockClear();
    h.fetchImpl.mockImplementation(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/user/installations') {
        return json(200, [{ id: 111, account: { login: 'a' } }], {
          link: '<https://evil.example/user/installations?per_page=100&page=2> rel="next"',
        });
      }
      if (url.pathname === '/user/installations/111/repositories') {
        return json(200, DEFAULT_REPOS);
      }
      return json(404, { message: 'Not Found' });
    });
    const res = await fetch(h.base + '/api/repositories', {
      headers: { cookie: sessionCookie },
    });
    // 1) Discovery fails with the safe API error — never a 200 with a
    //    partially discovered repository list.
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body).not.toHaveProperty('repositories');
    // 2) No request is ever sent to the untrusted origin, so 3) the bearer
    //    token is never transmitted there: only the initial, trusted
    //    request left the process.
    expect(h.fetchImpl.mock.calls).toHaveLength(1);
    for (const call of h.fetchImpl.mock.calls) {
      const called = new URL(call[0] as string);
      expect(called.origin).toBe('https://api.github.com');
      expect(called.hostname).not.toBe('evil.example');
    }
    await closeHarness(h);
  });

  it('fails safely on a non-HTTPS pagination Link', async () => {
    const h = await createHarness();
    const { sessionCookie } = await completeSignin(h);
    h.fetchImpl.mockClear();
    h.fetchImpl.mockImplementation(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/user/installations') {
        return json(200, [{ id: 111, account: { login: 'a' } }], {
          link: '<http://api.github.com/user/installations?per_page=100&page=2> rel="next"',
        });
      }
      if (url.pathname === '/user/installations/111/repositories') {
        return json(200, DEFAULT_REPOS);
      }
      return json(404, { message: 'Not Found' });
    });
    const res = await fetch(h.base + '/api/repositories', {
      headers: { cookie: sessionCookie },
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(h.fetchImpl.mock.calls).toHaveLength(1);
    expect(new URL(h.fetchImpl.mock.calls[0][0] as string).origin).toBe('https://api.github.com');
    await closeHarness(h);
  });

  it('fails safely on a malformed pagination Link', async () => {
    const h = await createHarness();
    const { sessionCookie } = await completeSignin(h);
    h.fetchImpl.mockClear();
    h.fetchImpl.mockImplementation(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/user/installations') {
        return json(200, [{ id: 111, account: { login: 'a' } }], {
          link: '<not a valid url> rel="next"',
        });
      }
      if (url.pathname === '/user/installations/111/repositories') {
        return json(200, DEFAULT_REPOS);
      }
      return json(404, { message: 'Not Found' });
    });
    const res = await fetch(h.base + '/api/repositories', {
      headers: { cookie: sessionCookie },
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(h.fetchImpl.mock.calls).toHaveLength(1);
    await closeHarness(h);
  });

  it('fails loudly (never a silent partial list) when the pagination safety limit is exceeded', async () => {
    const h = await createHarness();
    const { sessionCookie } = await completeSignin(h);
    h.fetchImpl.mockClear();
    h.fetchImpl.mockImplementation(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/user/installations') {
        const page = Number(url.searchParams.get('page') ?? '1');
        // Always advertise another page: the safety limit is exceeded.
        return json(
          200,
          [{ id: page, account: { login: 'a' } }],
          { link: `<https://api.github.com/user/installations?per_page=100&page=${page + 1}> rel="next"` },
        );
      }
      return json(404, { message: 'Not Found' });
    });
    const res = await fetch(h.base + '/api/repositories', {
      headers: { cookie: sessionCookie },
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('INTERNAL_ERROR');
    await closeHarness(h);
  });
});

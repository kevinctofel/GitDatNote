/**
 * Task 3.3 — centralized CSRF protection tests.
 *
 * Part A exercises the middleware in isolation (no HTTP server): token
 * format gates, header carriers, constant-time comparison, failure
 * outcomes, and logging rules.
 *
 * Part B exercises the security boundary over real HTTP on ephemeral
 * ports with every upstream GitHub request mocked via the injectable
 * `fetchImpl`, temp SQLite databases, and a deterministic injected clock.
 * No real GitHub credentials, tokens, or live repositories are used.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import {
  CSRF_HEADER_NAME,
  checkCsrf,
  constantTimeTokenMatch,
  isValidCsrfToken,
  readCsrfHeader,
  respondToCsrf,
} from '../../../src/server/middleware/csrf.js';
import type { Logger, LogPayload } from '../../../src/server/middleware/logging.js';
import { createApp } from '../../../src/server/index.js';
import { SessionStorageError } from '../../../src/server/session/types.js';
import type {
  SessionLookupResult,
  SessionStorage,
  StoredSession,
} from '../../../src/server/session/types.js';

/* ------------------------------------------------------------------ */
/* Part A — middleware unit tests (no HTTP server)                     */
/* ------------------------------------------------------------------ */

const VALID_TOKEN = 'ab'.repeat(32);
const OTHER_TOKEN = 'cd'.repeat(32);
const SESSION_ID = 'aa'.repeat(32);

function storedSession(token: string = VALID_TOKEN, id: string = SESSION_ID): StoredSession {
  return {
    sessionId: id,
    user: { login: 'octo-tester', name: 'Octo Tester', avatarUrl: 'https://avatars.example/octo.png' },
    createdAt: 1_750_000_000_000,
    expiresAt: 1_750_000_000_000 + 7 * 86_400_000,
    csrfToken: token,
    credentials: {
      accessToken: 'ghu_test_access_token_value',
      refreshToken: 'ghr_test_refresh_token_value',
      tokenExpiresAt: 1_750_000_000_000 + 28_800_000,
      refreshExpiresAt: 1_750_000_000_000 + 15_897_600_000,
    },
  };
}

function storageFor(getSession: (id: string) => SessionLookupResult): SessionStorage {
  return {
    getSession: (id: string) => getSession(id),
    createSession: () => {
      throw new Error('not used in these tests');
    },
    rotateCredentials: () => undefined,
    deleteSession: () => false,
    purgeExpiredSessions: () => 0,
    close: () => {},
  };
}

function reqWith(headers: Record<string, string | string[]> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function loggedEvents(): { logger: Logger; events: string[] } {
  const events: string[] = [];
  const logger: Logger = {
    level: 'error',
    debug: () => {},
    info: () => {},
    warn: (p: LogPayload) => {
      events.push(JSON.stringify(p));
    },
    error: (p: LogPayload) => {
      events.push(JSON.stringify(p));
    },
  };
  return { logger, events };
}

function foundStorage(token: string = VALID_TOKEN) {
  return {
    storage: storageFor(() => ({ status: 'found', session: storedSession(token) })),
    ...loggedEvents(),
  };
}

describe('readCsrfHeader', () => {
  it('reads the single header value', () => {
    expect(readCsrfHeader(reqWith({ [CSRF_HEADER_NAME]: VALID_TOKEN }))).toBe(VALID_TOKEN);
  });

  it('accepts exactly one value in a raw header array', () => {
    expect(readCsrfHeader(reqWith({ [CSRF_HEADER_NAME]: [VALID_TOKEN] }))).toBe(VALID_TOKEN);
  });

  it('rejects duplicate (multi-value) header arrays', () => {
    expect(readCsrfHeader(reqWith({ [CSRF_HEADER_NAME]: [VALID_TOKEN, OTHER_TOKEN] }))).toBeNull();
  });

  it('returns null for a missing header', () => {
    expect(readCsrfHeader(reqWith({}))).toBeNull();
  });
});

describe('isValidCsrfToken', () => {
  it('accepts exactly 64 lowercase hex characters', () => {
    expect(isValidCsrfToken(VALID_TOKEN)).toBe(true);
  });

  it.each([
    ['empty string', ''],
    ['63 characters', VALID_TOKEN.slice(0, 63)],
    ['65 characters', VALID_TOKEN + '0'],
    ['uppercase hex', VALID_TOKEN.toUpperCase()],
    ['non-hex characters', 'z'.repeat(64)],
    ['embedded whitespace', `${VALID_TOKEN.slice(0, 10)} ${VALID_TOKEN.slice(10)}`.slice(0, 64)],
  ])('rejects %s', (_label, token) => {
    expect(isValidCsrfToken(token)).toBe(false);
  });
});

describe('constantTimeTokenMatch', () => {
  it('matches equal valid tokens', () => {
    expect(constantTimeTokenMatch(VALID_TOKEN, VALID_TOKEN)).toBe(true);
  });

  it('rejects same-length different tokens', () => {
    expect(constantTimeTokenMatch(VALID_TOKEN, OTHER_TOKEN)).toBe(false);
  });

  it('rejects malformed operands without throwing', () => {
    expect(constantTimeTokenMatch('', VALID_TOKEN)).toBe(false);
    expect(constantTimeTokenMatch(VALID_TOKEN.slice(0, 63), VALID_TOKEN)).toBe(false);
    expect(constantTimeTokenMatch(VALID_TOKEN.toUpperCase(), VALID_TOKEN)).toBe(false);
  });
});

describe('checkCsrf', () => {
  it('accepts a valid session with a matching header', () => {
    const { storage, logger } = foundStorage();
    const cookie = `gitdatnote_session=${SESSION_ID}`;
    const result = checkCsrf(reqWith({ cookie, [CSRF_HEADER_NAME]: VALID_TOKEN }), storage, logger);
    expect(result).toEqual({ status: 'ok', sessionId: SESSION_ID });
  });

  it('accepts a single-value header array with a matching token', () => {
    const { storage, logger } = foundStorage();
    const result = checkCsrf(
      reqWith({ cookie: `gitdatnote_session=${SESSION_ID}`, [CSRF_HEADER_NAME]: [VALID_TOKEN] }),
      storage,
      logger,
    );
    expect(result.status).toBe('ok');
  });

  it('rejects a duplicate header array (ambiguous) as CSRF_INVALID', () => {
    const { storage, logger } = foundStorage();
    const result = checkCsrf(
      reqWith({
        cookie: `gitdatnote_session=${SESSION_ID}`,
        [CSRF_HEADER_NAME]: [VALID_TOKEN, OTHER_TOKEN],
      }),
      storage,
      logger,
    );
    expect(result).toEqual({ status: 'csrf_invalid' });
  });

  it('rejects a comma-joined duplicate header (Node joins repeated lines)', () => {
    const { storage, logger } = foundStorage();
    const result = checkCsrf(
      reqWith({ cookie: `gitdatnote_session=${SESSION_ID}`, [CSRF_HEADER_NAME]: `${VALID_TOKEN}, ${OTHER_TOKEN}` }),
      storage,
      logger,
    );
    expect(result).toEqual({ status: 'csrf_invalid' });
  });

  it('rejects a missing header as CSRF_INVALID', () => {
    const { storage, logger } = foundStorage();
    const result = checkCsrf(reqWith({ cookie: `gitdatnote_session=${SESSION_ID}` }), storage, logger);
    expect(result).toEqual({ status: 'csrf_invalid' });
  });

  it('rejects an empty header value as CSRF_INVALID', () => {
    const { storage, logger } = foundStorage();
    const result = checkCsrf(
      reqWith({ cookie: `gitdatnote_session=${SESSION_ID}`, [CSRF_HEADER_NAME]: '' }),
      storage,
      logger,
    );
    expect(result).toEqual({ status: 'csrf_invalid' });
  });

  it('rejects a same-length wrong token as CSRF_INVALID', () => {
    const { storage, logger } = foundStorage();
    const result = checkCsrf(
      reqWith({ cookie: `gitdatnote_session=${SESSION_ID}`, [CSRF_HEADER_NAME]: OTHER_TOKEN }),
      storage,
      logger,
    );
    expect(result).toEqual({ status: 'csrf_invalid' });
  });

  it.each([
    ['uppercase', VALID_TOKEN.toUpperCase()],
    ['invalid hex', 'z'.repeat(64)],
    ['too short (63)', VALID_TOKEN.slice(0, 63)],
    ['too long (65)', VALID_TOKEN + '0'],
  ])('rejects a malformed token (%s) as CSRF_INVALID', (_label, token) => {
    const { storage, logger } = foundStorage();
    const result = checkCsrf(
      reqWith({ cookie: `gitdatnote_session=${SESSION_ID}`, [CSRF_HEADER_NAME]: token }),
      storage,
      logger,
    );
    expect(result).toEqual({ status: 'csrf_invalid' });
  });

  it('rejects a token from a different authenticated session', () => {
    const { storage, logger } = foundStorage(OTHER_TOKEN);
    const result = checkCsrf(
      reqWith({ cookie: `gitdatnote_session=${SESSION_ID}`, [CSRF_HEADER_NAME]: VALID_TOKEN }),
      storage,
      logger,
    );
    expect(result).toEqual({ status: 'csrf_invalid' });
  });

  it('returns unauthorized for a missing session cookie', () => {
    const { storage, logger } = foundStorage();
    const result = checkCsrf(reqWith({ [CSRF_HEADER_NAME]: VALID_TOKEN }), storage, logger);
    expect(result).toEqual({ status: 'unauthorized' });
  });

  it('returns unauthorized for a malformed session cookie', () => {
    const { storage, logger } = foundStorage();
    const result = checkCsrf(
      reqWith({ cookie: 'gitdatnote_session=not-a-valid-id', [CSRF_HEADER_NAME]: VALID_TOKEN }),
      storage,
      logger,
    );
    expect(result).toEqual({ status: 'unauthorized' });
  });

  it('returns unauthorized for a missing session', () => {
    const storage = storageFor(() => ({ status: 'missing' as const }));
    const { logger } = loggedEvents();
    const result = checkCsrf(
      reqWith({ cookie: `gitdatnote_session=${SESSION_ID}`, [CSRF_HEADER_NAME]: VALID_TOKEN }),
      storage,
      logger,
    );
    expect(result).toEqual({ status: 'unauthorized' });
  });

  it('returns unauthorized for an expired session', () => {
    const storage = storageFor(() => ({ status: 'expired' as const }));
    const { logger } = loggedEvents();
    const result = checkCsrf(
      reqWith({ cookie: `gitdatnote_session=${SESSION_ID}`, [CSRF_HEADER_NAME]: VALID_TOKEN }),
      storage,
      logger,
    );
    expect(result).toEqual({ status: 'unauthorized' });
  });

  it('fails closed on session storage errors (internal) without leaking details', () => {
    const storage = storageFor(() => {
      throw new SessionStorageError('DB_ERROR', 'database failure');
    });
    const { logger, events } = loggedEvents();
    const cookieValue = 'ff'.repeat(32);
    const result = checkCsrf(
      reqWith({ cookie: `gitdatnote_session=${cookieValue}`, [CSRF_HEADER_NAME]: VALID_TOKEN }),
      storage,
      logger,
    );
    expect(result).toEqual({ status: 'internal' });
    const joined = events.join(' ');
    expect(joined).toContain('csrf_session_lookup_failed');
    expect(joined).toContain('DB_ERROR');
    expect(joined).not.toContain(cookieValue);
    expect(joined).not.toContain(VALID_TOKEN);
  });

  it('never logs token values or session identifiers on rejection', () => {
    const { storage, logger, events } = foundStorage();
    checkCsrf(
      reqWith({ cookie: `gitdatnote_session=${SESSION_ID}`, [CSRF_HEADER_NAME]: OTHER_TOKEN }),
      storage,
      logger,
    );
    const joined = events.join(' ');
    expect(joined).toContain('csrf_rejected');
    expect(joined).not.toContain(VALID_TOKEN);
    expect(joined).not.toContain(OTHER_TOKEN);
    expect(joined).not.toContain(SESSION_ID);
  });
});

describe('respondToCsrf', () => {
  function fakeRes() {
    const res = {
      status: 0,
      headers: undefined as Record<string, string> | undefined,
      body: '',
      writeHead(status: number, headers: Record<string, string>) {
        this.status = status;
        this.headers = headers;
      },
      end(body: string) {
        this.body = body;
      },
    };
    return res;
  }

  it('proceeds (no write) for a passing check', () => {
    const res = fakeRes();
    expect(respondToCsrf(res as unknown as ServerResponse, { status: 'ok', sessionId: SESSION_ID })).toBe(true);
    expect(res.status).toBe(0);
    expect(res.body).toBe('');
  });

  it('writes 401 UNAUTHORIZED for an unauthenticated request', () => {
    const res = fakeRes();
    expect(respondToCsrf(res as unknown as ServerResponse, { status: 'unauthorized' })).toBe(false);
    expect(res.status).toBe(401);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('writes 403 CSRF_INVALID for a failed CSRF check', () => {
    const res = fakeRes();
    expect(respondToCsrf(res as unknown as ServerResponse, { status: 'csrf_invalid' })).toBe(false);
    expect(res.status).toBe(403);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.code).toBe('CSRF_INVALID');
  });

  it('writes 500 INTERNAL_ERROR for a storage failure', () => {
    const res = fakeRes();
    expect(respondToCsrf(res as unknown as ServerResponse, { status: 'internal' })).toBe(false);
    expect(res.status).toBe(500);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.code).toBe('INTERNAL_ERROR');
  });
});

/* ------------------------------------------------------------------ */
/* Part B — HTTP integration tests (centralized boundary)             */
/* ------------------------------------------------------------------ */

const CLIENT_ID = 'Iv1.ab1112223334445c';
const CLIENT_SECRET = 'test-client-secret-0123456789abcdef0123456789';
const CALLBACK = 'https://example.com/api/auth/github/callback';
const SESSION_KEY = '3a7bd3e2360a3d29eea436fcfbefe70c434e20d53060c66e0c2f6a3f4a9c7e58';

const ACCESS_TOKEN = 'ghu_test_access_token_value';
const AUTH_CODE = 'test-authorization-code-123';

const TOKEN_RESPONSE = {
  access_token: ACCESS_TOKEN,
  refresh_token: 'ghr_test_refresh_token_value',
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

const BASE_NOW = 1_750_000_000_000;
const DAY_MS = 86_400_000;

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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockGithub(h: Harness): void {
  h.fetchImpl.mockImplementation(async (input: string) => {
    const url = new URL(input);
    if (url.pathname === '/login/oauth/access_token') {
      return json(200, TOKEN_RESPONSE);
    }
    if (url.pathname === '/user') {
      return json(200, PROFILE);
    }
    if (url.pathname === '/user/installations') {
      return json(200, [{ id: 111, account: { login: PROFILE.login } }]);
    }
    if (
      url.pathname.startsWith('/user/installations/') &&
      url.pathname.endsWith('/repositories')
    ) {
      return json(200, [
        {
          owner: { login: PROFILE.login },
          name: 'notes',
          private: true,
          permissions: { admin: true, push: true, pull: true },
        },
      ]);
    }
    return json(404, { message: 'Not Found' });
  });
}

async function createHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gitdatnote-csrf-'));
  const env: Record<string, string | undefined> = {
    GITHUB_APP_CLIENT_ID: CLIENT_ID,
    GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET,
    GITHUB_OAUTH_CALLBACK_URL: CALLBACK,
    SESSION_ENCRYPTION_KEY: SESSION_KEY,
    SESSION_DB_PATH: join(dir, 'sessions.db'),
  };
  let current = BASE_NOW;
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

/**
 * Harness with session storage unavailable: `SESSION_ENCRYPTION_KEY` is
 * absent, so `resolveSessionConfig` throws `ENC_KEY_MISSING` and
 * `createApp` degrades to `session === null` (and `stateStore === null`),
 * logging `session_storage_unavailable`. Used for the fail-closed
 * boundary tests.
 */
async function createBrokenHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gitdatnote-csrf-broken-'));
  const env: Record<string, string | undefined> = {
    GITHUB_APP_CLIENT_ID: CLIENT_ID,
    GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET,
    GITHUB_OAUTH_CALLBACK_URL: CALLBACK,
    // SESSION_ENCRYPTION_KEY intentionally absent -> storage unavailable.
  };
  let current = BASE_NOW;
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
  return harness;
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
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(h.base + '/api/session', { headers: { cookie } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function startAuth(h: Harness): Promise<{ state: string; pendingCookie: string }> {
  const res = await fetch(h.base + '/api/auth/github/start', { redirect: 'manual' });
  expect(res.status).toBe(302);
  const location = res.headers.get('location');
  expect(location).toBeTypeOf('string');
  if (location === null) throw new Error('start did not return a Location header');
  const pendingCookie = res.headers.getSetCookie().find((c) => c.startsWith('gitdatnote_pending_auth='));
  expect(pendingCookie).toBeTypeOf('string');
  if (pendingCookie === undefined) throw new Error('start did not set the pending-auth cookie');
  const url = new URL(location);
  const state = url.searchParams.get('state');
  expect(state).toBeTypeOf('string');
  return { state: state as string, pendingCookie: pendingCookie as string };
}

/** Start + valid callback; returns the issued session cookie. */
async function completeSignin(h: Harness): Promise<string> {
  const start = await startAuth(h);
  const res = await fetch(
    h.base + '/api/auth/github/callback?code=' + AUTH_CODE + '&state=' + start.state,
    { headers: { cookie: start.pendingCookie }, redirect: 'manual' },
  );
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('/');
  const sessionCookie = res.headers.getSetCookie().find((c) => c.startsWith('gitdatnote_session='));
  expect(sessionCookie).toBeTypeOf('string');
  if (sessionCookie === undefined) throw new Error('callback did not set the session cookie');
  return sessionCookie;
}

describe('centralized CSRF boundary — POST /api/auth/logout', () => {
  it('deletes the session and clears the cookie with a valid CSRF token (204)', async () => {
    const h = await createHarness();
    const sessionCookie = await completeSignin(h);
    const session = await sessionWithCookie(h, sessionCookie);
    const csrf = session.body.csrfToken as string;
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

  it('rejects logout without a CSRF header (403 CSRF_INVALID) and keeps the session', async () => {
    const h = await createHarness();
    const sessionCookie = await completeSignin(h);
    const res = await fetch(h.base + '/api/auth/logout', {
      method: 'POST',
      headers: { cookie: sessionCookie },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('CSRF_INVALID');
    const after = await sessionWithCookie(h, sessionCookie);
    expect(after.body.connected).toBe(true);
    await closeHarness(h);
  });

  it('rejects logout with a wrong CSRF token (403) and keeps the session', async () => {
    const h = await createHarness();
    const sessionCookie = await completeSignin(h);
    const res = await fetch(h.base + '/api/auth/logout', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'X-CSRF-Token': 'f'.repeat(64) },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('CSRF_INVALID');
    const after = await sessionWithCookie(h, sessionCookie);
    expect(after.body.connected).toBe(true);
    await closeHarness(h);
  });

  it('rejects logout with a malformed CSRF token (403) and keeps the session', async () => {
    const h = await createHarness();
    const sessionCookie = await completeSignin(h);
    const session = await sessionWithCookie(h, sessionCookie);
    const csrf = session.body.csrfToken as string;
    const res = await fetch(h.base + '/api/auth/logout', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'X-CSRF-Token': csrf.toUpperCase() },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('CSRF_INVALID');
    const after = await sessionWithCookie(h, sessionCookie);
    expect(after.body.connected).toBe(true);
    await closeHarness(h);
  });

  it('rejects unauthenticated logout (401 UNAUTHORIZED)', async () => {
    const h = await createHarness();
    const res = await fetch(h.base + '/api/auth/logout', { method: 'POST' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('UNAUTHORIZED');
    await closeHarness(h);
  });

  it('rejects logout with an expired session (401 UNAUTHORIZED)', async () => {
    const h = await createHarness();
    const sessionCookie = await completeSignin(h);
    const session = await sessionWithCookie(h, sessionCookie);
    const csrf = session.body.csrfToken as string;
    h.setNow(h.now() + 7 * DAY_MS + 1000);
    const res = await fetch(h.base + '/api/auth/logout', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'X-CSRF-Token': csrf },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('UNAUTHORIZED');
    await closeHarness(h);
  });

  it('does not accept the CSRF token from a query parameter', async () => {
    const h = await createHarness();
    const sessionCookie = await completeSignin(h);
    const session = await sessionWithCookie(h, sessionCookie);
    const csrf = session.body.csrfToken as string;
    const res = await fetch(h.base + '/api/auth/logout?token=' + csrf, {
      method: 'POST',
      headers: { cookie: sessionCookie },
    });
    expect(res.status).toBe(403);
    const after = await sessionWithCookie(h, sessionCookie);
    expect(after.body.connected).toBe(true);
    await closeHarness(h);
  });

  it('does not accept the CSRF token from the request body', async () => {
    const h = await createHarness();
    const sessionCookie = await completeSignin(h);
    const session = await sessionWithCookie(h, sessionCookie);
    const csrf = session.body.csrfToken as string;
    const res = await fetch(h.base + '/api/auth/logout', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: csrf }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('CSRF_INVALID');
    const after = await sessionWithCookie(h, sessionCookie);
    expect(after.body.connected).toBe(true);
    await closeHarness(h);
  });

  it('does not accept the CSRF token from a cookie', async () => {
    const h = await createHarness();
    const sessionCookie = await completeSignin(h);
    const session = await sessionWithCookie(h, sessionCookie);
    const csrf = session.body.csrfToken as string;
    const res = await fetch(h.base + '/api/auth/logout', {
      method: 'POST',
      headers: { cookie: `${sessionCookie}; csrf=${csrf}` },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('CSRF_INVALID');
    const after = await sessionWithCookie(h, sessionCookie);
    expect(after.body.connected).toBe(true);
    await closeHarness(h);
  });

  it('rejects a CSRF token from a different authenticated session', async () => {
    const h = await createHarness();
    const cookieA = await completeSignin(h);
    const cookieB = await completeSignin(h);
    const sessionB = await sessionWithCookie(h, cookieB);
    const csrfB = sessionB.body.csrfToken as string;
    const res = await fetch(h.base + '/api/auth/logout', {
      method: 'POST',
      headers: { cookie: cookieA, 'X-CSRF-Token': csrfB },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('CSRF_INVALID');
    const afterA = await sessionWithCookie(h, cookieA);
    const afterB = await sessionWithCookie(h, cookieB);
    expect(afterA.body.connected).toBe(true);
    expect(afterB.body.connected).toBe(true);
    await closeHarness(h);
  });
});

describe('centralized CSRF boundary — unregistered state-changing routes', () => {
  it.each(['POST', 'PUT', 'DELETE'] as const)(
    '%s /api/notes (unregistered) requires authentication then CSRF before the safe 404',
    async (method) => {
      const h = await createHarness();
      // 1) No session cookie -> 401.
      const unauth = await fetch(h.base + '/api/notes', { method });
      expect(unauth.status).toBe(401);
      const unauthBody = (await unauth.json()) as Record<string, unknown>;
      expect(unauthBody.code).toBe('UNAUTHORIZED');
      // 2) Authenticated session, no CSRF header -> 403.
      const sessionCookie = await completeSignin(h);
      const noCsrf = await fetch(h.base + '/api/notes', {
        method,
        headers: { cookie: sessionCookie },
      });
      expect(noCsrf.status).toBe(403);
      const noCsrfBody = (await noCsrf.json()) as Record<string, unknown>;
      expect(noCsrfBody.code).toBe('CSRF_INVALID');
      // 3) Authenticated session + valid CSRF -> standard safe 404 envelope.
      const session = await sessionWithCookie(h, sessionCookie);
      const csrf = session.body.csrfToken as string;
      const okCsrf = await fetch(h.base + '/api/notes', {
        method,
        headers: { cookie: sessionCookie, 'X-CSRF-Token': csrf },
      });
      expect(okCsrf.status).toBe(404);
      const okBody = (await okCsrf.json()) as { error: { code: string } };
      expect(okBody.error.code).toBe('FILE_NOT_FOUND');
      // No state mutation happened: the session is still valid.
      const after = await sessionWithCookie(h, sessionCookie);
      expect(after.body.connected).toBe(true);
      await closeHarness(h);
    },
  );
});

describe('centralized CSRF boundary — storage-unavailable fail-closed state', () => {
  // When session storage cannot be initialized (missing/invalid encryption
  // key or broken database) no authenticated session can exist. The
  // centralized boundary must still make the authorization decision for
  // every state-changing /api request before route dispatch: the 401 here
  // comes from the boundary itself, never from a handler (before the
  // correction, unregistered state-changing routes fell through to the
  // safe 404 in this state, and future handlers could bypass the
  // boundary entirely).
  it.each(['POST', 'PUT', 'DELETE'] as const)(
    '%s /api/notes (unregistered) fails closed with 401 UNAUTHORIZED',
    async (method) => {
      const h = await createBrokenHarness();
      const res = await fetch(h.base + '/api/notes', { method });
      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe('UNAUTHORIZED');
      await closeHarness(h);
    },
  );

  it('POST /api/auth/logout fails closed with 401 UNAUTHORIZED', async () => {
    const h = await createBrokenHarness();
    const res = await fetch(h.base + '/api/auth/logout', { method: 'POST' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('UNAUTHORIZED');
    // No session could ever exist in this state: the authenticated surface
    // reports disconnected and nothing was mutated.
    const session = await fetch(h.base + '/api/session');
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ connected: false });
    await closeHarness(h);
  });

  it('GET /api/health remains available without session storage', async () => {
    const h = await createBrokenHarness();
    const res = await fetch(h.base + '/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    await closeHarness(h);
  });
});

describe('centralized CSRF boundary — read-only routes stay unaffected', () => {
  it('GET /api/health works without any CSRF header', async () => {
    const h = await createHarness();
    const res = await fetch(h.base + '/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    await closeHarness(h);
  });

  it('GET /api/session still returns the CSRF token to the authenticated client', async () => {
    const h = await createHarness();
    const sessionCookie = await completeSignin(h);
    const session = await sessionWithCookie(h, sessionCookie);
    expect(session.status).toBe(200);
    expect(session.body.connected).toBe(true);
    expect(typeof session.body.csrfToken).toBe('string');
    expect(session.body.csrfToken as string).toMatch(/^[0-9a-f]{64}$/);
    await closeHarness(h);
  });

  it('GET /api/repositories works for an authenticated session without a CSRF header', async () => {
    const h = await createHarness();
    const sessionCookie = await completeSignin(h);
    const res = await fetch(h.base + '/api/repositories', {
      headers: { cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    const first = body[0];
    expect(typeof first.owner).toBe('string');
    expect(typeof first.name).toBe('string');
    expect(typeof first.contentRoot).toBe('string');
    expect(typeof first.canRead).toBe('boolean');
    expect(typeof first.canWrite).toBe('boolean');
    await closeHarness(h);
  });
});

describe('centralized CSRF boundary — OAuth callback stays state-governed', () => {
  it('completes sign-in with no CSRF header (callback is state-governed)', async () => {
    const h = await createHarness();
    const start = await startAuth(h);
    const res = await fetch(
      h.base + '/api/auth/github/callback?code=' + AUTH_CODE + '&state=' + start.state,
      { headers: { cookie: start.pendingCookie }, redirect: 'manual' },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const sessionCookie = res.headers.getSetCookie().find((c) => c.startsWith('gitdatnote_session='));
    expect(sessionCookie).toBeTypeOf('string');
    await closeHarness(h);
  });

  it('treats an invalid state as state_invalid even when a valid CSRF header is sent', async () => {
    const h = await createHarness();
    const sessionCookie = await completeSignin(h);
    const session = await sessionWithCookie(h, sessionCookie);
    const csrf = session.body.csrfToken as string;
    const start = await startAuth(h);
    // Deliberately wrong state; a valid CSRF header must not substitute for it.
    const res = await fetch(
      h.base + '/api/auth/github/callback?code=' + AUTH_CODE + '&state=wrong-state-value',
      {
        headers: {
          cookie: `${sessionCookie}; ${start.pendingCookie}`,
          'X-CSRF-Token': csrf,
        },
        redirect: 'manual',
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/error?reason=state_invalid');
    await closeHarness(h);
  });
});

/* ------------------------------------------------------------------ */
/* Logging: no secrets in server logs                                  */
/* ------------------------------------------------------------------ */

describe('centralized CSRF boundary — logging rules', () => {
  it('server logs never contain CSRF tokens or session identifiers', async () => {
    const h = await createHarness();
    const sessionCookie = await completeSignin(h);
    const parsed = parseCookie(sessionCookie);
    const session = await sessionWithCookie(h, sessionCookie);
    const csrf = session.body.csrfToken as string;
    // Trigger a CSRF rejection and a logout success.
    await fetch(h.base + '/api/auth/logout', {
      method: 'POST',
      headers: { cookie: sessionCookie },
    });
    await fetch(h.base + '/api/auth/logout', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'X-CSRF-Token': csrf },
    });
    const logs = allLogs().join('\n');
    expect(logs).not.toContain(csrf);
    expect(logs).not.toContain(parsed.value);
    await closeHarness(h);
  });
});

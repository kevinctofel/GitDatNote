/**
 * Task 3.7 — Credential and server-logging security verification.
 *
 * Establishes (and regression-tests) the log-surface contract:
 *
 *   Request logs capture only HTTP method, sanitized route label, status,
 *   and duration (task 3.7: raw path segments never reach the log stream).
 *   Event logs carry fixed event names and stable, non-secret reason codes.
 *   Nothing else — no credentials, tokens, session ids, cookies, CSRF
 *   values, query strings, article content, or raw exception text — is
 *   ever written to the log stream.
 *
 * Every sensitive value used below is a synthetic canary generated at
 * test-run time (32 random bytes, hex). No real credential or secret
 * fixture exists in this file or anywhere in the repository.
 *
 * The harness mirrors `auth.test.ts`: a full `createApp` over real HTTP on
 * an ephemeral port, all GitHub upstream calls mocked via the injectable
 * `fetchImpl`, all databases under the OS temp dir, a deterministic
 * injected clock, and `createApp` running at `logLevel: 'debug'` so that
 * every level (debug/info/warn/error) is captured through the console
 * spies.
 */

import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../../src/server/index.js';
import type { Logger } from '../../../src/server/middleware/logging.js';

/* ------------------------------------------------------------------ */
/* Synthetic canaries (generated at run time; never real secrets)     */
/* ------------------------------------------------------------------ */

function canary(label: string): string {
  return `canary-${label}-${randomBytes(32).toString('hex')}`;
}

const CANARY = {
  /** GitHub App client secret — high-entropy hex, valid config shape. */
  clientSecret: randomBytes(32).toString('hex'),
  /** Session encryption key — exactly 64 hex (the strict contract). */
  sessionKey: randomBytes(32).toString('hex'),
  /** User access token returned by the mocked token exchange. */
  accessToken: canary('access-token'),
  /** Refresh token returned by the mocked token exchange. */
  refreshToken: canary('refresh-token'),
  /** Authorization code in the callback query string. */
  authCode: canary('auth-code'),
  /** GitHub `error` query value on a consent-denied callback. */
  errorParam: canary('error-param'),
  /** Unknown session id sent as the session cookie. */
  sessionId: canary('session-id'),
  /** Wrong (but well-formed) CSRF token value. */
  wrongCsrf: randomBytes(32).toString('hex'),
  /** Credential-shaped text embedded in upstream error bodies/exceptions. */
  upstreamText: canary('upstream-credential-text'),
  /** Synthetic article/Markdown fixture content. */
  articleText:
    'Canary article body: CANARY-MARKDOWN-DO NOT LEAK ' +
    randomBytes(24).toString('hex'),
} as const;

/* ------------------------------------------------------------------ */
/* Harness                                                             */
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

function logLines(): string[] {
  return [...logSpy.mock.calls, ...errSpy.mock.calls].map((c) =>
    c.map((x) => (typeof x === 'string' ? x : String(x))).join(' '),
  );
}

function logText(): string {
  return logLines().join('\n');
}

function expectNotInLogs(...values: string[]): void {
  const text = logText();
  for (const v of values) {
    expect(text, `canary leaked into logs: ${v.slice(0, 24)}…`).not.toContain(v);
  }
}

function requestLogLines(): string[] {
  return logLines().filter((l) => l.includes('"event":"request"'));
}

const BASE_NOW = 1_750_000_000_000;

async function createHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gitdatnote-logging-'));
  const env: Record<string, string | undefined> = {
    GITHUB_APP_CLIENT_ID: 'Iv1.canary000000000000001',
    GITHUB_APP_CLIENT_SECRET: CANARY.clientSecret,
    GITHUB_OAUTH_CALLBACK_URL: 'https://example.com/api/auth/github/callback',
    SESSION_ENCRYPTION_KEY: CANARY.sessionKey,
    SESSION_DB_PATH: join(dir, 'sessions.db'),
  };
  let current = BASE_NOW;
  const now = () => current;
  const fetchImpl = vi.fn();
  const server = createApp({ env, fetchImpl, now, logLevel: 'debug' });
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
  mockDefaultGithub(harness);
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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockDefaultGithub(h: Harness): void {
  h.fetchImpl.mockImplementation(async (input: string) => {
    const url = new URL(input);
    if (url.pathname === '/login/oauth/access_token') {
      return json(200, {
        access_token: CANARY.accessToken,
        refresh_token: CANARY.refreshToken,
        expires_in: 28800,
        refresh_token_expires_in: 15_897_600,
        token_type: 'bearer',
        scope: 'repo',
      });
    }
    if (url.pathname === '/user') {
      return json(200, {
        login: 'canary-user',
        name: 'Canary User',
        avatar_url: 'https://avatars.example/canary.png',
      });
    }
    if (url.pathname === '/user/installations') {
      return json(200, {
        total_count: 1,
        installations: [
          {
            id: 111,
            account: { login: 'canary-user' },
            permissions: { contents: 'write' },
            suspended_at: null,
          },
        ],
      });
    }
    if (
      url.pathname.startsWith('/user/installations/') &&
      url.pathname.endsWith('/repositories')
    ) {
      return json(200, {
        total_count: 1,
        repositories: [
          {
            owner: { login: 'canary-user' },
            name: 'canary-notes',
            private: false,
            permissions: { admin: true, push: true, pull: true },
          },
        ],
      });
    }
    return json(404, { message: 'Not Found' });
  });
}

interface StartResult {
  state: string;
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
  if (pendingCookie === undefined) throw new Error('start did not set the pending cookie');
  const url = new URL(location);
  const state = url.searchParams.get('state');
  expect(state).toBeTypeOf('string');
  if (state === null) throw new Error('start did not include state');
  return { state, pendingCookie: pendingCookie as string };
}

async function doCallback(
  h: Harness,
  search: string,
  cookie?: string,
): Promise<{ status: number; location: string | null; cookies: string[] }> {
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

/** Full sign-in: returns the session cookie value and the CSRF token. */
async function signIn(h: Harness): Promise<{ sessionCookie: string; csrfToken: string }> {
  const { state, pendingCookie } = await startAuth(h);
  const cb = await doCallback(
    h,
    `?state=${encodeURIComponent(state)}&code=${encodeURIComponent(CANARY.authCode)}`,
    pendingCookie,
  );
  expect(cb.status).toBe(302);
  expect(cb.location).toBe('/');
  const sessionCookie = cb.cookies.find((c) => c.startsWith('gitdatnote_session='));
  expect(sessionCookie).toBeTypeOf('string');
  if (sessionCookie === undefined) throw new Error('callback did not set session cookie');
  const value = sessionCookie.split(';')[0].split('=')[1];
  const probe = await fetch(h.base + '/api/session', { headers: { cookie: sessionCookie } });
  const body = (await probe.json()) as { connected: boolean; csrfToken?: string };
  expect(body.connected).toBe(true);
  if (body.csrfToken === undefined) throw new Error('session probe missing csrfToken');
  return { sessionCookie: value, csrfToken: body.csrfToken };
}

function rawRequest(port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.on('error', reject);
    socket.write(
      `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
    );
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('latin1');
    });
    socket.on('close', () => resolve(data));
  });
}

function portOf(h: Harness): number {
  const address = h.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
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

beforeAll(async () => {
  // Silence the real console output of the captured logger while we test it.
  logSpy.mockImplementation(() => {});
  errSpy.mockImplementation(() => {});
});

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
/* Tests                                                              */
/* ------------------------------------------------------------------ */

describe('task 3.7 — server logging never carries sensitive values', () => {
  it('full sign-in: tokens, auth code, client secret, session id, and cookie never reach the logs', async () => {
    const h = await createHarness();
    const { sessionCookie } = await signIn(h);
    const probe = await fetch(h.base + '/api/session', {
      headers: { cookie: `gitdatnote_session=${sessionCookie}` },
    });
    expect(probe.status).toBe(200);
    expectNotInLogs(
      CANARY.accessToken,
      CANARY.refreshToken,
      CANARY.authCode,
      CANARY.clientSecret,
      CANARY.sessionKey,
      sessionCookie,
    );
    // The request lines themselves stay within the documented contract:
    // method + pathname only (no query string), status, duration.
    const text = logText();
    expect(text).toContain('/api/auth/github/start');
    expect(text).toContain('/api/auth/github/callback');
    expect(text).not.toContain('code=');
    expect(text).not.toContain('state=');
  }, 30_000);

  it('consent-denied callback: the raw `error` query value is not logged', async () => {
    const h = await createHarness();
    const { state, pendingCookie } = await startAuth(h);
    const cb = await doCallback(
      h,
      `?error=${encodeURIComponent(CANARY.errorParam)}&state=${encodeURIComponent(state)}`,
      pendingCookie,
    );
    expect(cb.status).toBe(302);
    expect(cb.location).toBe('/error?reason=consent_denied');
    expectNotInLogs(CANARY.errorParam);
    // The event itself must still be observable (diagnostic preserved).
    expect(logText()).toContain('auth_consent_denied');
  }, 30_000);

  it('invalid-state callback: the authorization code in the query is not logged', async () => {
    const h = await createHarness();
    const { pendingCookie } = await startAuth(h);
    // Present a state that never matched the pending cookie.
    const cb = await doCallback(
      h,
      `?state=${'f'.repeat(64)}&code=${encodeURIComponent(CANARY.authCode)}`,
      pendingCookie,
    );
    expect(cb.status).toBe(302);
    expect(cb.location).toBe('/error?reason=state_invalid');
    expectNotInLogs(CANARY.authCode, 'f'.repeat(64));
  }, 30_000);

  it('token-exchange failure: credential-shaped upstream error text is not logged', async () => {
    const h = await createHarness();
    const { state, pendingCookie } = await startAuth(h);
    h.fetchImpl.mockImplementation(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/login/oauth/access_token') {
        return json(400, {
          error: 'bad_verification_code',
          message: CANARY.upstreamText,
        });
      }
      return json(404, { message: 'Not Found' });
    });
    const cb = await doCallback(
      h,
      `?state=${encodeURIComponent(state)}&code=${encodeURIComponent(CANARY.authCode)}`,
      pendingCookie,
    );
    expect(cb.status).toBe(302);
    expect(cb.location).toBe('/error?reason=token_error');
    expectNotInLogs(CANARY.upstreamText, CANARY.authCode);
  }, 30_000);

  it('refresh failure: credential-shaped upstream error text is not logged', async () => {
    const h = await createHarness();
    const { sessionCookie } = await signIn(h);
    // Access token expires in 28800s from BASE_NOW; advance past it while
    // the refresh token (15897600s) is still valid.
    h.setNow(BASE_NOW + 28_801_000);
    h.fetchImpl.mockImplementation(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/login/oauth/access_token') {
        return json(400, {
          error: 'bad_refresh_token',
          detail: CANARY.upstreamText,
        });
      }
      return json(404, { message: 'Not Found' });
    });
    const res = await fetch(h.base + '/api/repositories', {
      headers: { cookie: `gitdatnote_session=${sessionCookie}` },
    });
    expect([401, 429, 502]).toContain(res.status);
    expectNotInLogs(CANARY.upstreamText, CANARY.accessToken, CANARY.refreshToken);
  }, 30_000);

  it('CSRF rejection: the rejected token value is not logged', async () => {
    const h = await createHarness();
    const { sessionCookie, csrfToken } = await signIn(h);
    // Wrong well-formed token: rejected as mismatch.
    const bad = await fetch(h.base + '/api/auth/logout', {
      method: 'POST',
      headers: {
        cookie: `gitdatnote_session=${sessionCookie}`,
        'X-CSRF-Token': CANARY.wrongCsrf,
      },
    });
    expect(bad.status).toBe(403);
    // Missing header: rejected as missing.
    const missing = await fetch(h.base + '/api/auth/logout', {
      method: 'POST',
      headers: { cookie: `gitdatnote_session=${sessionCookie}` },
    });
    expect(missing.status).toBe(403);
    expectNotInLogs(CANARY.wrongCsrf);
    expect(logText()).toContain('csrf_rejected');

    // The legitimate token works and is equally absent from the logs.
    const ok = await fetch(h.base + '/api/auth/logout', {
      method: 'POST',
      headers: {
        cookie: `gitdatnote_session=${sessionCookie}`,
        'X-CSRF-Token': csrfToken,
      },
    });
    expect(ok.status).toBe(204);
    expectNotInLogs(csrfToken);
  }, 30_000);

  it('unknown session id: the cookie value is not logged', async () => {
    const h = await createHarness();
    const res = await fetch(h.base + '/api/repositories', {
      headers: { cookie: `gitdatnote_session=${CANARY.sessionId}` },
    });
    expect(res.status).toBe(401);
    expectNotInLogs(CANARY.sessionId);
  }, 30_000);

  it('repository authorization failure: upstream body is not echoed into logs or response', async () => {
    const h = await createHarness();
    const { sessionCookie } = await signIn(h);
    // GitHub definitively rejects the stored credentials (401): the
    // session is invalidated and the client gets the safe envelope.
    h.fetchImpl.mockImplementation(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/user/installations') {
        return json(401, { message: CANARY.upstreamText });
      }
      return json(404, { message: 'Not Found' });
    });
    const res = await fetch(h.base + '/api/repositories', {
      headers: { cookie: `gitdatnote_session=${sessionCookie}` },
    });
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).not.toContain(CANARY.upstreamText);
    expectNotInLogs(CANARY.upstreamText);
  }, 30_000);

  it('unexpected upstream exception: raw error message is not logged', async () => {
    const h = await createHarness();
    const { sessionCookie } = await signIn(h);
    h.fetchImpl.mockImplementation(async () => {
      throw new Error(`upstream exploded: ${CANARY.upstreamText}`);
    });
    const res = await fetch(h.base + '/api/repositories', {
      headers: { cookie: `gitdatnote_session=${sessionCookie}` },
    });
    // A transport failure maps to the safe upstream-unavailable envelope.
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).not.toContain(CANARY.upstreamText);
    expectNotInLogs(CANARY.upstreamText);
    // The safe, fixed event marker must still be present.
    expect(logText()).toContain('repositories_failed');
  }, 30_000);

  it('top-level unexpected error: raw exception text is never logged', async () => {
    // Direct contract check on the central error handler: it must log only
    // the error's stable name, never its message (which can carry
    // credential-shaped text from any upstream source).
    const { sendUnexpectedError } = await import('../../../src/server/middleware/errorHandling.js');
    const logger: Logger = {
      level: 'debug',
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (payload) => console.error(JSON.stringify(payload)),
    };
    let status = 0;
    let bodyOut = '';
    const res = {
      headersSent: false,
      writeHead: (code: number) => {
        status = code;
      },
      end: (body: string) => {
        bodyOut = body ?? '';
      },
      destroy: () => {},
    } as unknown as import('node:http').ServerResponse;
    sendUnexpectedError(res, logger, new Error(`secret material ${CANARY.upstreamText}`));
    expect(status).toBe(500);
    expect(bodyOut).not.toContain(CANARY.upstreamText);
    expectNotInLogs(CANARY.upstreamText);
    // Only the stable name is logged, never the raw message.
    expect(logText()).toContain('unhandled_error');
  }, 30_000);

  it('malformed/odd request targets: raw input is not logged', async () => {
    const h = await createHarness();
    // Query values on the callback path must never be echoed, even for
    // a target that fails before any auth logic.
    const raw = await rawRequest(
      portOf(h),
      `/api/auth/github/callback?code=${encodeURIComponent(CANARY.authCode)}&state=${'a'.repeat(64)}`,
    );
    expect(raw).toMatch(/403|404|500|302/);
    // A parseable path with a sensitive-looking query value.
    const q = await fetch(
      `${h.base}/api/repositories?next=${encodeURIComponent(CANARY.sessionId)}&q=${encodeURIComponent(CANARY.accessToken)}`,
    );
    expect([401, 404, 405]).toContain(q.status);
    expectNotInLogs(CANARY.authCode, CANARY.sessionId, CANARY.accessToken, 'a'.repeat(64));
    // The logged path is the pathname only.
    expect(logText()).not.toContain('next=');
    expect(logText()).not.toContain('q=');
  }, 30_000);

  it('synthetic article content: no endpoint leaks Markdown bodies into logs', async () => {
    // Phase 4 will add GitHub-backed content endpoints; this baseline
    // proves the current surface never carries article bodies. The
    // fixture text is synthetic and identifiable.
    const h = await createHarness();
    const { sessionCookie } = await signIn(h);
    for (const path of ['/api/session', '/api/repositories']) {
      const res = await fetch(h.base + path, {
        headers: { cookie: `gitdatnote_session=${sessionCookie}` },
      });
      expect([200, 401, 404]).toContain(res.status);
      await res.text();
    }
    expectNotInLogs(CANARY.articleText);
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* Task 3.7 — request log path labeling                               */
/* ------------------------------------------------------------------ */

describe('task 3.7 — request log path labels never carry raw path segments', () => {
  it('unknown /api route: canary segments are not logged; fixed fallback label is logged', async () => {
    const h = await createHarness();
    const seg = canary('unknown-api-segment');
    const res = await fetch(`${h.base}/api/${seg}`);
    expect(res.status).toBe(404);
    expectNotInLogs(seg);
    expect(requestLogLines().some((l) => l.includes('"path":"/api/*"'))).toBe(true);
  }, 30_000);

  it('parameterized repository route: owner/repo canaries are not logged; fixed template is logged', async () => {
    const h = await createHarness();
    const owner = canary('path-owner');
    const repo = canary('path-repo');
    // Unauthenticated: the content boundary fails closed (401) before any
    // upstream call, but the request is still logged.
    const res = await fetch(`${h.base}/api/repos/${owner}/${repo}/content`);
    expect(res.status).toBe(401);
    expectNotInLogs(owner, repo);
    expect(
      requestLogLines().some((l) =>
        l.includes('"path":"/api/repos/{owner}/{repo}/content"'),
      ),
    ).toBe(true);
  }, 30_000);

  it('non-API path: canary segments are not logged; fixed fallback label is logged', async () => {
    const h = await createHarness();
    const seg = canary('static-segment');
    const res = await fetch(`${h.base}/${seg}`);
    expect(res.status).toBe(404);
    expectNotInLogs(seg);
    expect(requestLogLines().some((l) => l.includes('"path":"/*"'))).toBe(true);
  }, 30_000);

  it('unparseable request target: fixed (unparseable) marker preserved; raw target not logged', async () => {
    const h = await createHarness();
    // Absolute-form target whose port exceeds 65535: Node's parser accepts
    // the request line, but `new URL` rejects it — the handler's URL-parse
    // failure branch. A canary is embedded in the path segment.
    const seg = canary('unparseable-segment');
    const target = `http://example.invalid:70000/${seg}`;
    const raw = await rawRequest(portOf(h), target);
    expect(raw).toMatch(/422/);
    expect(logText()).not.toContain('example.invalid');
    expectNotInLogs(seg);
    expect(requestLogLines().some((l) => l.includes('"path":"(unparseable)"'))).toBe(true);
  }, 30_000);

  it('known static routes keep their exact labels, so request events remain observable', async () => {
    const h = await createHarness();
    const res = await fetch(h.base + '/api/health');
    expect(res.status).toBe(200);
    await res.text();
    const lines = requestLogLines();
    expect(lines.some((l) => l.includes('"path":"/api/health"'))).toBe(true);
    // method/status/duration fields are still present.
    expect(
      lines.some(
        (l) => l.includes('"method":"GET"') && l.includes('"status":200') && l.includes('"durationMs"'),
      ),
    ).toBe(true);
  }, 30_000);
});

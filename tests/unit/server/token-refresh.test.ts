/**
 * Task 3.5 — GitHub App user-token refresh tests.
 *
 * Two layers:
 *
 * 1. Unit tests for `createTokenRefreshService` against real temporary
 *    session storage (encrypted round-trip), an injected clock, and a mock
 *    fetch that records every token-endpoint call and can return deferred
 *    responses for deterministic concurrency.
 *
 * 2. Integration tests over the real HTTP app (ephemeral ports) exercising
 *    the full OAuth sign-in flow, then repository discovery and the session
 *    endpoint, verifying that transparent refresh happens at the
 *    authenticated GitHub boundary and that failure mapping (401/429/502)
 *    never leaks credential values.
 *
 * No real GitHub credentials are used; all credential-shaped values are
 * obviously fake test constants. No live refresh is performed.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../../src/server/index.js';
import {
  parseEncryptionKey,
  openSessionStorage,
} from '../../../src/server/session/index.js';
import {
  createTokenRefreshService,
  GITHUB_TOKEN_URL,
  REFRESH_SAFETY_WINDOW_MS,
  type TokenRefreshService,
} from '../../../src/server/auth/refresh.js';
import type { AuthConfig } from '../../../src/server/auth/types.js';
import type { Logger } from '../../../src/server/middleware/logging.js';

/* ------------------------------------------------------------------ */
/* Test-only constants (obviously fake)                               */
/* ------------------------------------------------------------------ */

const CLIENT_ID = 'Iv1.ab1112223334445c';
const CLIENT_SECRET = 'test-client-secret-0123456789abcdef0123456789';
const CALLBACK = 'https://example.com/api/auth/github/callback';
const SESSION_KEY =
  '3a7bd3e2360a3d29eea436fcfbefe70c434e20d53060c66e0c2f6a3f4a9c7e58';

const BASE_NOW = 1_750_000_000_000;
const DAY_MS = 86_400_000;
const ACCESS_TTL_S = 28_800; // 8 hours (GitHub App user tokens)
const REFRESH_TTL_S = 15_897_600; // 6 months (documented fixed value)

const OLD_ACCESS = 'ghu_test_access_OLD';
const OLD_REFRESH = 'ghr_test_refresh_OLD';
const NEW_ACCESS = 'ghu_test_access_NEW1';
const NEW_REFRESH = 'ghr_test_refresh_NEW1';
const NEW2_ACCESS = 'ghu_test_access_NEW2';
const NEW2_REFRESH = 'ghr_test_refresh_NEW2';

const USER = {
  login: 'octo-tester',
  name: 'Octo Tester',
  avatarUrl: 'https://avatars.example/octo.png',
};

const AUTH_CONFIG: AuthConfig = {
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  callbackUrl: CALLBACK,
};

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function okRefresh(
  access: string,
  refresh: string,
  expires_in = ACCESS_TTL_S,
  refresh_token_expires_in?: number,
): Response {
  const body: Record<string, unknown> = {
    access_token: access,
    refresh_token: refresh,
    expires_in,
    token_type: 'bearer',
    scope: 'repo',
  };
  if (refresh_token_expires_in !== undefined) {
    body.refresh_token_expires_in = refresh_token_expires_in;
  }
  return jsonResponse(200, body);
}

interface TokenCall {
  url: string;
  contentType: string;
  fields: Record<string, string>;
}

/** Recording logger: captures every payload for leak assertions. */
function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const record = (payload: unknown): void => {
    lines.push(JSON.stringify(payload));
  };
  return {
    logger: {
      level: 'error',
      debug: record,
      info: record,
      warn: record,
      error: record,
    },
    lines,
  };
}

function key(): Buffer {
  const parsed = parseEncryptionKey(SESSION_KEY);
  if (parsed === null) throw new Error('test key must be valid 64-hex');
  return parsed;
}

/* ------------------------------------------------------------------ */
/* Unit harness: storage + service + controllable token endpoint      */
/* ------------------------------------------------------------------ */

interface UnitHarness {
  storage: ReturnType<typeof openSessionStorage>;
  service: TokenRefreshService;
  calls: TokenCall[];
  now: () => number;
  setNow: (t: number) => void;
  /** Replace the token-endpoint behavior. Receives the next call index. */
  setTokenBehavior(fn: (index: number) => Response | Promise<Response>): void;
  loggerLines: string[];
  dir: string;
}

const unitHarnesses: UnitHarness[] = [];

function createUnitHarness(): UnitHarness {
  const dir = mkdtempSync(join(tmpdir(), 'gitdatnote-refresh-'));
  let nowMs = BASE_NOW;
  const now = () => nowMs;
  const storage = openSessionStorage({
    dbPath: join(dir, 'sessions.db'),
    encryptionKey: key(),
    maxAgeDays: 7,
    now,
  });
  const calls: TokenCall[] = [];
  const { logger, lines } = recordingLogger();
  let behavior: (index: number) => Response | Promise<Response> = () =>
    okRefresh(NEW_ACCESS, NEW_REFRESH, ACCESS_TTL_S, REFRESH_TTL_S);
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.pathname === '/login/oauth/access_token') {
      const fields = Object.fromEntries(
        new URLSearchParams(String(init?.body ?? '')),
      );
      const call: TokenCall = {
        url: input,
        contentType:
          typeof init?.headers === 'object' && init.headers !== null
            ? String((init.headers as Record<string, string>)['Content-Type'] ?? '')
            : '',
        fields,
      };
      const index = calls.length;
      calls.push(call);
      return behavior(index);
    }
    return jsonResponse(404, { message: 'Not Found' });
  };
  const service = createTokenRefreshService({
    storage,
    authConfig: AUTH_CONFIG,
    now,
    fetchImpl,
    logger,
  });
  const harness: UnitHarness = {
    storage,
    service,
    calls,
    now,
    setNow: (t: number) => {
      nowMs = t;
    },
    setTokenBehavior: (fn) => {
      behavior = fn;
    },
    loggerLines: lines,
    dir,
  };
  unitHarnesses.push(harness);
  return harness;
}

/** Create a session with explicit credential expiry (ms). */
function createSession(
  h: UnitHarness,
  tokenExpiresAt: number,
  refreshExpiresAt: number,
  access: string = OLD_ACCESS,
  refresh: string = OLD_REFRESH,
): string {
  const created = h.storage.createSession({
    user: USER,
    credentials: {
      accessToken: access,
      refreshToken: refresh,
      tokenExpiresAt,
      refreshExpiresAt,
    },
  });
  return created.sessionId;
}

function sessionFound(sessionId: string): boolean {
  const result = unitStorageLookup(sessionId);
  return result.status === 'found';
}

let currentHarness: UnitHarness | null = null;
function unitStorageLookup(sessionId: string) {
  if (currentHarness === null) throw new Error('no harness');
  return currentHarness.storage.getSession(sessionId);
}

afterEach(() => {
  for (const h of unitHarnesses.splice(0)) {
    h.storage.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
  currentHarness = null;
});

/** Defer helper: resolves the token response manually. */
function deferred(): { promise: Promise<Response>; resolve: (r: Response) => void } {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/* ------------------------------------------------------------------ */
/* 1. Refresh service — success paths                                */
/* ------------------------------------------------------------------ */

describe('createTokenRefreshService — success', () => {
  it('returns the stored token when it is still valid (no refresh request)', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    const id = createSession(h, BASE_NOW + 3600e3, BASE_NOW + REFRESH_TTL_S * 1000);

    const result = h.service.getValidAccessToken(id);
    await expect(result).resolves.toEqual({ status: 'valid', accessToken: OLD_ACCESS });
    expect(h.calls.length).toBe(0);
  });

  it('does not refresh when expiry is just beyond the safety window', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    const id = createSession(
      h,
      BASE_NOW + REFRESH_SAFETY_WINDOW_MS + 1000,
      BASE_NOW + REFRESH_TTL_S * 1000,
    );

    const result = h.service.getValidAccessToken(id);
    await expect(result).resolves.toEqual({ status: 'valid', accessToken: OLD_ACCESS });
    expect(h.calls.length).toBe(0);
  });

  it('refreshes when the access token is within the safety window', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    const id = createSession(
      h,
      BASE_NOW + REFRESH_SAFETY_WINDOW_MS - 1000,
      BASE_NOW + REFRESH_TTL_S * 1000,
    );

    const result = await h.service.getValidAccessToken(id);
    expect(result.status).toBe('valid');
    if (result.status === 'valid') expect(result.accessToken).toBe(NEW_ACCESS);
    expect(h.calls.length).toBe(1);
  });

  it('sends the documented request when the access token has expired', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    const id = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);

    const result = await h.service.getValidAccessToken(id);
    expect(result).toEqual({ status: 'valid', accessToken: NEW_ACCESS });

    expect(h.calls.length).toBe(1);
    const call = h.calls[0];
    expect(call.url).toBe(GITHUB_TOKEN_URL);
    expect(call.contentType).toBe('application/x-www-form-urlencoded');
    expect(call.fields).toEqual({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: OLD_REFRESH,
    });
  });

  it('rotates BOTH credentials and persists the new expiry timestamps', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    const id = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);

    await h.service.getValidAccessToken(id);

    const lookup = h.storage.getSession(id);
    expect(lookup.status).toBe('found');
    if (lookup.status === 'found') {
      expect(lookup.session.credentials.accessToken).toBe(NEW_ACCESS);
      expect(lookup.session.credentials.refreshToken).toBe(NEW_REFRESH);
      expect(lookup.session.credentials.tokenExpiresAt).toBe(BASE_NOW + ACCESS_TTL_S * 1000);
      expect(lookup.session.credentials.refreshExpiresAt).toBe(BASE_NOW + REFRESH_TTL_S * 1000);
    }
  });

  it('defaults refresh_token_expires_in to the documented fixed value when omitted', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    h.setTokenBehavior(() => okRefresh(NEW_ACCESS, NEW_REFRESH)); // no refresh_token_expires_in
    const id = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);

    const result = await h.service.getValidAccessToken(id);
    expect(result.status).toBe('valid');
    const lookup = h.storage.getSession(id);
    if (lookup.status === 'found') {
      expect(lookup.session.credentials.refreshExpiresAt).toBe(BASE_NOW + REFRESH_TTL_S * 1000);
    }
  });

  it('never reuses the original refresh token after rotation', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    h.setTokenBehavior((index) =>
      index === 0
        ? okRefresh(NEW_ACCESS, NEW_REFRESH)
        : okRefresh(NEW2_ACCESS, NEW2_REFRESH),
    );
    const id = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);

    const first = await h.service.getValidAccessToken(id);
    expect(first).toEqual({ status: 'valid', accessToken: NEW_ACCESS });

    // Advance past the first rotated access token's expiry; the NEXT
    // refresh must submit the ROTATED refresh token, never the old one.
    h.setNow(BASE_NOW + ACCESS_TTL_S * 1000 + 1000);
    const second = await h.service.getValidAccessToken(id);
    expect(second).toEqual({ status: 'valid', accessToken: NEW2_ACCESS });

    expect(h.calls.length).toBe(2);
    expect(h.calls[0].fields.refresh_token).toBe(OLD_REFRESH);
    expect(h.calls[1].fields.refresh_token).toBe(NEW_REFRESH);
  });

  it('a still-valid rotated token causes no further refresh', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    const id = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);

    await h.service.getValidAccessToken(id);
    const again = await h.service.getValidAccessToken(id);
    expect(again).toEqual({ status: 'valid', accessToken: NEW_ACCESS });
    expect(h.calls.length).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Refresh service — failure paths                                */
/* ------------------------------------------------------------------ */

describe('createTokenRefreshService — failures', () => {
  it('missing refresh token: session invalidated WITHOUT contacting GitHub', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    const id = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);
    // Storage rejects empty tokens on write, so simulate a session record
    // that lost its refresh token; the service guard must still fail closed
    // without contacting GitHub.
    const realGetSession = h.storage.getSession.bind(h.storage);
    const spy = vi
      .spyOn(h.storage, 'getSession')
      .mockImplementation((sessionId: string) => {
        const result = realGetSession(sessionId);
        if (result.status !== 'found') return result;
        return {
          ...result,
          session: {
            ...result.session,
            credentials: {
              ...result.session.credentials,
              refreshToken: '',
            },
          },
        };
      });
    try {
      const result = h.service.getValidAccessToken(id);
      await expect(result).resolves.toEqual({ status: 'unauthorized' });
      expect(h.calls.length).toBe(0);
      expect(sessionFound(id)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('expired refresh token: session invalidated BEFORE contacting GitHub', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    const id = createSession(h, BASE_NOW - 1, BASE_NOW - 1);

    const result = h.service.getValidAccessToken(id);
    await expect(result).resolves.toEqual({ status: 'unauthorized' });
    expect(h.calls.length).toBe(0);
    expect(sessionFound(id)).toBe(false);
  });

  it('GitHub bad_refresh_token rejection deletes the session (no retry)', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    h.setTokenBehavior(() =>
      jsonResponse(400, {
        error: 'bad_refresh_token',
        error_description: 'The refresh token is invalid or expired.',
      }),
    );
    const id = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);

    const result = await h.service.getValidAccessToken(id);
    expect(result).toEqual({ status: 'unauthorized' });
    expect(h.calls.length).toBe(1);
    expect(sessionFound(id)).toBe(false);

    // A later call must NOT resubmit the consumed refresh token.
    const again = await h.service.getValidAccessToken(id);
    expect(again).toEqual({ status: 'unauthorized' });
    expect(h.calls.length).toBe(1);
  });

  it('GitHub 401 rejection deletes the session', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    h.setTokenBehavior(() => jsonResponse(401, { error: 'incorrect_client_credentials' }));
    const id = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);

    const result = await h.service.getValidAccessToken(id);
    expect(result).toEqual({ status: 'unauthorized' });
    expect(sessionFound(id)).toBe(false);
  });

  it('GitHub 403 (non-rate-limit) rejection deletes the session', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    h.setTokenBehavior(() => jsonResponse(403, { message: 'Bad credentials' }));
    const id = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);

    const result = await h.service.getValidAccessToken(id);
    expect(result).toEqual({ status: 'unauthorized' });
    expect(sessionFound(id)).toBe(false);
  });

  it('GitHub 403 with X-RateLimit-Remaining: 0 is a rate limit: session preserved', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    h.setTokenBehavior(() =>
      jsonResponse(403, { message: 'You have exceeded a rate limit' }, {
        'X-RateLimit-Remaining': '0',
      }),
    );
    const id = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);

    const result = await h.service.getValidAccessToken(id);
    expect(result).toEqual({ status: 'rate_limited' });
    expect(sessionFound(id)).toBe(true);
    // The refresh token was not consumed: stored credentials unchanged.
    const lookup = unitStorageLookup(id);
    if (lookup.status === 'found') {
      expect(lookup.session.credentials.refreshToken).toBe(OLD_REFRESH);
    }
  });

  it('malformed 200 response (missing access token) invalidates the session', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    h.setTokenBehavior(() =>
      jsonResponse(200, {
        refresh_token: NEW_REFRESH,
        expires_in: ACCESS_TTL_S,
        refresh_token_expires_in: REFRESH_TTL_S,
      }),
    );
    const id = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);

    const result = await h.service.getValidAccessToken(id);
    expect(result).toEqual({ status: 'unauthorized' });
    expect(sessionFound(id)).toBe(false);
  });

  it('malformed 200 response (missing refresh token) invalidates the session', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    h.setTokenBehavior(() =>
      jsonResponse(200, {
        access_token: NEW_ACCESS,
        expires_in: ACCESS_TTL_S,
        refresh_token_expires_in: REFRESH_TTL_S,
      }),
    );
    const id = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);

    const result = await h.service.getValidAccessToken(id);
    expect(result).toEqual({ status: 'unauthorized' });
    expect(sessionFound(id)).toBe(false);
  });

  it('malformed 200 response (zero expires_in) invalidates the session', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    h.setTokenBehavior(() => okRefresh(NEW_ACCESS, NEW_REFRESH, 0));
    const id = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);

    const result = await h.service.getValidAccessToken(id);
    expect(result).toEqual({ status: 'unauthorized' });
    expect(sessionFound(id)).toBe(false);
  });

  it('malformed 200 response (non-numeric expires_in) invalidates the session', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    h.setTokenBehavior(() =>
      jsonResponse(200, {
        access_token: NEW_ACCESS,
        refresh_token: NEW_REFRESH,
        expires_in: '28800',
        refresh_token_expires_in: REFRESH_TTL_S,
      }),
    );
    const id = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);

    const result = await h.service.getValidAccessToken(id);
    expect(result).toEqual({ status: 'unauthorized' });
    expect(sessionFound(id)).toBe(false);
  });

  it('non-JSON 200 response invalidates the session', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    h.setTokenBehavior(() =>
      new Response('not json', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );
    const id = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);

    const result = await h.service.getValidAccessToken(id);
    expect(result).toEqual({ status: 'unauthorized' });
    expect(sessionFound(id)).toBe(false);
  });

  it('transient transport failure preserves the session (upstream_unavailable)', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    h.setTokenBehavior(() => {
      throw new Error('network down');
    });
    const id = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);

    const result = await h.service.getValidAccessToken(id);
    expect(result).toEqual({ status: 'upstream_unavailable' });
    expect(sessionFound(id)).toBe(true);
    const lookup = unitStorageLookup(id);
    if (lookup.status === 'found') {
      // Credentials untouched — the next attempt may retry safely.
      expect(lookup.session.credentials.accessToken).toBe(OLD_ACCESS);
      expect(lookup.session.credentials.refreshToken).toBe(OLD_REFRESH);
    }
  });

  it('transient 5xx preserves the session (upstream_unavailable)', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    h.setTokenBehavior(() => jsonResponse(503, { message: 'unavailable' }));
    const id = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);

    const result = await h.service.getValidAccessToken(id);
    expect(result).toEqual({ status: 'upstream_unavailable' });
    expect(sessionFound(id)).toBe(true);
  });

  it('429 maps to rate_limited and preserves the session', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    h.setTokenBehavior(() => jsonResponse(429, { message: 'rate limited' }));
    const id = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);

    const result = await h.service.getValidAccessToken(id);
    expect(result).toEqual({ status: 'rate_limited' });
    expect(sessionFound(id)).toBe(true);
  });

  it('session deleted during refresh → unauthorized (rotation discarded)', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    const id = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);
    h.setTokenBehavior(() => {
      h.storage.deleteSession(id); // concurrent deletion while in flight
      return okRefresh(NEW_ACCESS, NEW_REFRESH);
    });

    const result = await h.service.getValidAccessToken(id);
    expect(result).toEqual({ status: 'unauthorized' });
    expect(sessionFound(id)).toBe(false);
  });

  it('session expired during refresh → unauthorized (rotation discarded)', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    const id = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);
    h.setTokenBehavior(() => {
      h.setNow(BASE_NOW + 8 * DAY_MS); // session max age is 7 days
      return okRefresh(NEW_ACCESS, NEW_REFRESH);
    });

    const result = await h.service.getValidAccessToken(id);
    expect(result).toEqual({ status: 'unauthorized' });
    expect(sessionFound(id)).toBe(false);
  });

  it('database rotation failure invalidates the session (fail closed)', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    const id = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);
    const spy = vi
      .spyOn(h.storage, 'rotateCredentials')
      .mockImplementation(() => {
        throw new Error('sqlite disk full');
      });
    try {
      const result = await h.service.getValidAccessToken(id);
      expect(result).toEqual({ status: 'unauthorized' });
      expect(sessionFound(id)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('lookup failure maps to unauthorized (no crash, no leak)', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    const spy = vi
      .spyOn(h.storage, 'getSession')
      .mockImplementation(() => {
        throw new Error('db error');
      });
    try {
      const result = await h.service.getValidAccessToken('a'.repeat(64));
      expect(result).toEqual({ status: 'unauthorized' });
      expect(h.calls.length).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. Refresh service — concurrency (single-flight)                  */
/* ------------------------------------------------------------------ */

describe('createTokenRefreshService — concurrency', () => {
  it('two concurrent refreshes of the same session perform exactly ONE GitHub call', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    const id = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);
    const held = deferred();
    h.setTokenBehavior(() => held.promise);

    const pendingA = h.service.getValidAccessToken(id);
    const pendingB = h.service.getValidAccessToken(id);
    held.resolve(okRefresh(NEW_ACCESS, NEW_REFRESH));
    const [first, second] = await Promise.all([pendingA, pendingB]);

    expect(first).toEqual({ status: 'valid', accessToken: NEW_ACCESS });
    expect(second).toEqual({ status: 'valid', accessToken: NEW_ACCESS });
    expect(h.calls.length).toBe(1);
  });

  it('a failed shared refresh leaves BOTH callers unauthorized and the session gone', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    const id = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);
    const held = deferred();
    h.setTokenBehavior(() => held.promise);

    const pendingA = h.service.getValidAccessToken(id);
    const pendingB = h.service.getValidAccessToken(id);
    held.resolve(
      jsonResponse(400, { error: 'bad_refresh_token' }),
    );
    const [first, second] = await Promise.all([pendingA, pendingB]);

    expect(first).toEqual({ status: 'unauthorized' });
    expect(second).toEqual({ status: 'unauthorized' });
    expect(h.calls.length).toBe(1);
    expect(sessionFound(id)).toBe(false);
  });

  it('a failed refresh cannot leave one caller authorized with stale credentials', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    const id = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);
    const held = deferred();
    h.setTokenBehavior(() => held.promise);

    const pendingA = h.service.getValidAccessToken(id);
    const pendingB = h.service.getValidAccessToken(id);
    held.resolve(jsonResponse(503, { message: 'upstream down' }));
    const [first, second] = await Promise.all([pendingA, pendingB]);

    // Transient failure: neither caller gets a token, session preserved.
    expect(first).toEqual({ status: 'upstream_unavailable' });
    expect(second).toEqual({ status: 'upstream_unavailable' });
    expect(sessionFound(id)).toBe(true);
    expect(h.calls.length).toBe(1);
  });

  it('independent sessions do not share refresh state', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    const idA = createSession(
      h,
      BASE_NOW - 1,
      BASE_NOW + REFRESH_TTL_S * 1000,
      OLD_ACCESS,
      OLD_REFRESH,
    );
    const idB = createSession(
      h,
      BASE_NOW - 1,
      BASE_NOW + REFRESH_TTL_S * 1000,
      'ghu_test_access_B',
      'ghr_test_refresh_B',
    );
    const heldA = deferred();
    const heldB = deferred();
    h.setTokenBehavior((index) => (index === 0 ? heldA.promise : heldB.promise));

    const pendingA = h.service.getValidAccessToken(idA);
    const pendingB = h.service.getValidAccessToken(idB);
    heldA.resolve(okRefresh(NEW_ACCESS, NEW_REFRESH));
    heldB.resolve(okRefresh(NEW2_ACCESS, NEW2_REFRESH));
    const [resultA, resultB] = await Promise.all([pendingA, pendingB]);

    expect(resultA).toEqual({ status: 'valid', accessToken: NEW_ACCESS });
    expect(resultB).toEqual({ status: 'valid', accessToken: NEW2_ACCESS });
    expect(h.calls.length).toBe(2);
    expect(h.calls[0].fields.refresh_token).toBe(OLD_REFRESH);
    expect(h.calls[1].fields.refresh_token).toBe('ghr_test_refresh_B');
  });

  it('after a successful shared refresh, the in-flight record is removed (next valid call: no refresh)', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    const id = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);
    const held = deferred();
    h.setTokenBehavior(() => held.promise);

    const pendingA = h.service.getValidAccessToken(id);
    const pendingB = h.service.getValidAccessToken(id);
    held.resolve(okRefresh(NEW_ACCESS, NEW_REFRESH));
    await Promise.all([pendingA, pendingB]);

    const after = await h.service.getValidAccessToken(id);
    expect(after).toEqual({ status: 'valid', accessToken: NEW_ACCESS });
    expect(h.calls.length).toBe(1);
  });

  it('after a failed shared refresh, a later call makes no further GitHub request', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    const id = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);
    const held = deferred();
    h.setTokenBehavior(() => held.promise);

    const pendingA = h.service.getValidAccessToken(id);
    const pendingB = h.service.getValidAccessToken(id);
    held.resolve(jsonResponse(400, { error: 'bad_refresh_token' }));
    await Promise.all([pendingA, pendingB]);

    const after = await h.service.getValidAccessToken(id);
    expect(after).toEqual({ status: 'unauthorized' });
    expect(h.calls.length).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Refresh service — no credential leakage in logs                */
/* ------------------------------------------------------------------ */

describe('createTokenRefreshService — log safety', () => {
  it('success + rejection paths never log token or secret values', async () => {
    const h = createUnitHarness();
    currentHarness = h;
    const idGood = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);
    await h.service.getValidAccessToken(idGood);

    const idBad = createSession(h, BASE_NOW - 1, BASE_NOW + REFRESH_TTL_S * 1000);
    h.setTokenBehavior(() => jsonResponse(400, { error: 'bad_refresh_token' }));
    await h.service.getValidAccessToken(idBad);

    const logged = h.loggerLines.join('\n');
    for (const secret of [
      OLD_ACCESS,
      OLD_REFRESH,
      NEW_ACCESS,
      NEW_REFRESH,
      CLIENT_SECRET,
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Integration harness: real app over HTTP                            */
/* ------------------------------------------------------------------ */

interface IntegrationHarness {
  server: Server;
  base: string;
  now: () => number;
  setNow: (t: number) => void;
  fetchImpl: ReturnType<typeof vi.fn>;
  dir: string;
}

const integrationHarnesses: IntegrationHarness[] = [];
const logSpy = vi.spyOn(console, 'log');
const errSpy = vi.spyOn(console, 'error');

function allLogs(): string[] {
  return [...logSpy.mock.calls, ...errSpy.mock.calls].map((c) =>
    c.map((x) => (typeof x === 'string' ? x : String(x))).join(' '),
  );
}

/**
 * GitHub mock with call recording. `tokenBehavior` controls the token
 * endpoint per call index; every authenticated API call's Authorization
 * header is recorded so tests can verify which access token was used.
 */
function makeIntegrationMock(
  h: IntegrationHarness,
  state: {
    tokenBehavior: (index: number) => Response;
    profile: Record<string, unknown>;
    repos: unknown[];
    failProtectedForToken?: string | null;
  },
): {
  tokenCalls: TokenCall[];
  apiAuthHeaders: string[];
} {
  const tokenCalls: TokenCall[] = [];
  const apiAuthHeaders: string[] = [];
  h.fetchImpl.mockImplementation(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const headers =
      typeof init?.headers === 'object' && init.headers !== null
        ? (init.headers as Record<string, string>)
        : {};
    if (url.pathname === '/login/oauth/access_token') {
      const fields = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
      const call: TokenCall = {
        url: input,
        contentType: headers['Content-Type'] ?? '',
        fields,
      };
      const index = tokenCalls.length;
      tokenCalls.push(call);
      return state.tokenBehavior(index);
    }
    const auth = headers['Authorization'] ?? '';
    apiAuthHeaders.push(auth);
    if (state.failProtectedForToken && auth === state.failProtectedForToken) {
      // Definitive credential rejection for that specific access token:
      // 401 Bad Credentials (GitHub's documented revocation response).
      return jsonResponse(401, { message: 'Bad Credentials' });
    }
    if (url.pathname === '/user') {
      return jsonResponse(200, state.profile);
    }
    if (url.pathname === '/user/installations') {
      return jsonResponse(200, {
        total_count: 1,
        installations: [
          {
            id: 111,
            account: { login: state.profile.login },
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
      return jsonResponse(200, {
        total_count: state.repos.length,
        repositories: state.repos,
      });
    }
    return jsonResponse(404, { message: 'Not Found' });
  });
  return { tokenCalls, apiAuthHeaders };
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

async function closeHarness(h: IntegrationHarness): Promise<void> {
  await new Promise<void>((resolve) => h.server.close(() => resolve()));
  try {
    h.server.closeAllConnections();
  } catch {
    /* ignore */
  }
  rmSync(h.dir, { recursive: true, force: true });
}

const PROFILE = {
  login: 'octo-tester',
  name: 'Octo Tester',
  avatar_url: 'https://avatars.example/octo.png',
};

const REPOS = [
  {
    owner: { login: 'octo-tester' },
    name: 'notes',
    private: true,
    permissions: { admin: true, push: true, pull: true },
  },
];

function okTokenResponse(access: string, refresh: string): Response {
  return okRefresh(access, refresh);
}

function integrationSigninState(): {
  tokenBehavior: (index: number) => Response;
} {
  // Call 0: initial code exchange. Later calls (refreshes) default to the
  // rotated token pair; tests override for specific behavior.
  return {
    tokenBehavior: (index) =>
      index === 0
        ? okTokenResponse('ghu_test_access_initial', 'ghr_test_refresh_initial')
        : okTokenResponse('ghu_test_access_rotated1', 'ghr_test_refresh_rotated1'),
  };
}

async function createIntegrationHarness(): Promise<IntegrationHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'gitdatnote-refresh-it-'));
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
  const harness: IntegrationHarness = {
    server,
    base: `http://127.0.0.1:${port}`,
    now,
    setNow: (t: number) => {
      current = t;
    },
    fetchImpl,
    dir,
  };
  integrationHarnesses.push(harness);
  return harness;
}

async function completeSignin(
  h: IntegrationHarness,
  state: {
    tokenBehavior: (index: number) => Response;
    failProtectedForToken?: string | null;
  },
  preRecorded?: ReturnType<typeof makeIntegrationMock>,
): Promise<{ cookie: string; tokenCalls: TokenCall[]; apiAuthHeaders: string[] }> {
  const recorded =
    preRecorded ??
    makeIntegrationMock(h, {
      tokenBehavior: state.tokenBehavior,
      profile: PROFILE,
      repos: REPOS,
      failProtectedForToken: state.failProtectedForToken,
    });

  const start = await fetch(h.base + '/api/auth/github/start', { redirect: 'manual' });
  expect(start.status).toBe(302);
  const location = start.headers.get('location');
  expect(location).toBeTypeOf('string');
  const pendingCookie = start.headers
    .getSetCookie()
    .find((c) => c.startsWith('gitdatnote_pending_auth='));
  expect(pendingCookie).toBeTypeOf('string');
  const startUrl = new URL(location as string);
  const stateValue = startUrl.searchParams.get('state');
  expect(stateValue).toBeTypeOf('string');

  const cb = await fetch(h.base + '/api/auth/github/callback' + `?code=test-code&state=${stateValue}`, {
    headers: { cookie: pendingCookie as string },
    redirect: 'manual',
  });
  expect(cb.status).toBe(302);
  const sessionCookie = cb.headers
    .getSetCookie()
    .find((c) => c.startsWith('gitdatnote_session='));
  expect(sessionCookie).toBeTypeOf('string');
  return {
    cookie: sessionCookie as string,
    tokenCalls: recorded.tokenCalls,
    apiAuthHeaders: recorded.apiAuthHeaders,
  };
}

async function getRepositories(
  h: IntegrationHarness,
  cookie: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(h.base + '/api/repositories', { headers: { cookie } });
  return { status: res.status, body: await res.json() };
}

async function getSession(
  h: IntegrationHarness,
  cookie?: string,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers.cookie = cookie;
  const res = await fetch(h.base + '/api/session', { headers });
  return { status: res.status, body: await res.json() };
}

afterEach(() => {
  logSpy.mockClear();
  errSpy.mockClear();
});

afterAll(async () => {
  for (const h of integrationHarnesses) {
    await closeHarness(h);
  }
  logSpy.mockRestore();
  errSpy.mockRestore();
});

/* ------------------------------------------------------------------ */
/* 5. Integration — refresh at the authenticated GitHub boundary     */
/* ------------------------------------------------------------------ */

describe('integration — token refresh at /api/repositories', () => {
  it('a valid access token causes no refresh request', async () => {
    const h = await createIntegrationHarness();
    const { cookie, tokenCalls } = await completeSignin(h, integrationSigninState());
    expect(tokenCalls.length).toBe(1); // only the initial code exchange

    const first = await getRepositories(h, cookie);
    expect(first.status).toBe(200);
    const second = await getRepositories(h, cookie);
    expect(second.status).toBe(200);
    expect(tokenCalls.length).toBe(1); // no refresh while the token is valid
  });

  it('an expired access token triggers exactly one refresh and uses the rotated token', async () => {
    const h = await createIntegrationHarness();
    const { cookie, tokenCalls, apiAuthHeaders } = await completeSignin(
      h,
      integrationSigninState(),
    );

    // Advance past the initial access token expiry (8h).
    h.setNow(BASE_NOW + ACCESS_TTL_S * 1000 + 1000);

    const res = await getRepositories(h, cookie);
    expect(res.status).toBe(200);
    const body = res.body as Array<{ owner: string; name: string }>;
    expect(body).toEqual([
      expect.objectContaining({ owner: 'octo-tester', name: 'notes' }),
    ]);

    // Exactly one refresh call, with the documented contract.
    expect(tokenCalls.length).toBe(2);
    const refreshCall = tokenCalls[1];
    expect(refreshCall.url).toBe(GITHUB_TOKEN_URL);
    expect(refreshCall.contentType).toBe('application/x-www-form-urlencoded');
    expect(refreshCall.fields).toEqual({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: 'ghr_test_refresh_initial',
    });

    // The repository discovery calls used the ROTATED access token.
    const rotated = 'Bearer ghu_test_access_rotated1';
    expect(apiAuthHeaders.filter((a) => a === rotated).length).toBeGreaterThan(0);
    expect(apiAuthHeaders.includes('Bearer ghu_test_access_initial')).toBe(
      true, // used for /user during sign-in
    );

    // A follow-up call within the new validity performs no further refresh.
    const again = await getRepositories(h, cookie);
    expect(again.status).toBe(200);
    expect(tokenCalls.length).toBe(2);
  });

  it('a session whose access AND refresh tokens are expired reports disconnected and is invalidated', async () => {
    const h = await createIntegrationHarness();
    const { cookie, tokenCalls } = await completeSignin(h, integrationSigninState());

    // Advance past BOTH token lifetimes (refresh: 6 months).
    h.setNow(BASE_NOW + REFRESH_TTL_S * 1000 + DAY_MS);

    const session = await getSession(h, cookie);
    expect(session.status).toBe(200);
    expect(session.body).toEqual({ connected: false });

    // The session was invalidated: repository discovery now fails closed.
    const repos = await getRepositories(h, cookie);
    expect(repos.status).toBe(401);

    // No refresh was attempted (the refresh token was checked client-side).
    expect(tokenCalls.length).toBe(1);
  });

  it('a rejected refresh (bad_refresh_token) during repository discovery invalidates the session with 401', async () => {
    const h = await createIntegrationHarness();
    const state = integrationSigninState();
    state.tokenBehavior = (index) =>
      index === 0
        ? okTokenResponse('ghu_test_access_initial', 'ghr_test_refresh_initial')
        : jsonResponse(400, { error: 'bad_refresh_token' });
    const { cookie, tokenCalls } = await completeSignin(h, state);

    h.setNow(BASE_NOW + ACCESS_TTL_S * 1000 + 1000);

    const repos = await getRepositories(h, cookie);
    expect(repos.status).toBe(401);
    expect(tokenCalls.length).toBe(2);

    const session = await getSession(h, cookie);
    expect(session.body).toEqual({ connected: false });
  });

  it('a transient refresh failure (503) maps to 502 and preserves the session', async () => {
    const h = await createIntegrationHarness();
    const state = integrationSigninState();
    let transient = true;
    state.tokenBehavior = (index) =>
      index === 0
        ? okTokenResponse('ghu_test_access_initial', 'ghr_test_refresh_initial')
        : transient
          ? jsonResponse(503, { message: 'upstream down' })
          : okTokenResponse('ghu_test_access_rotated1', 'ghr_test_refresh_rotated1');
    const { cookie, tokenCalls } = await completeSignin(h, state);

    h.setNow(BASE_NOW + ACCESS_TTL_S * 1000 + 1000);

    const failed = await getRepositories(h, cookie);
    expect(failed.status).toBe(502);
    expect(tokenCalls.length).toBe(2);

    // The session survived: once GitHub recovers, discovery succeeds via a
    // single additional (second) refresh of the same refresh token.
    transient = false;
    const recovered = await getRepositories(h, cookie);
    expect(recovered.status).toBe(200);
    expect(tokenCalls.length).toBe(3);
  });

  it('an unauthenticated /api/repositories returns 401 and makes no token calls', async () => {
    const h = await createIntegrationHarness();
    makeIntegrationMock(h, {
      tokenBehavior: () => okTokenResponse('x', 'y'),
      profile: PROFILE,
      repos: REPOS,
    });
    const res = await fetch(h.base + '/api/repositories');
    expect(res.status).toBe(401);
    expect(h.fetchImpl.mock.calls.length).toBe(0);
  });

  it('no credential values appear in HTTP error bodies or server logs on a rejected refresh', async () => {
    const h = await createIntegrationHarness();
    const state = integrationSigninState();
    state.tokenBehavior = (index) =>
      index === 0
        ? okTokenResponse('ghu_test_access_initial', 'ghr_test_refresh_initial')
        : jsonResponse(400, { error: 'bad_refresh_token' });
    const { cookie } = await completeSignin(h, state);

    h.setNow(BASE_NOW + ACCESS_TTL_S * 1000 + 1000);
    const repos = await getRepositories(h, cookie);
    expect(repos.status).toBe(401);
    const errorBody = JSON.stringify(repos.body);

    const logged = allLogs().join('\n');
    for (const secret of [
      'ghu_test_access_initial',
      'ghr_test_refresh_initial',
      CLIENT_SECRET,
    ]) {
      expect(errorBody).not.toContain(secret);
      expect(logged).not.toContain(secret);
    }
  });
});

describe('review correction: definitive 401 invalidates the session', () => {
  it('repository discovery: 401 Bad Credentials → 401 → disconnected; sibling session unaffected', async () => {
    const h = await createIntegrationHarness();
    const state: {
      tokenBehavior: (index: number) => Response;
      profile: Record<string, unknown>;
      repos: unknown[];
      failProtectedForToken: string | null;
    } = {
      tokenBehavior: integrationSigninState().tokenBehavior,
      profile: PROFILE,
      repos: REPOS,
      failProtectedForToken: null,
    };
    const recorded = makeIntegrationMock(h, state);

    // Two independent sign-ins against one shared mock: token call 0 gives
    // session A the initial access token; call 1 gives session B the
    // rotated token (distinct credentials, distinct sessions).
    const a = await completeSignin(h, state, recorded);
    const b = await completeSignin(h, state, recorded);
    expect(a.cookie).not.toBe(b.cookie);
    expect(recorded.tokenCalls.length).toBe(2);

    // Session A's access token is now definitively revoked: any protected
    // GitHub request made with it answers 401 Bad Credentials.
    state.failProtectedForToken = 'Bearer ghu_test_access_initial';

    const discovered = await getRepositories(h, a.cookie);
    expect(discovered.status).toBe(401);

    // The session must be invalidated: /api/session reports disconnected.
    const sessionA = await getSession(h, a.cookie);
    expect(sessionA.body).toEqual({ connected: false });

    // Session B is unrelated: it remains connected and usable.
    const sessionB = await getSession(h, b.cookie);
    expect(sessionB.body).toMatchObject({ connected: true });
    const bRepos = await getRepositories(h, b.cookie);
    expect(bRepos.status).toBe(200);
    expect(Array.isArray(bRepos.body)).toBe(true);
    expect(bRepos.body).toHaveLength(1);
  });

  it('content authorization boundary: 401 Bad Credentials → 401 → session invalidated', async () => {
    const h = await createIntegrationHarness();
    const state: {
      tokenBehavior: (index: number) => Response;
      profile: Record<string, unknown>;
      repos: unknown[];
      failProtectedForToken: string | null;
    } = {
      tokenBehavior: integrationSigninState().tokenBehavior,
      profile: PROFILE,
      repos: REPOS,
      failProtectedForToken: null,
    };
    const recorded = makeIntegrationMock(h, state);
    const { cookie } = await completeSignin(h, state, recorded);

    // Definitive revocation against this session's access token.
    state.failProtectedForToken = 'Bearer ghu_test_access_initial';

    const res = await fetch(h.base + '/api/repos/octo-tester/notes/content', {
      headers: { cookie },
    });
    expect(res.status).toBe(401);

    // Same observable contract as repository discovery: disconnected.
    const session = await getSession(h, cookie);
    expect(session.body).toEqual({ connected: false });
  });
});

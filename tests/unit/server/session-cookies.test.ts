/**
 * Task 3.1 — session cookie security tests.
 *
 * Covers the required attributes (HttpOnly, SameSite=Lax, Path=/, Secure
 * conditional on HTTPS/production), lifetime consistency with the session
 * maximum age, clearing, and safe parsing of malformed/missing cookies.
 * All values are fake; no real session IDs or credentials are used.
 */

import { describe, expect, it } from 'vitest';

import {
  SESSION_COOKIE_NAME,
  SESSION_ID_PATTERN,
  clearSessionCookie,
  issueSessionCookie,
  parseSessionCookie,
  resolveCookieSecure,
} from '../../../src/server/session/index.js';

const DAY_MS = 86400000;
const NOW = 1_750_000_000_000;
const FAKE_SESSION_ID = 'ab'.repeat(32);

function devCookie() {
  return issueSessionCookie(FAKE_SESSION_ID, {
    secure: false,
    maxAgeDays: 7,
    now: () => NOW,
  });
}

function prodCookie() {
  return issueSessionCookie(FAKE_SESSION_ID, {
    secure: true,
    maxAgeDays: 7,
    now: () => NOW,
  });
}

describe('session cookie issuance', () => {
  it('always includes HttpOnly, SameSite=Lax, and Path=/', () => {
    for (const cookie of [devCookie(), prodCookie()]) {
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Path=/');
    }
  });

  it('omits Secure in local HTTP development', () => {
    const cookie = devCookie();
    expect(cookie).not.toContain('Secure');
    expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=${FAKE_SESSION_ID};`)).toBe(true);
  });

  it('includes Secure under HTTPS/production configuration', () => {
    expect(prodCookie()).toContain('Secure');
  });

  it('derives Max-Age and Expires from the session lifetime', () => {
    const cookie = devCookie();
    expect(cookie).toContain('Max-Age=604800'); // 7 days
    expect(cookie).toContain(`Expires=${new Date(NOW + 7 * DAY_MS).toUTCString()}`);
  });

  it('scales Max-Age with a custom lifetime', () => {
    const cookie = issueSessionCookie(FAKE_SESSION_ID, {
      secure: false,
      maxAgeDays: 3,
      now: () => NOW,
    });
    expect(cookie).toContain('Max-Age=259200');
    expect(cookie).toContain(`Expires=${new Date(NOW + 3 * DAY_MS).toUTCString()}`);
  });

  it('rejects invalid session ids and lifetimes', () => {
    expect(() => issueSessionCookie('nope', { secure: false, maxAgeDays: 7 })).toThrow(TypeError);
    expect(() => issueSessionCookie(FAKE_SESSION_ID, { secure: false, maxAgeDays: 0 })).toThrow(TypeError);
    expect(() => issueSessionCookie(FAKE_SESSION_ID, { secure: false, maxAgeDays: 1.5 })).toThrow(TypeError);
  });

  it('uses the fixed, documented cookie name', () => {
    expect(SESSION_COOKIE_NAME).toBe('gitdatnote_session');
    expect(SESSION_ID_PATTERN.test(FAKE_SESSION_ID)).toBe(true);
  });
});

describe('session cookie clearing', () => {
  it('clears with matching attributes and zero lifetime', () => {
    const cookie = clearSessionCookie({ secure: false });
    expect(cookie).toBe(
      `${SESSION_COOKIE_NAME}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; SameSite=Lax`,
    );
  });

  it('includes Secure when clearing under production configuration', () => {
    expect(clearSessionCookie({ secure: true })).toContain('Secure');
  });
});

describe('session cookie parsing', () => {
  it('returns the id for a well-formed session cookie', () => {
    expect(parseSessionCookie(`${SESSION_COOKIE_NAME}=${FAKE_SESSION_ID}`)).toBe(FAKE_SESSION_ID);
  });

  it('finds the session cookie among other cookies', () => {
    expect(
      parseSessionCookie(`theme=dark; ${SESSION_COOKIE_NAME}=${FAKE_SESSION_ID}; preview=1`),
    ).toBe(FAKE_SESSION_ID);
  });

  it('treats missing headers and cookies as unauthenticated', () => {
    expect(parseSessionCookie(undefined)).toBeNull();
    expect(parseSessionCookie('')).toBeNull();
    expect(parseSessionCookie('theme=dark; preview=1')).toBeNull();
  });

  it('treats malformed values as unauthenticated without throwing', () => {
    const bad = [
      SESSION_COOKIE_NAME, // no '=' — not a cookie pair
      `${SESSION_COOKIE_NAME}=`, // empty value
      `${SESSION_COOKIE_NAME}=not-a-hex-value`,
      `${SESSION_COOKIE_NAME}=${FAKE_SESSION_ID.slice(0, 63)}`, // too short
      `${SESSION_COOKIE_NAME}=${FAKE_SESSION_ID.toUpperCase()}`, // uppercase
      `${SESSION_COOKIE_NAME}=${FAKE_SESSION_ID}x`, // too long
    ];
    for (const header of bad) {
      expect(parseSessionCookie(header)).toBeNull();
    }
  });

  it('does not match similarly named cookies', () => {
    expect(parseSessionCookie(`gitdatnote_sessionx=${FAKE_SESSION_ID}`)).toBeNull();
    expect(parseSessionCookie(`x_gitdatnote_session=${FAKE_SESSION_ID}`)).toBeNull();
  });
});

describe('Secure-flag resolution', () => {
  it('enables Secure in production mode', () => {
    expect(resolveCookieSecure({ NODE_ENV: 'production' })).toBe(true);
  });

  it('respects an explicit secure override', () => {
    expect(resolveCookieSecure({ SESSION_COOKIE_SECURE: 'true' })).toBe(true);
    expect(resolveCookieSecure({ SESSION_COOKIE_SECURE: '1' })).toBe(true);
  });

  it('omits Secure for local development by default', () => {
    expect(resolveCookieSecure({})).toBe(false);
    expect(resolveCookieSecure({ NODE_ENV: 'development', SESSION_COOKIE_SECURE: 'false' })).toBe(false);
  });
});

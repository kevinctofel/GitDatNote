/**
 * GitHub HTTP operations for the App user web flow (task 3.2).
 *
 * Every function takes an injectable `fetchImpl` so tests can mock all
 * upstream GitHub traffic. None of these functions log request or response
 * bodies: authorization codes, tokens, and profile data never reach logs.
 * Failures are `AuthError`s with stable codes; routes translate them into
 * safe client responses.
 */

import {
  GITHUB_API_BASE,
  GITHUB_TOKEN_URL,
  REFRESH_TOKEN_DEFAULT_TTL_SECONDS,
} from './config.js';
import { AuthError } from './types.js';
import type {
  AuthConfig,
  DiscoveredRepository,
  GitHubUser,
  TokenResponseData,
} from './types.js';
import { effectiveRepoAccess, installationAllowsAccess } from './permissions.js';

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

const USER_AGENT = 'GitDatNote/2.0';

function statusError(status: number): AuthError | null {
  if (status === 401) {
    return new AuthError('UNAUTHORIZED', 'GitHub rejected the request.');
  }
  if (status === 403 || status === 429) {
    return new AuthError('RATE_LIMITED', 'GitHub rate limited the request.');
  }
  if (status >= 500) {
    return new AuthError('GITHUB_UNAVAILABLE', 'GitHub API is unavailable.');
  }
  return null;
}

/**
 * Map a classifier for upstream status codes, receiving the response status
 * and the `X-RateLimit-Remaining` header value (rate-limit context).
 */
type StatusErrorMapper = (status: number, rateLimitRemaining: string | null) => AuthError | null;

/**
 * Strict error mapping for the repository authorization service
 * (task 3.4). Unlike `statusError`, it distinguishes a genuine rate limit
 * from a permission denial:
 *
 * - 401 → `UNAUTHORIZED` (the user's credentials are not valid).
 * - 429, or 403 with `X-RateLimit-Remaining: 0` → `RATE_LIMITED` (GitHub's
 *   documented rate-limit responses).
 * - any other 403 → `FORBIDDEN` (a permission denial — never an
 *   authorization success).
 * - 404 → `NOT_FOUND` (the resource does not exist for this user; a
 *   private repository must not be revealed as existing).
 * - 5xx → `GITHUB_UNAVAILABLE`.
 */
export const authorizationStatusError: StatusErrorMapper = (status, rateLimitRemaining) => {
  if (status === 401) {
    return new AuthError('UNAUTHORIZED', 'GitHub rejected the request.');
  }
  if (status === 429 || (status === 403 && rateLimitRemaining === '0')) {
    return new AuthError('RATE_LIMITED', 'GitHub rate limited the request.');
  }
  if (status === 403) {
    return new AuthError('FORBIDDEN', 'GitHub denied the request.');
  }
  if (status === 404) {
    return new AuthError('NOT_FOUND', 'The requested GitHub resource was not found.');
  }
  if (status >= 500) {
    return new AuthError('GITHUB_UNAVAILABLE', 'GitHub API is unavailable.');
  }
  return null;
};

const defaultStatusMapper: StatusErrorMapper = (status) => statusError(status);

function mapNetworkError(err: unknown): AuthError {
  if (err instanceof AuthError) return err;
  return new AuthError('GITHUB_UNAVAILABLE', 'GitHub request failed.');
}

/**
 * Exchange the authorization code for user access and refresh tokens via
 * GitHub's documented token endpoint.
 *
 * Requires `access_token`, `refresh_token`, and a positive numeric
 * `expires_in`. The refresh lifetime defaults to GitHub's documented
 * `refresh_token_expires_in` value (15,897,600 s = 6 months) when omitted.
 * Non-expiring or malformed credentials are rejected, never accepted.
 */
export async function exchangeUserToken(
  config: AuthConfig,
  code: string,
  codeVerifier: string,
  fetchImpl: FetchImpl,
): Promise<TokenResponseData> {
  let response: Response;
  try {
    response = await fetchImpl(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.callbackUrl,
        code_verifier: codeVerifier,
      }),
    });
  } catch (err) {
    throw mapNetworkError(err);
  }
  if (!response.ok) {
    throw new AuthError('TOKEN_ERROR', 'GitHub token exchange failed.');
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new AuthError('TOKEN_ERROR', 'GitHub returned a malformed token response.');
  }
  const record = (typeof data === 'object' && data !== null ? data : {}) as Record<
    string,
    unknown
  >;

  const accessToken = typeof record.access_token === 'string' ? record.access_token : '';
  const refreshToken = typeof record.refresh_token === 'string' ? record.refresh_token : '';
  if (accessToken.length === 0 || refreshToken.length === 0) {
    throw new AuthError('TOKEN_ERROR', 'Token response is missing required credentials.');
  }
  const expires_in = record.expires_in;
  if (typeof expires_in !== 'number' || !Number.isFinite(expires_in) || expires_in <= 0) {
    throw new AuthError(
      'TOKEN_ERROR',
      'Token response is missing a valid access-token lifetime.',
    );
  }
  const refreshExpiresIn =
    typeof record.refresh_token_expires_in === 'number' &&
    Number.isFinite(record.refresh_token_expires_in) &&
    record.refresh_token_expires_in > 0
      ? record.refresh_token_expires_in
      : REFRESH_TOKEN_DEFAULT_TTL_SECONDS;

  return {
    accessToken,
    refreshToken,
    accessExpiresIn: expires_in,
    refreshExpiresIn,
  };
}

/** Fetch the authenticated user's profile (`GET /user`). */
export async function fetchUserProfile(
  accessToken: string,
  fetchImpl: FetchImpl,
): Promise<GitHubUser> {
  let response: Response;
  try {
    response = await fetchImpl(`${GITHUB_API_BASE}/user`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': USER_AGENT,
      },
    });
  } catch (err) {
    throw mapNetworkError(err);
  }
  if (!response.ok) {
    const mapped = statusError(response.status);
    throw mapped ?? new AuthError('PROFILE_ERROR', 'GitHub profile fetch failed.');
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new AuthError('PROFILE_ERROR', 'GitHub returned a malformed profile response.');
  }
  const record = (typeof data === 'object' && data !== null ? data : {}) as Record<
    string,
    unknown
  >;
  const login = typeof record.login === 'string' ? record.login : '';
  if (login.length === 0) {
    throw new AuthError('PROFILE_ERROR', 'Profile is missing the login handle.');
  }
  // GitHub `name` is nullable. Sessions fall back to the login handle so
  // the session contract (non-empty string) always holds.
  const name = typeof record.name === 'string' && record.name.length > 0 ? record.name : null;
  const avatarUrl = typeof record.avatar_url === 'string' ? record.avatar_url : '';
  return { login, name, avatarUrl };
}

/**
 * Discover repositories accessible to the user through the App's
 * installations (two-step flow):
 *
 * 1. `GET /user/installations`
 * 2. `GET /user/installations/{id}/repositories` per installation
 *
 * `canRead`/`canWrite` come from the per-repository `permissions` the user
 * has inside that installation. Membership in the list never implies write
 * access, and no application-wide privileged token is used.
 *
 * Both list endpoints are paginated; `fetchAllPages` follows only trusted
 * GitHub API links, stops at a bounded page limit, and validates every page
 * against GitHub's documented response envelope (see `parseListPage`),
 * failing loudly instead of reporting a partial list as complete.
 * Installations without any contents permission are skipped entirely: none
 * of their repositories can be operated through GitDatNote.
 */
export async function listAccessibleRepositories(
  accessToken: string,
  fetchImpl: FetchImpl,
): Promise<DiscoveredRepository[]> {
  const installations = await fetchAllPages(
    '/user/installations',
    accessToken,
    fetchImpl,
    'installations',
  );
  const repos: DiscoveredRepository[] = [];
  const seen = new Set<string>();
  for (const entry of installations) {
    const record = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >;
    const id = record.id;
    if (typeof id !== 'number') continue; // Skip malformed entries.
    // Suspended installations grant no access (task 3.4: effective permission
    // requires an active App installation on the repository).
    if (typeof record.suspended_at === 'string') continue;
    const installationPermissions =
      record.permissions !== null &&
      typeof record.permissions === 'object' &&
      !Array.isArray(record.permissions)
        ? (record.permissions as Record<string, unknown>)
        : {};
    // An installation with no contents permission at all cannot operate any
    // of its repositories through GitDatNote, so it is omitted from
    // discovery entirely (OpenSpec: repositories must be operable through
    // the App). Read-only installations (contents: "read") still list their
    // repositories, with write access disabled.
    if (!installationAllowsAccess(installationPermissions, 'read')) continue;
    const list = await fetchAllPages(
      `/user/installations/${id}/repositories`,
      accessToken,
      fetchImpl,
      'repositories',
    );
    for (const item of list) {
      const repo = (typeof item === 'object' && item !== null ? item : {}) as Record<
        string,
        unknown
      >;
      const owner = (repo.owner as Record<string, unknown> | undefined)?.login;
      const name = repo.name;
      if (typeof owner !== 'string' || typeof name !== 'string' || owner === '' || name === '') {
        continue; // Skip malformed entries.
      }
      const key = `${owner}/${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const permissions = repo.permissions as Record<string, unknown> | undefined;
      const userPermissions =
        permissions !== null && typeof permissions === 'object' && !Array.isArray(permissions)
          ? (permissions as Record<string, unknown>)
          : {};
      // Task 3.4: canRead/canWrite reflect the effective intersection of the
      // user's per-repository permissions and the installation-level
      // permissions, so a repository is never listed as writable without
      // verified write access on both sides.
      repos.push({
        owner,
        name,
        canRead: effectiveRepoAccess(userPermissions, installationPermissions, 'read'),
        canWrite: effectiveRepoAccess(userPermissions, installationPermissions, 'write'),
        isPrivate: repo.private === true,
      });
    }
  }
  return repos;
}

/** GitHub's maximum `per_page` value. */
const PER_PAGE = 100;
/**
 * Safety cap on pages fetched per list endpoint. 100 pages x 100 items =
 * 10,000 items; if GitHub ever advertises more, discovery fails loudly
 * instead of silently returning a partial list.
 */
const MAX_PAGES = 100;

/**
 * Classify the `rel="next"` entry of a GitHub `Link` header:
 *
 * - `none`      — no `rel="next"` entry: pagination is complete.
 * - `next`      — a valid link on the trusted GitHub API origin with the
 *                 exact path requested: safe to follow.
 * - `untrusted` — a `rel="next"` entry that is malformed, non-HTTPS,
 *                 cross-origin, or points at a different path. It must never
 *                 be followed and must not cause a partial list to be
 *                 reported as complete.
 */
type NextPageLink =
  | { readonly kind: 'none' }
  | { readonly kind: 'next'; readonly url: URL }
  | { readonly kind: 'untrusted' };

function nextPageLink(linkHeader: string | null, path: string): NextPageLink {
  if (linkHeader === null) return { kind: 'none' };
  for (const part of linkHeader.split(',')) {
    // `rel="next"` (quoted or bare), not a longer token such as "nextfoo".
    if (!/rel=["']?next["']?(?![a-z0-9])/i.test(part)) continue;
    const match = part.match(/<([^>]+)>/);
    if (match === null || match[1] === undefined) return { kind: 'untrusted' };
    let next: URL;
    try {
      next = new URL(match[1]);
    } catch {
      return { kind: 'untrusted' };
    }
    if (next.origin !== GITHUB_API_BASE || next.pathname !== path) {
      return { kind: 'untrusted' };
    }
    return { kind: 'next', url: next };
  }
  return { kind: 'none' };
}

/**
 * The paginated list endpoints supported by `fetchAllPages`. GitHub's
 * documented responses for both are JSON objects containing the array —
 * never bare arrays (https://docs.github.com/en/rest/apps/installations):
 *
 * - `GET /user/installations` →
 *     `{ "total_count": <int>, "installations": [...] }`
 * - `GET /user/installations/{installation_id}/repositories` →
 *     `{ "total_count": <int>, "repository_selection"?: <string>,
 *        "repositories": [...] }`
 */
type ListEndpoint = 'installations' | 'repositories';

/**
 * Validate one page of a paginated list endpoint against the documented
 * response envelope for `endpoint`.
 *
 * Rejects (fail closed — never a silent empty list, never a partial list):
 * - bare arrays or non-object bodies: the list must be the named field;
 * - a missing or non-integer `total_count`;
 * - a missing, non-array, or oversized `installations`/`repositories`
 *   field — arbitrary other fields are never accepted as the list;
 * - a `total_count` inconsistent with the items collected so far.
 *
 * `total_count` is validated for consistency but never used to drive
 * pagination itself: traversal is driven solely by trusted `Link` headers.
 */
function parseListPage(data: unknown, endpoint: ListEndpoint, collectedCount: number): unknown[] {
  const listField = endpoint === 'installations' ? 'installations' : 'repositories';
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new AuthError('INTERNAL', 'GitHub returned a malformed list response.');
  }
  const envelope = data as Record<string, unknown>;
  const totalCount = envelope['total_count'];
  if (typeof totalCount !== 'number' || !Number.isInteger(totalCount) || totalCount < 0) {
    throw new AuthError('INTERNAL', 'GitHub returned a malformed list response.');
  }
  const items = envelope[listField];
  if (!Array.isArray(items) || items.length > PER_PAGE) {
    throw new AuthError('INTERNAL', 'GitHub returned a malformed list response.');
  }
  if (collectedCount + items.length > totalCount) {
    throw new AuthError('INTERNAL', 'GitHub returned inconsistent pagination metadata.');
  }
  return items;
}

/**
 * Fetch every page of a GitHub list endpoint, enforcing the security limits
 * of task 3.2 (bounded pages, trusted pagination links). `statusMapper`
 * classifies non-2xx responses; the default preserves the established
 * behavior for the existing discovery flow.
 *
 * Every page body must match the documented envelope for `endpoint` (see
 * `parseListPage`); a malformed page is a hard failure, never a partial
 * list. Any present-but-untrusted next link (malformed, non-HTTPS,
 * cross-origin, or off-path) aborts with `DISCOVERY_LINK_UNTRUSTED`; if the
 * page limit is reached while more pages remain, throws
 * `DISCOVERY_LIMIT_EXCEEDED`.
 */
export async function fetchAllPages(
  path: string,
  accessToken: string,
  fetchImpl: FetchImpl,
  endpoint: ListEndpoint,
  statusMapper: StatusErrorMapper = defaultStatusMapper,
): Promise<unknown[]> {
  let url = new URL(GITHUB_API_BASE + path);
  url.searchParams.set('per_page', String(PER_PAGE));
  const items: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': USER_AGENT,
        },
      });
    } catch (err) {
      throw mapNetworkError(err);
    }
    if (!response.ok) {
      const mapped = statusMapper(response.status, response.headers.get('x-ratelimit-remaining'));
      throw mapped ?? new AuthError('INTERNAL', 'GitHub returned an unexpected error.');
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new AuthError('INTERNAL', 'GitHub returned a malformed response.');
    }
    items.push(...parseListPage(data, endpoint, items.length));
    const link = nextPageLink(response.headers.get('link'), path);
    if (link.kind === 'untrusted') {
      throw new AuthError(
        'DISCOVERY_LINK_UNTRUSTED',
        'Repository discovery received an untrusted pagination link.',
      );
    }
    if (link.kind === 'none') break;
    url = link.url;
    if (page === MAX_PAGES) {
      throw new AuthError(
        'DISCOVERY_LIMIT_EXCEEDED',
        'Repository discovery reached its pagination safety limit.',
      );
    }
  }
  return items;
}

/**
 * Task 3.4 — reusable server-side repository authorization service.
 *
 * `authorizeRepository` verifies, with the connected user's own
 * server-side GitHub App user access token, that BOTH conditions hold for
 * the requested repository and access level (design.md A-01/A-02):
 *
 *   1. The connected user's permission on the repository — per-repository
 *      `permissions` from `GET /user/installations/{installation_id}/repositories`.
 *   2. The GitHub App installation's access — the installation must belong
 *      to the requested owner, be unsuspended, carry the required
 *      installation-level content permission (`permissions.contents` from
 *      `GET /user/installations`), and list the repository in its selected
 *      repository set.
 *
 * Only the authenticated user's token is used (the same credential already
 * used by repository discovery); no App-level JWT or installation token is
 * required or used. No credentials are returned, logged, or included in
 * the result.
 *
 * Failure semantics:
 * - Semantic failures return a typed `RepositoryAuthorization` result:
 *   `unauthorized` (no valid session credentials / GitHub 401) and
 *   `denied` (any authorization condition fails, including GitHub 403/404,
 *   missing/malformed permission data, and repositories outside the
 *   installation's selection).
 * - Transport failures propagate as `AuthError` for the caller to map to
 *   the established contracts: `RATE_LIMITED` (429), `GITHUB_UNAVAILABLE`
 *   (502), `INTERNAL` (500).
 *
 * Every authorization decision is computed from a fresh upstream response;
 * permission state from an earlier discovery call is never cached or
 * trusted.
 */

import { AuthError } from './types.js';
import type { InstallationInfo, InstallationRepositoryInfo } from './types.js';
import type { StoredSession } from '../session/types.js';
import { authorizationStatusError, fetchAllPages } from './github.js';
import {
  effectiveRepoAccess,
  installationAllowsAccess,
  validateRepositoryRef,
  type RequiredRepoAccess,
} from './permissions.js';

/**
 * Typed authorization outcome. `authorized` carries only what downstream
 * server handlers need (owner, repo, access) — never tokens, credentials,
 * or installation details.
 */
export type RepositoryAuthorization =
  | {
      readonly status: 'authorized';
      readonly owner: string;
      readonly repo: string;
      readonly access: RequiredRepoAccess;
    }
  | { readonly status: 'unauthorized' }
  | { readonly status: 'denied' };

/** Injectable dependencies (testability without real GitHub credentials). */
export interface AuthorizeRepositoryDeps {
  readonly fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

type PermissionMap = Record<string, unknown>;

function asPermissionMap(value: unknown): PermissionMap {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as PermissionMap)
    : {};
}

/** Normalize `GET /user/installations` entries; malformed entries are skipped. */
function parseInstallations(entries: unknown[]): InstallationInfo[] {
  const out: InstallationInfo[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'number' || !Number.isSafeInteger(record.id)) continue;
    let account: InstallationInfo['account'] = null;
    const rawAccount = record.account;
    if (rawAccount !== null && typeof rawAccount === 'object' && !Array.isArray(rawAccount)) {
      const a = rawAccount as Record<string, unknown>;
      if (typeof a.login === 'string' && a.login.length > 0 && typeof a.id === 'number') {
        account = { login: a.login, id: a.id };
      }
    }
    out.push({
      id: record.id,
      account,
      permissions: asPermissionMap(record.permissions),
      suspendedAt: typeof record.suspended_at === 'string' ? record.suspended_at : null,
    });
  }
  return out;
}

/**
 * Normalize `GET /user/installations/{id}/repositories` entries; malformed
 * entries are skipped. Missing or malformed `permissions` become an empty
 * map, which authorizes nothing (fail closed).
 */
function parseInstallationRepositories(entries: unknown[]): InstallationRepositoryInfo[] {
  const out: InstallationRepositoryInfo[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const owner = (record.owner as Record<string, unknown> | undefined)?.login;
    if (typeof owner !== 'string' || owner.length === 0) continue;
    if (typeof record.name !== 'string' || record.name.length === 0) continue;
    out.push({
      owner,
      name: record.name,
      isPrivate: record.private === true,
      permissions: asPermissionMap(record.permissions),
    });
  }
  return out;
}

/**
 * Map an upstream failure to a semantic outcome, or rethrow transport
 * failures for the caller to map to `429`/`502`/`500`.
 *
 * - GitHub 401 → `unauthorized` (the user's credentials are not valid).
 * - GitHub 403/404 → `denied` (permission denial or missing resource must
 *   never become an authorization success, and must not expose the
 *   existence of private repositories).
 */
function mapUpstreamError(err: unknown): RepositoryAuthorization {
  if (err instanceof AuthError) {
    if (err.code === 'UNAUTHORIZED') return { status: 'unauthorized' };
    if (err.code === 'FORBIDDEN' || err.code === 'NOT_FOUND') return { status: 'denied' };
    // RATE_LIMITED, GITHUB_UNAVAILABLE, INTERNAL, DISCOVERY_* — propagate.
    throw err;
  }
  throw new AuthError('INTERNAL', 'Internal error.');
}

/**
 * Authorize a repository operation for the connected user.
 *
 * @param session        The authenticated session (null → `unauthorized`).
 * @param owner          The repository owner (validated before any request).
 * @param repo           The repository name (validated before any request).
 * @param requiredAccess `read` or `write`.
 * @param deps           Injectable GitHub transport (defaults to `fetch`).
 */
export async function authorizeRepository(
  session: StoredSession | null,
  owner: string,
  repo: string,
  requiredAccess: RequiredRepoAccess,
  deps: AuthorizeRepositoryDeps = {},
): Promise<RepositoryAuthorization> {
  // Local validation first: malformed references are denied without any
  // upstream request (and never echoed back).
  if (!validateRepositoryRef(owner, repo)) {
    return { status: 'denied' };
  }
  const token = session?.credentials.accessToken;
  if (typeof token !== 'string' || token.length === 0) {
    return { status: 'unauthorized' };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;

  // 1) Find the installation for the requested owner.
  //    Deterministic selection: skip suspended installations, match the
  //    account login case-insensitively, and use the lowest installation id
  //    when multiple installations match (stable across calls).
  let installation: InstallationInfo | null = null;
  try {
    const installations = parseInstallations(
      await fetchAllPages(
        '/user/installations',
        token,
        fetchImpl,
        'installations',
        authorizationStatusError,
      ),
    );
    installation =
      installations
        .filter(
          (i) =>
            i.suspendedAt === null &&
            i.account !== null &&
            i.account.login.toLowerCase() === owner.toLowerCase(),
        )
        .sort((a, b) => a.id - b.id)[0] ?? null;
  } catch (err) {
    return mapUpstreamError(err);
  }
  return finalizeAuthorization(installation, owner, repo, requiredAccess, token, fetchImpl);
}

/**
 * Second stage: installation-level gate, then repository-level gate.
 * Split out for readability; both stages use fresh upstream data.
 */
async function finalizeAuthorization(
  installation: InstallationInfo | null,
  owner: string,
  repo: string,
  requiredAccess: RequiredRepoAccess,
  token: string,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<RepositoryAuthorization> {
  if (installation === null) {
    // No unsuspended installation for this owner: the App has no access to
    // the repository (installation access alone would not grant the user
    // access, and the user's access alone would not grant the App access).
    return { status: 'denied' };
  }

  // 2) App-level gate: the installation itself must carry the required
  //    content permission. An installation's general permission never
  //    applies beyond its own selected repository set.
  if (!installationAllowsAccess(installation.permissions, requiredAccess)) {
    return { status: 'denied' };
  }

  // 3) Repository-level gate: the repository must be inside this
  //    installation's selected repository set, and the user must have the
  //    required per-repository permission. Duplicate entries with
  //    inconsistent permissions fail closed (all must authorize).
  let repositories: InstallationRepositoryInfo[];
  try {
    repositories = parseInstallationRepositories(
      await fetchAllPages(
        `/user/installations/${installation.id}/repositories`,
        token,
        fetchImpl,
        'repositories',
        authorizationStatusError,
      ),
    );
  } catch (err) {
    return mapUpstreamError(err);
  }

  const matches = repositories.filter(
    (r) =>
      r.owner.toLowerCase() === owner.toLowerCase() && r.name.toLowerCase() === repo.toLowerCase(),
  );
  if (matches.length === 0) {
    return { status: 'denied' };
  }
  const allAuthorized = matches.every((r) =>
    effectiveRepoAccess(r.permissions, installation.permissions, requiredAccess),
  );
  if (!allAuthorized) {
    return { status: 'denied' };
  }
  return { status: 'authorized', owner, repo, access: requiredAccess };
}

/**
 * Task 3.4 — shared evaluation of effective repository permissions.
 *
 * GitDatNote's authorization model (design.md A-01/A-02) requires BOTH
 * conditions before any repository operation:
 *
 *   1. The connected user has the required permission on the repository —
 *      the per-repository `permissions` object reported by
 *      `GET /user/installations/{installation_id}/repositories` (the
 *      user's own permissions: `pull` for read, `push` for write).
 *   2. The GitHub App's installation has the required content permission —
 *      the installation-level `permissions` object reported by
 *      `GET /user/installations` (e.g. `contents: "read"` or
 *      `contents: "write"`), with the repository inside that
 *      installation's selected repository set (implied by the repository
 *      appearing in the installation's repository listing).
 *
 * The effective permission is the intersection of the two. A repository is
 * readable only when the user can pull AND the installation's content
 * permission is `read` or `write`; writable only when the user can push
 * (and pull) AND the installation's content permission is `write`.
 *
 * Missing, malformed, or ambiguous fields always evaluate to no access
 * (fail-closed). These helpers are shared by repository discovery
 * (`GET /api/repositories`) and the per-operation authorization service so
 * the two surfaces can never drift apart.
 */

/** Access level required for a repository operation. */
export type RequiredRepoAccess = 'read' | 'write';

/** Normalized installation-level content permission. */
export type ContentPermission = 'none' | 'read' | 'write';

/**
 * Normalize the installation-level `permissions` object from
 * `GET /user/installations` to its effective `contents` permission level.
 *
 * GitHub reports this object as a map of permission names to
 * `"read"`/`"write"`/`"none"` strings. Anything missing, non-object,
 * non-string, or otherwise unexpected normalizes to `'none'` — a
 * malformed installation can never be treated as authorized.
 */
export function installationContentPermission(permissions: unknown): ContentPermission {
  if (permissions === null || typeof permissions !== 'object' || Array.isArray(permissions)) {
    return 'none';
  }
  const contents = (permissions as Record<string, unknown>).contents;
  if (contents === 'read' || contents === 'write') {
    return contents;
  }
  return 'none';
}

/**
 * Does the installation-level permission object grant the required access?
 *
 * - `read`: `contents` is `read` or `write`.
 * - `write`: `contents` is exactly `write`.
 */
export function installationAllowsAccess(
  permissions: unknown,
  required: RequiredRepoAccess,
): boolean {
  const level = installationContentPermission(permissions);
  if (required === 'read') {
    return level === 'read' || level === 'write';
  }
  return level === 'write';
}

/**
 * Does the per-repository user permission object (from
 * `GET /user/installations/{installation_id}/repositories`) grant the
 * required access to the connected user?
 *
 * - `read`: `pull === true`.
 * - `write`: `push === true && pull === true` — a `push` without `pull` is a
 *   malformed/ambiguous combination and never grants write access.
 *
 * Missing fields or non-boolean values never grant access.
 */
export function userAllowsAccess(permissions: unknown, required: RequiredRepoAccess): boolean {
  if (permissions === null || typeof permissions !== 'object' || Array.isArray(permissions)) {
    return false;
  }
  const p = permissions as Record<string, unknown>;
  if (required === 'read') {
    return p.pull === true;
  }
  return p.push === true && p.pull === true;
}

/**
 * Effective repository access: the intersection of the user's permission
 * and the installation's content permission. Both must grant the required
 * access.
 */
export function effectiveRepoAccess(
  userPermissions: unknown,
  installationPermissions: unknown,
  required: RequiredRepoAccess,
): boolean {
  return (
    userAllowsAccess(userPermissions, required) &&
    installationAllowsAccess(installationPermissions, required)
  );
}

/** GitHub user/organization login: 1–39 chars, alphanumeric with hyphens. */
const REPOSITORY_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** GitHub repository name: 1–100 chars, alphanumeric with `.`, `_`, `-`. */
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Validate a client-supplied repository reference before any upstream
 * request is made. Malformed references are rejected locally (never sent
 * upstream, never echoed back).
 */
export function validateRepositoryRef(owner: string, repo: string): boolean {
  return REPOSITORY_OWNER_PATTERN.test(owner) && REPOSITORY_NAME_PATTERN.test(repo);
}

/**
 * Task 5.3 — offline safety helpers for the opt-in real-GitHub integration
 * suite. Pure functions only: no I/O, no network, no credentials, no
 * repository access. These helpers define and revalidate the unique run
 * directory and the exact files this run may create or delete, so the live
 * suite and its cleanup can never touch paths outside the isolated run
 * directory.
 */

import { randomBytes } from "node:crypto";

import {
  DEDICATED_REPO_PATTERN,
  isIntegrationEnabled,
  parseRepositoryId,
  PLACEHOLDER_REPOSITORY_VALUES,
  PRODUCTION_SOURCE_REPOSITORY,
  REPO_VAR,
  RESERVED_REPOSITORY_NAMES,
  validateIntegrationConfig,
  type IntegrationEnv,
} from './config.js';

/** Fixed prefix of every integration run directory. */
export const RUN_DIR_PREFIX = "__gitdatnote-integration-";

/** The single Markdown file this test lifecycle creates per run. */
export const RUN_FILE_NAME = "integration-article.md";

/**
 * Structural pattern for a run directory:
 * `__gitdatnote-integration-<YYYY-MM-DD>T<HH>-<MM>-<SS>-<mmm>Z-<6 lowercase hex>`
 * (filename-safe UTC ISO timestamp plus a collision suffix).
 */
const RUN_DIR_PATTERN =
  /^__gitdatnote-integration-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-([0-9a-f]{6})$/;

/** Default collision suffix: 6 lowercase hex chars (24 bits). */
export function defaultRunSuffix(): string {
  return randomBytes(3).toString("hex");
}

/**
 * Generate the unique, filename-safe run directory for this test run.
 *
 * `now` and `suffixGenerator` are injectable for deterministic offline tests;
 * live runs use the real clock and random suffix so simultaneous invocations
 * of the suite never share a directory.
 */
export function generateRunDirectory(
  now: Date = new Date(),
  suffixGenerator: () => string = defaultRunSuffix,
): string {
  const iso = now.toISOString().replace(/[:.]/g, "-");
  return `${RUN_DIR_PREFIX}${iso}-${suffixGenerator()}`;
}

/** True only for well-formed, valid run-directory names. */
export function isRunDirectory(value: string): boolean {
  if (typeof value !== "string") return false;
  const match = RUN_DIR_PATTERN.exec(value);
  if (!match) return false;
  // Reconstruct the timestamp and verify it is a real UTC date/time.
  const [, year, month, day, hour, minute, second, ms] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.${ms}Z`;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return false;
  if (parsed.toISOString() !== iso) return false; // rejects impossible dates (e.g. 2026-13-40)
  return true;
}

/**
 * Content-root guard shared by path construction and cleanup validation.
 * The root is the repository-relative content root (e.g. `src/posts`); it
 * must never be absolute, traversing, or otherwise uncontrolled.
 */
export function isContentRootSafe(contentRoot: string): boolean {
  if (typeof contentRoot !== "string") return false;
  // An empty root means the repository root itself, which is a valid
  // content root for the adapter contract.
  if (contentRoot.length === 0) return true;
  if (contentRoot.startsWith("/") || contentRoot.startsWith("\\")) return false;
  if (contentRoot.includes("\\")) return false;
  // Rejects embedded control characters (legitimate guard).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(contentRoot)) return false;
  for (const segment of contentRoot.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") return false;
  }
  return true;
}

/** Artifact path result: OK with the exact relative + repository paths. */
export interface RunArtifactPath {
  ok: true;
  /** Path relative to the content root, e.g. `<runDir>/integration-article.md`. */
  relativePath: string;
  /** Path relative to the repository root, e.g. `src/posts/<runDir>/...`. */
  repositoryPath: string;
}

export interface RunArtifactPathRejection {
  ok: false;
  reason: string;
}

/**
 * Build the artifact paths for one run from validated components only.
 * The result is always inside `contentRoot/<runDirectory>/`, never the
 * content root itself, never absolute, and never traversing.
 */
export function buildRunArtifactPath(
  contentRoot: string,
  runDirectory: string,
  fileName: string,
): RunArtifactPath | RunArtifactPathRejection {
  if (!isContentRootSafe(contentRoot)) {
    return { ok: false, reason: "content root is not a safe repository-relative path" };
  }
  if (!isRunDirectory(runDirectory)) {
    return { ok: false, reason: "run directory is not a well-formed integration run directory" };
  }
  if (
    typeof fileName !== "string" ||
    fileName.length === 0 ||
    fileName.startsWith(".") ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    // Rejects control characters in file names (legitimate guard).
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f]/.test(fileName)
  ) {
    return { ok: false, reason: "file name is not a safe single path segment" };
  }
  const relativePath = `${runDirectory}/${fileName}`;
  const repositoryPath =
    contentRoot.length === 0 ? relativePath : `${contentRoot}/${relativePath}`;
  return { ok: true, relativePath, repositoryPath };
}

/**
 * Revalidate a repository path before the cleanup deletes it. The path must
 * be exactly one of this run's owned artifact paths — the same run
 * directory, under the same content root, with one of the owned file
 * names. Everything else (other run directories, sibling files, traversal,
 * absolute paths, the repository root, `README.md`, ...) is rejected.
 */
export function validateRunCleanupPath(
  contentRoot: string,
  runDirectory: string,
  ownedFileNames: readonly string[],
  repositoryPath: string,
): { ok: true } | { ok: false; reason: string } {
  if (!isContentRootSafe(contentRoot)) {
    return { ok: false, reason: "content root is not a safe repository-relative path" };
  }
  if (!isRunDirectory(runDirectory)) {
    return { ok: false, reason: "run directory is not a well-formed integration run directory" };
  }
  const owned = new Set(ownedFileNames);
  for (const name of owned) {
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.startsWith(".") ||
      name.includes("/") ||
      name.includes("\\")
    ) {
      return { ok: false, reason: "owned file list contains an unsafe file name" };
    }
  }
  if (typeof repositoryPath !== "string" || repositoryPath.length === 0) {
    return { ok: false, reason: "cleanup path is empty" };
  }
  if (repositoryPath.startsWith("/") || repositoryPath.startsWith("\\")) {
    return { ok: false, reason: "cleanup path is absolute" };
  }
  const runDirPath =
    contentRoot.length === 0 ? runDirectory : `${contentRoot}/${runDirectory}`;
  if (
    repositoryPath === contentRoot ||
    !repositoryPath.startsWith(`${runDirPath}/`)
  ) {
    return { ok: false, reason: "cleanup path is outside this run's isolated directory" };
  }
  const name = repositoryPath.slice(runDirPath.length + 1);
  if (name.length === 0 || name.includes("/")) {
    return { ok: false, reason: "cleanup path is not an immediate file inside the run directory" };
  }
  if (!owned.has(name)) {
    return { ok: false, reason: "cleanup path is not a file created by this run" };
  }
  return { ok: true };
}

/**
 * Case-insensitive identity check between the configured `OWNER/REPO` and
 * the `full_name` returned by GitHub for the preflight lookup.
 */
export function repositoryIdentityMatches(
  configuredRepositoryId: string,
  reportedFullName: string,
): boolean {
  if (typeof reportedFullName !== "string" || reportedFullName.length === 0) {
    return false;
  }
  return reportedFullName.toLowerCase() === configuredRepositoryId.toLowerCase();
}

/** The specific policy rule that rejected a preflight identity. */
export type PreflightPolicyFailure =
  | 'identity-mismatch'
  | 'reserved-target'
  | 'production-source-repository'
  | 'placeholder-value'
  | 'naming-convention';

/** Result of the pure preflight identity/policy check. */
export type PreflightPolicyResult =
  | { ok: true }
  | { ok: false; failure: PreflightPolicyFailure; message: string };

/**
 * Minimal pure preflight identity/policy check for the live content test.
 *
 * Given the configured repository and the repository identity GitHub
 * actually reported, decide (offline, no network) whether the target is
 * acceptable for integration writes:
 *
 * 1. The reported `owner/name` must match the configured `OWNER/REPO`
 *    case-insensitively (the repository metadata request itself is
 *    read-only; this check is what binds the reported identity to the
 *    configured target before any mutation).
 * 2. Reserved production names (SecondBrain) are rejected.
 * 3. The GitDatNote application source repository is rejected as the EXACT
 *    owner/repository pair (case-insensitive), reusing
 *    `PRODUCTION_SOURCE_REPOSITORY` — the owner alone never blocks a
 *    properly named dedicated test repository under that owner.
 * 4. Placeholder owner or repository values are rejected.
 * 5. The repository name must follow the exact dedicated integration-test
 *    naming convention (`DEDICATED_REPO_PATTERN`) from `integration/config.js`.
 *
 * The function is pure and deterministic so the full policy — including the
 * production-source exclusion — is regression-testable offline without any
 * GitHub contact.
 */
export function checkPreflightPolicy(args: {
  configuredOwner: string;
  configuredRepo: string;
  reportedOwnerLogin: string;
  reportedRepoName: string;
}): PreflightPolicyResult {
  const { configuredOwner, configuredRepo, reportedOwnerLogin, reportedRepoName } = args;
  if (
    !repositoryIdentityMatches(
      `${configuredOwner}/${configuredRepo}`,
      `${reportedOwnerLogin}/${reportedRepoName}`,
    )
  ) {
    return {
      ok: false,
      failure: 'identity-mismatch',
      message:
        'the repository identity returned by GitHub does not match the configured repository',
    };
  }
  const ownerLc = reportedOwnerLogin.toLowerCase();
  const nameLc = reportedRepoName.toLowerCase();
  if (
    RESERVED_REPOSITORY_NAMES.includes(nameLc) ||
    RESERVED_REPOSITORY_NAMES.includes(ownerLc)
  ) {
    return {
      ok: false,
      failure: 'reserved-target',
      message: 'the repository is a reserved production target',
    };
  }
  if (
    ownerLc === PRODUCTION_SOURCE_REPOSITORY.owner &&
    nameLc === PRODUCTION_SOURCE_REPOSITORY.repo
  ) {
    return {
      ok: false,
      failure: 'production-source-repository',
      message:
        'the GitDatNote application source repository is never an integration target',
    };
  }
  if (
    PLACEHOLDER_REPOSITORY_VALUES.includes(ownerLc) ||
    PLACEHOLDER_REPOSITORY_VALUES.includes(nameLc)
  ) {
    return {
      ok: false,
      failure: 'placeholder-value',
      message: 'the repository name is a placeholder value',
    };
  }
  if (!DEDICATED_REPO_PATTERN.test(nameLc)) {
    return {
      ok: false,
      failure: 'naming-convention',
      message:
        'the repository name does not follow the exact dedicated integration-test naming convention',
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Live configuration resolution (task 5.3 review fix)
// ---------------------------------------------------------------------------

export type LiveIntegrationConfig =
  | { ok: true; owner: string; repo: string }
  | { ok: false; errors: string[] };

/**
 * Fail-closed resolution of the live integration target from environment
 * variables ONLY: validates the accepted configuration contract
 * (integration/config.js) including the opt-in flag, then parses the exact
 * owner/repo with the existing parseRepositoryId. The token is intentionally
 * NOT resolved here — the caller reads GITHUB_INTEGRATION_TOKEN itself only
 * after this succeeds — so the credential never appears in configuration
 * values, errors, or diagnostics. No repository or credential is inferred
 * from any other source.
 */
export function resolveLiveIntegrationConfig(env: IntegrationEnv): LiveIntegrationConfig {
  if (!isIntegrationEnabled(env)) {
    return { ok: false, errors: ["the integration opt-in flag is not enabled"] };
  }
  const validation = validateIntegrationConfig(env);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }
  // Validation guarantees the repository value parses; fail closed anyway.
  const repositoryId = parseRepositoryId(env[REPO_VAR]);
  if (repositoryId === null) {
    return {
      ok: false,
      errors: ["the configured repository value did not parse to owner/repo"],
    };
  }
  return { ok: true, owner: repositoryId.owner, repo: repositoryId.repo };
}

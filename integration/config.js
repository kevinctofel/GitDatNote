/**
 * Integration-test configuration contract (OpenSpec task 5.1).
 *
 * Pure, offline, fail-closed validation of the opt-in GitHub integration
 * test environment. This module:
 *
 * - performs NO network I/O (nothing here ever contacts GitHub),
 * - NEVER prints credential values — errors name variables, not values,
 * - never infers a repository from a git remote, GitHub profile, or
 *   production configuration; only the three explicit environment
 *   variables are consulted.
 *
 * Environment variables (all optional; the suite is opt-in):
 *
 *   GITHUB_INTEGRATION      must be exactly "true" to enable the suite
 *   GITHUB_INTEGRATION_REPO "OWNER/REPO" of the dedicated test repository
 *   GITHUB_INTEGRATION_TOKEN secret with Contents read/write on that repo
 *
 * Used by: integration/setup.mjs (--check), integration/run.mjs
 * (test:integration), integration/harness.test.ts (opt-in suite), and
 * tests/unit/integration-config.test.ts (deterministic unit tests).
 */

export const OPT_IN_VAR = 'GITHUB_INTEGRATION';
export const REPO_VAR = 'GITHUB_INTEGRATION_REPO';
export const TOKEN_VAR = 'GITHUB_INTEGRATION_TOKEN';

/**
 * Dedicated test-repository naming convention (fail-closed).
 *
 * The repository name must be exactly this prefix, optionally followed by
 * one `-<lowercase-word>` suffix (e.g. `gitdatnote-integration-test-run2`).
 * Matched case-insensitively. Naming rules alone do NOT prove a repository
 * is safe — the operator must also confirm the repository is dedicated to
 * GitDatNote integration tests and contains no production data.
 */
export const DEDICATED_REPO_PREFIX = 'gitdatnote-integration-test';
export const DEDICATED_REPO_PATTERN =
  /^gitdatnote-integration-test(?:-[a-z0-9]+)?$/i;

/** The GitDatNote application source repository — never an integration target. */
export const PRODUCTION_SOURCE_REPOSITORY = {
  owner: 'kevinctofel',
  repo: 'gitdatnote',
};

/**
 * Reserved names rejected as integration targets (case-insensitive).
 * The SecondBrain vault is live production content for the user.
 */
export const RESERVED_REPOSITORY_NAMES = ['secondbrain'];

/** Obvious placeholder owner/repository values (lowercased). */
export const PLACEHOLDER_REPOSITORY_VALUES = [
  'owner',
  'repo',
  'your-owner',
  'your-repo',
  'your-repo-name',
  'your-org',
  'your-organization',
  'your-username',
  'example',
  'example-repo',
  'sample',
  'sample-repo',
  'test',
  'test-repo',
  'testrepo',
  'my-repo',
  'gitdatnote',
  'gitdatnote-2',
  'changeme',
  'change-me',
  'todo',
  'placeholder',
  '<owner>',
  '<repo>',
];

/** Obvious placeholder token values (lowercased). */
export const PLACEHOLDER_TOKEN_VALUES = [
  '<secret>',
  '<token>',
  '<your-token>',
  '<your-pat>',
  '<pat>',
  'your-token',
  'your-token-here',
  'your-pat',
  'secret',
  'changeme',
  'change-me',
  'todo',
  'placeholder',
  'dummy',
];

/** GitHub identifier formats (single-slash OWNER/REPO, no spaces/URLs). */
const OWNER_PATTERN = /^[A-Za-z0-9-]{1,39}$/;
const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const REPO_ID_PATTERN = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/;

/**
 * Whether the integration suite is enabled. Only the literal string
 * `"true"` enables it — `"TRUE"`, `"1"`, `"yes"`, empty, or unset are all
 * disabled. (Fail-closed: an ambiguous value must not start a live suite.)
 */
export function isIntegrationEnabled(env = {}) {
  return env[OPT_IN_VAR] === 'true';
}

/**
 * Parse an `OWNER/REPO` identifier. Returns `null` for anything malformed:
 * missing/extra slashes, any whitespace (leading, trailing, or internal),
 * URL schemes, empty parts, or oversized names. Values are NOT trimmed —
 * fail-closed.
 */
export function parseRepositoryId(value) {
  if (typeof value !== 'string') return null;
  const match = REPO_ID_PATTERN.exec(value);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2];
  if (!OWNER_PATTERN.test(owner) || !REPO_NAME_PATTERN.test(repo)) return null;
  return { owner, repo };
}

/**
 * Validate the full opt-in integration configuration (fail-closed).
 *
 * Returns `{ ok, errors }` where `errors` is a list of human-readable,
 * secret-free messages (all problems are reported, not just the first).
 * `errors` NEVER contains the token value or any other credential.
 */
export function validateIntegrationConfig(env = {}) {
  const errors = [];

  if (env[OPT_IN_VAR] !== 'true') {
    errors.push(
      `${OPT_IN_VAR} must be set to exactly "true" to enable integration tests (set it in your shell or a gitignored .env — never in a committed file).`
    );
  }

  const repoRaw = env[REPO_VAR];
  if (typeof repoRaw !== 'string' || repoRaw.trim() === '') {
    errors.push(
      `${REPO_VAR} is missing. Set it to the dedicated test repository, e.g. "OWNER/gitdatnote-integration-test". No default repository is ever inferred.`
    );
  } else if (/<[^>]*>/.test(repoRaw)) {
    errors.push(
      `${REPO_VAR} uses a placeholder value (angle-bracket template text). Create the dedicated test repository first and use its real "OWNER/REPO" identifier.`
    );
  } else {
    const parsed = parseRepositoryId(repoRaw);
    if (!parsed) {
      errors.push(
        `${REPO_VAR} must be exactly "OWNER/REPO" (one slash, no spaces, no URL scheme). The configured value is malformed.`
      );
    } else {
      const ownerLc = parsed.owner.toLowerCase();
      const repoLc = parsed.repo.toLowerCase();

      if (
        PLACEHOLDER_REPOSITORY_VALUES.includes(ownerLc) ||
        PLACEHOLDER_REPOSITORY_VALUES.includes(repoLc)
      ) {
        errors.push(
          `The configured repository "${repoRaw.trim()}" uses an obvious placeholder owner or name. Create the dedicated test repository first and use its real "OWNER/REPO" identifier.`
        );
      }

      if (
        ownerLc === PRODUCTION_SOURCE_REPOSITORY.owner &&
        repoLc === PRODUCTION_SOURCE_REPOSITORY.repo
      ) {
        errors.push(
          `The GitDatNote application source repository (${PRODUCTION_SOURCE_REPOSITORY.owner}/GitDatNote) is rejected as an integration target. Integration tests must never run against the application source repository.`
        );
      }

      if (
        RESERVED_REPOSITORY_NAMES.includes(repoLc) ||
        RESERVED_REPOSITORY_NAMES.includes(ownerLc)
      ) {
        errors.push(
          `The name "SecondBrain" is reserved (live production vault) and is rejected as an integration target, case-insensitively.`
        );
      }

      if (!DEDICATED_REPO_PATTERN.test(repoLc)) {
        errors.push(
          `${REPO_VAR} must name a dedicated integration-test repository following the convention "${DEDICATED_REPO_PREFIX}" (optionally with one "-suffix"). Naming rules alone do not prove safety — confirm the repository is dedicated to GitDatNote integration tests and contains no production data.`
        );
      }
    }
  }

  const tokenRaw = env[TOKEN_VAR];
  if (typeof tokenRaw !== 'string' || tokenRaw === '') {
    errors.push(
      `${TOKEN_VAR} is missing. Set a dedicated integration credential in your environment (never in a committed file). It needs Contents read/write on the test repository ONLY — minimum scope, no access to all repositories.`
    );
  } else if (/\s/.test(tokenRaw)) {
    errors.push(
      `${TOKEN_VAR} appears malformed (GitHub tokens contain no whitespace — no leading or trailing spaces, tabs, newlines, or carriage returns; the value is never trimmed).`
    );
  } else if (
    PLACEHOLDER_TOKEN_VALUES.includes(tokenRaw.toLowerCase()) ||
    /^<.*>$/.test(tokenRaw)
  ) {
    errors.push(
      `${TOKEN_VAR} appears to be a placeholder value. Set the real integration token in your environment (the value is never echoed back by this tooling).`
    );
  }

  return { ok: errors.length === 0, errors };
}

#!/usr/bin/env node
/**
 * GitDatNote integration-test setup helper (OpenSpec task 5.1).
 *
 * Guides and validates the opt-in integration-test configuration. It is
 * NON-MUTATING: it never creates, modifies, or deletes anything on GitHub.
 *
 * Usage:
 *   node integration/setup.mjs --help          show this guide
 *   node integration/setup.mjs --check         local, offline, fail-closed check
 *   node integration/setup.mjs --check-access  --check PLUS one read-only
 *                                             authenticated repo lookup
 *
 * The basic check (--check) never touches the network. A passing --check
 * is NOT proof that the repository exists or that the token has the right
 * permissions; only --check-access (opt-in, online) can confirm the repo is
 * reachable, and even that does not prove write permissions without a
 * write attempt (deferred to task 5.3).
 */

import { pathToFileURL } from 'node:url';

import {
  isIntegrationEnabled,
  OPT_IN_VAR,
  REPO_VAR,
  TOKEN_VAR,
  validateIntegrationConfig,
} from './config.js';

const HELP = `GitDatNote integration-test setup helper (task 5.1)

Commands:
  --help            Show this guide (default with no arguments).
  --check           Validate the integration configuration locally.
                    Offline, fail-closed, non-mutating. Exit 0 = ready,
                    exit 1 = invalid (errors listed, secrets never printed).
  --check-access    Run --check first; if the configuration is valid, make
                    ONE read-only authenticated request to
                    https://api.github.com/repos/OWNER/REPO. On success the
                    response must identify the configured OWNER/REPO
                    (case-insensitive); only the verified full name, the
                    private boolean, and the default branch (when it is a
                    safe single-line Git reference name) are reported, with
                    fixed (unavailable) fallbacks for anything else.
                    Requires network access; still never writes to GitHub.
                    Failures produce fixed, credential-safe diagnostics:
                    HTTP 401 / 403 / 404, rate limiting, unexpected
                    response formats, and network failures are named by
                    condition; network exception text, remote response
                    bodies, and response fields are never forwarded.

Creating the dedicated test repository (manual, one-time):
  1. Sign in to GitHub. The test repository must be SEPARATE from the
     GitDatNote application source repository — it must contain no
     personal or production content, and it should be disposable.
  2. Create a new repository named "gitdatnote-integration-test"
     (GitHub > "New repository" > your account or a test organization).
     - Private is preferable when your account supports it.
     - Public is acceptable only if you intentionally choose it; never
       commit secrets or personal content to it.
     - A single initial commit (e.g. a README stating "disposable
       integration-test target for GitDatNote") is recommended so the
       repository is never empty.
  3. Confirm the repository is dedicated to GitDatNote integration
     testing. The naming convention alone does not prove safety — this
     confirmation is your responsibility.
  4. Do NOT create the repository through automated API calls: repository
     creation is an explicit user action (task 5.1 requirement).

Required environment variables (never in a committed file). The values
below are ILLUSTRATIVE PLACEHOLDERS, not real credentials:

  export GITHUB_INTEGRATION=true
  export GITHUB_INTEGRATION_REPO=OWNER/gitdatnote-integration-test
  export GITHUB_INTEGRATION_TOKEN="<dedicated-test-token>"

If you keep them in a gitignored .env, sourcing a file of ordinary
assignments does NOT export them automatically. Bash-compatible:

  set -a
  source .env
  set +a

Sourcing executes shell contents — .env must be a trusted local file you
created. Never paste real token values into chat, logs, or tickets.

Token scope (minimum necessary):
  - Preferred: a FINE-GRAINED personal access token with access limited to
    the test repository ONLY, and Contents: Read and Write permission
    (the eventual task 5.3 suite creates/updates/deletes test content).
  - A suitably scoped GitHub App installation token is also acceptable.
  - Never use the GitDatNote production GitHub App credentials, and never
    request access to all repositories when repository-specific access is
    available. The integration credential is deliberately separate from
    the production deployment credential.

Keeping credentials out of Git:
  - .env is already in .gitignore; never commit it.
  - Never print, log, or embed the token in source files, test snapshots,
    URLs, command arguments, or CI artifacts.
  - This tooling never echoes token values; errors name variables only.

Running the opt-in integration suite:
  npm run test:integration
  - Without GITHUB_INTEGRATION=true: the runner exits successfully with an
    explicit "integration tests disabled" notice. No GitHub contact, no
    credentials loaded, no tests executed. This is NOT a pass for real
    GitHub integration coverage.
  - With GITHUB_INTEGRATION=true: the runner validates the configuration
    first and fails closed (exit 1) before any test runs if anything is
    missing, malformed, placeholder, or a reserved/production repository.

How future tests will isolate their content (task 5.3):
  - All test writes go to a unique timestamped directory
        __gitdatnote-integration-<UTC-ISO>/
    within the test repository's configured content root.
  - Task 5.3 cleanup will delete ONLY that directory, directly through the
    GitHub Contents API using GITHUB_INTEGRATION_TOKEN — not through the
    production GitDatNote API and never against production repositories.

Why production repositories must never be used:
  - Integration tests create, update, and delete content. Running them
    against the application source repository or any production vault
    (e.g. SecondBrain) would destroy real data. The fail-closed
    validation above rejects the application source repository, reserved
    names, placeholders, and anything not following the dedicated
    test-repository naming convention.
`;

function printCheckResult() {
  const { ok, errors } = validateIntegrationConfig(process.env);
  if (ok) {
    console.log('Integration configuration check: OK (local validation only).');
    console.log(`  ${OPT_IN_VAR} = true`);
    console.log(`  ${REPO_VAR} = ${process.env[REPO_VAR].trim()}`);
    console.log(`  ${TOKEN_VAR} = <set>`);
    console.log('No network requests were made.');
    console.log(
      'NOTE: a passing local check does NOT prove the repository exists or ' +
        'that the token has the required permissions. Use --check-access for ' +
        'a one-time read-only lookup (still not proof of write access).'
    );
    return 0;
  }
  console.error('Integration configuration check: FAILED (fail-closed).');
  for (const error of errors) console.error(`  - ${error}`);
  console.error('No network requests were made and nothing was written.');
  return 1;
}

/**
 * Perform the ONE read-only authenticated repository lookup.
 *
 * Credential-safe by construction:
 * - the token goes ONLY into the Authorization header; it is never printed;
 * - network exceptions are replaced by a fixed diagnostic (exception text is
 *   never forwarded);
 * - remote response bodies are NEVER forwarded; failure diagnostics are fixed
 *   text keyed on the HTTP status (401, 403, 404, rate limiting, generic);
 * - exactly ONE request is made — no retries, no writes, no extra requests.
 *
 * @param {object} options
 * @param {Record<string, string|undefined>} options.env environment to read
 * @param {Function} [options.fetchImpl] fetch implementation (injectable for tests)
 * @param {{write(chunk: string): boolean}} [options.out] stdout sink
 * @param {{write(chunk: string): boolean}} [options.err] stderr sink
 * @returns {Promise<number>} exit code
 */
export async function performAccessCheck({
  env,
  fetchImpl = fetch,
  out = process.stdout,
  err = process.stderr,
} = {}) {
  const { ok, errors } = validateIntegrationConfig(env);
  if (!ok) {
    err.write('Integration configuration check: FAILED (fail-closed).\n');
    for (const error of errors) err.write(`  - ${error}\n`);
    return 1;
  }

  const repoId = env[REPO_VAR];
  const token = env[TOKEN_VAR];
  out.write(`Configuration OK; performing one read-only lookup of ${repoId} ...\n`);

  let response;
  try {
    response = await fetchImpl(
      `https://api.github.com/repos/${repoId}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'gitdatnote-integration-setup',
        },
      }
    );
  } catch {
    err.write(
      'Network request failed (generic network/server failure — the exception details are deliberately not forwarded). ' +
        'No GitHub state was changed and no credentials were printed.\n'
    );
    return 1;
  }

  if (!response.ok) {
    const rateLimited =
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers?.get?.('x-ratelimit-remaining') ?? null) === '0');
    let diagnosis;
    if (rateLimited) {
      diagnosis =
        'Rate limit exceeded (HTTP 429, or HTTP 403 with zero remaining rate-limit quota). Wait and try again later.';
    } else if (response.status === 401) {
      diagnosis =
        'Authentication failed (HTTP 401): the credential was rejected. Check the integration token.';
    } else if (response.status === 403) {
      diagnosis =
        'Access denied (HTTP 403): the credential was authenticated but does not cover this repository (e.g. Contents read permission is missing).';
    } else if (response.status === 404) {
      diagnosis =
        'Repository not found (HTTP 404): it was not created yet, or the credential does not cover it (GitHub answers 404 for repositories the credential cannot see).';
    } else {
      diagnosis = `Request failed with HTTP ${response.status}.`;
    }
    err.write(`Repository lookup failed: ${diagnosis}\n`);
    err.write(
      'Remote response bodies are never forwarded in this output. ' +
        'This check is read-only; nothing was written.\n'
    );
    return 1;
  }

  let repo;
  try {
    repo = await response.json();
  } catch {
    repo = null;
  }
  if (!repo || typeof repo !== 'object' || Array.isArray(repo)) {
    err.write(
      'Repository lookup failed: the GitHub API returned an unexpected response format (HTTP 200, but the body could not be used as a repository object). ' +
        'Parsing errors and response bodies are never forwarded in this output. ' +
        'This check is read-only; nothing was written.\n'
    );
    return 1;
  }

  // The response must identify exactly the configured repository
  // (case-insensitive — GitHub may normalize casing). Anything else
  // fails closed: we never report that the intended repository was
  // verified based on a different identity.
  const fullName = repo.full_name;
  if (
    typeof fullName !== 'string' ||
    fullName.toLowerCase() !== repoId.toLowerCase()
  ) {
    err.write(
      'Repository lookup failed: the response does not identify the configured repository (the request succeeded, but the intended repository could not be confirmed). ' +
        'Response fields are never forwarded in this output. ' +
        'This check is read-only; nothing was written.\n'
    );
    return 1;
  }

  // fullName matched the configured (strictly validated) repository
  // identifier, so printing it is safe — no arbitrary response string is
  // ever forwarded.
  const bool = (value) =>
    typeof value === 'boolean' ? String(value) : '(unavailable)';
  // Conservative allowlist for diagnostic display: only a single-line
  // safe Git reference name is ever printed.
  const SAFE_REF_NAME = /^[A-Za-z0-9._-]{1,100}$/;
  const defaultBranch =
    typeof repo.default_branch === 'string' &&
    SAFE_REF_NAME.test(repo.default_branch)
      ? repo.default_branch
      : '(unavailable)';
  out.write('Read-only lookup succeeded:\n');
  out.write(`  full_name       = ${fullName}\n`);
  out.write(`  private         = ${bool(repo.private)}\n`);
  out.write(`  default_branch  = ${defaultBranch}\n`);
  out.write(
    'NOTE: reachability does NOT prove Contents write permission. The task 5.3 ' +
      'suite will exercise create/update/delete against the isolated ' +
      'timestamped directory once it is implemented.\n'
  );
  return 0;
}

async function printCheckAccessResult() {
  return performAccessCheck({ env: process.env });
}

async function main(argv) {
  const arg = argv[2];
  if (arg === undefined || arg === '--help' || arg === '-h') {
    process.stdout.write(HELP);
    return 0;
  }
  if (arg === '--check') return printCheckResult();
  if (arg === '--check-access') return await printCheckAccessResult();
  process.stderr.write(`Unknown option: ${arg}\n\n${HELP}`);
  return 2;
}

// Run the CLI only when this file is the executable entry point; importing
// this module (e.g. from tests) must not start the CLI.
if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main(process.argv).then((code) => process.exit(code));
}

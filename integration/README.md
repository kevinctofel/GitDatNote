# GitDatNote integration tests (tasks 5.1 and 5.3)

Opt-in harness for **real-GitHub integration tests**. Everything in this
directory runs only when you explicitly opt in. The normal development and
CI flows never read these variables, never contact GitHub for integration
purposes, and never require real GitHub credentials.

**What is here:**

- `config.js` / `config.d.ts` — the fail-closed configuration contract.
- `setup.mjs` — offline check (`--check`) and one read-only access check
  (`--check-access`).
- `run.mjs` — the opt-in runner behind `npm run test:integration`.
- `vitest.config.ts` — the only Vitest configuration that discovers
  integration tests.
- `harness.test.ts` — the offline task 5.1 harness/configuration safety
  suite.
- `safety.ts` — pure path/identity/cleanup safety helpers (no I/O).
- `cleanup.ts` — the guaranteed, Contents-API-only cleanup module.
- `github-content.test.ts` — the **task 5.3 real-GitHub content
  lifecycle**: create → read back → update with correct SHA → stale-SHA
  conflict (409) → directory listing, with guaranteed cleanup.
- `safety.test.ts` — deterministic offline unit tests for the safety and
  cleanup helpers (no credentials, no network).

**Milestone status:** the real-GitHub lifecycle and cleanup described
below **exist** in `github-content.test.ts` and run only against the
operator-configured dedicated test repository. A green
`npm run test:integration` in the default (disabled) environment proves
nothing about live GitHub behavior — it is an intentionally disabled run.

## Why the test repository must be isolated

Integration tests create, update, and delete repository content. They must
run against a repository that exists solely for testing:

- **Separate from the GitDatNote application source repository** — running
  live tests against `kevinctofel/GitDatNote` would corrupt the app's own
  source.
- **No personal or production content** — the live SecondBrain vault and
  any other real repository are off-limits. The validator rejects
  `SecondBrain` case-insensitively, rejects the application source
  repository, and rejects anything not following the dedicated naming
  convention.
- **Disposable** — if a run ever leaves unexpected files, the whole
  repository can be deleted without losing anything real.

## How to create the dedicated test repository (manual, one-time)

Repository creation is an explicit user action — this tooling does **not**
create repositories via API calls.

1. Sign in to GitHub (your account or a dedicated test organization).
2. **New repository** → name it `gitdatnote-integration-test`.
   - **Private is preferable** when your account supports it.
   - Public is acceptable only if intentionally chosen; never commit
     secrets or personal content to it.
3. Add a single initial commit (e.g. a README saying "disposable
   integration-test target for GitDatNote") so the repository is never
   empty.
4. Confirm the repository is dedicated to GitDatNote integration testing
   and contains nothing else. The naming convention alone does not prove
   safety — this confirmation is yours.

## Required environment variables

Provide them as exported environment variables — this tooling reads
`process.env` directly, exactly like the server. The values below are
**illustrative placeholders, not real credentials**:

```bash
export GITHUB_INTEGRATION=true
export GITHUB_INTEGRATION_REPO=OWNER/gitdatnote-integration-test
export GITHUB_INTEGRATION_TOKEN="<dedicated-test-token>"
```

If you keep the values in a gitignored `.env` instead:

- Sourcing a file of ordinary assignments does **not** export them
  automatically — a line like `FOO=bar` only sets a shell variable.
  A Bash-compatible pattern:

  ```bash
  set -a
  source .env
  set +a
  ```

- Sourcing executes shell contents, so `.env` must be a **trusted local
  configuration file you created** — never a downloaded or untrusted file.
- Do not paste real token values into chat, logs, tickets, or source
  files; the tooling never echoes them either.

- `GITHUB_INTEGRATION` — opt-in switch. Only the literal string `true`
  enables the suite; anything else (unset, `TRUE`, `1`, empty) is
  disabled.
- `GITHUB_INTEGRATION_REPO` — `OWNER/REPO` of the dedicated test
  repository. No default is ever inferred from git remotes, your GitHub
  profile, environment defaults, your GitHub identity, the production
  GitHub App configuration, or any previously used repository.
- `GITHUB_INTEGRATION_TOKEN` — the dedicated integration credential
  (see below). Provided via the environment only; never hardcoded.

## Token scope and security decisions

- **Preferred:** a **fine-grained personal access token** restricted to
  the test repository only, with **Contents: Read and Write** — the live
  suite creates, updates, and deletes test content.
- A suitably scoped GitHub App installation token is also acceptable.
- **Minimum scope:** never request access to all repositories when
  repository-specific access is available.
- **Never** use the GitDatNote production GitHub App credentials or
  ordinary GitDatNote user sessions for integration testing. The
  integration credential is deliberately separate from the production
  deployment credential.
- Never: print the token, log authorization headers, store tokens in
  source files, include tokens in test snapshots, put secrets in URLs or
  command arguments, commit `.env` files, include secrets in CI
  artifacts, or fall back to production credentials.

`.env` is already listed in `.gitignore`; `.env.example` contains only a
commented, placeholder-only integration section.

## Running the integration suite

```bash
npm run test:integration
```

- **Disabled** (`GITHUB_INTEGRATION` not exactly `true`): prints
  "Integration tests are DISABLED.", confirms no GitHub contact / no
  credentials loaded / no tests executed, and **exits 0**. This is an
  intentionally disabled run — it is recognized by that exact notice, and
  it never claims that real-GitHub tests passed.
- **Enabled but invalid configuration**: fails **closed** — exit 1,
  secret-free error list, and **no test runs and no GitHub contact**
  before validation completes.
- **Enabled and valid**: runs only the dedicated integration suite via
  `integration/vitest.config.ts`. The normal unit/web suites are never
  executed as a side effect, and `npm run test` / `npm run test:e2e` remain
  fully offline.

## Operator checklist before any live run

The environment validator can check names and token format, but it cannot
prove a repository is disposable. **Before the first live mutation,
confirm all of the following** — the suite does not run live writes on a
guessed repository or a placeholder token:

- [ ] The target repository was **manually created** by you (not by API).
- [ ] Its name matches the dedicated-test convention
      (`gitdatnote-integration-test`, optionally with a `-` suffix).
- [ ] It contains **no production or personal content** — nothing you care
      about.
- [ ] The token is **restricted to that repository** only.
- [ ] The token has **Contents read and write** permission.
- [ ] The integration variables are set securely in your local environment
      (never pasted into chat, logs, or tickets).
- [ ] `node integration/setup.mjs --check` passes (offline).
- [ ] `node integration/setup.mjs --check-access` passes (one read-only
      lookup; confirms reachability and repository identity, not write
      permission).

Only after all of the above is confirmed should you run
`npm run test:integration`. If the dedicated repository or token has not
been configured, **stop before live execution** — do not invent
credentials and do not substitute a production token.

## Preflight validation (live suite)

Before the first mutation, `github-content.test.ts` performs a narrow,
read-only preflight with the dedicated token and fails closed if any check
fails:

1. The repository exists and is accessible (one `GET /repos/OWNER/REPO`).
2. The response identity matches the configured `OWNER/REPO`
   case-insensitively.
3. The returned repository name follows the dedicated integration-test
   convention.
4. The client targets GitHub's authenticated API endpoint
   (`https://api.github.com`) — no custom base URLs.
5. The repository is not the GitDatNote source repository, SecondBrain, or
   another reserved target.

Preflight failures produce fixed, credential-safe descriptions. Raw API
response bodies, network exception text, tokens, and Authorization headers
are never printed. GitHub reachability does not itself prove Contents
write permission — permission failures during the lifecycle are reported
accurately as they occur.

## Unique run directory and created files

Each live run generates a unique, filename-safe UTC timestamped directory
inside the content root:

```
__gitdatnote-integration-<UTC-ISO with - for : and T, . for ms>-<random6>/
```

Example (illustrative only):

```
src/posts/__gitdatnote-integration-2026-11-19T15-30-00-000Z-a1b2c3/
```

- The timestamp is the current run time in UTC; a short random suffix
  prevents collisions for runs that begin at the same instant.
- The directory is created uniquely for that run, inside the configured
  test repository's content root (`src/posts` — the adapter contract's
  default, `DEFAULT_CONTENT_ROOT`), never outside it, never at the content
  root itself, and never with an absolute or traversal path.
- If the path already exists, the run fails rather than overwrites.

The run writes exactly one file inside the directory:

```
integration-article.md
```

Its content is deterministic per run: a Markdown heading, ordinary
paragraphs, a UTF-8 Unicode sample, and a run-specific marker string that
is compared exactly on read-back.

## Live lifecycle (what the real test verifies)

All operations go through the **production content adapter**
(`createContentAdapter` from `src/server/content/index.ts`) driven by a
real authenticated Octokit Contents API client built from
`GITHUB_INTEGRATION_TOKEN` — no mocks, no fake responses:

1. **Create** — the file is created inside the isolated directory; the
   result carries the exact relative path, a valid 40-hex blob SHA, and the
   correct UTF-8 byte size.
2. **Read back** — the adapter returns type `file`, the exact relative
   path, content exactly equal to the original UTF-8 string (no
   normalization), the newly created blob SHA, and the correct size.
3. **Update with correct SHA** — the file is updated using the SHA from
   the preceding operation; a new blob SHA is returned and differs from
   the original; a read-back returns exactly the updated content at the
   updated size.
4. **Stale-SHA conflict** — a further update with the original (stale)
   SHA is rejected with the adapter's mapped `SHA_CONFLICT` error contract
   (HTTP-equivalent status 409, and the current blob SHA where the
   contract supplies it). The file is then read again to prove the content
   and SHA are unchanged — the stale update overwrote nothing. The mapped
   adapter error contract is reported, not a claim about a raw GitHub HTTP
   response.
5. **Directory listing** — listing the run directory through the adapter
   shows exactly the one artifact (name, type `file`, current SHA, correct
   size). Listing is scoped to the isolated directory only; the repository
   is never recursively scanned and no production directory is touched.

## Cleanup — critical safety boundary

Cleanup runs in a guaranteed teardown (a `finally` block) so it executes
even when a later assertion fails:

- It uses the **GitHub Contents API directly** with
  `GITHUB_INTEGRATION_TOKEN` — it **never calls the production GitDatNote
  HTTP API**, which intentionally has no delete endpoint.
- It deletes **only** the exact file this run created
  (`integration-article.md` beneath the exact isolated directory). Before
  deleting, it re-validates the full path and fetches the **current blob
  SHA directly from GitHub**; the Contents API delete is issued with that
  SHA and a safe commit message.
- It never implements generic recursive deletion, never deletes based on a
  broad name-prefix search, never deletes the repository, never deletes
  `README.md` at the repository root, never deletes outside the unique
  directory, and never accepts user-supplied absolute cleanup paths.
- Unexpected files discovered in the run directory are **not** deleted —
  they are reported and the run fails safely.
- If creation failed before any file existed, no deletion is attempted.
- Once the file is deleted, the empty directory disappears from the Git
  tree.

**What successful cleanup means:** the file deletion returned success, and a
follow-up listing of the run directory confirms it no longer exists (or
reports it as absent). **A cleanup failure is never a passing test**: the
run exits nonzero with a sanitized failure description, a clear statement
that test content may remain, and the precise validated repository name and
test directory path so it can be inspected manually. Credentials and raw
upstream messages are never printed.

**If cleanup fails:** open the printed repository path on GitHub, verify
the isolated directory is empty of anything you did not create, and remove
the leftover `__gitdatnote-integration-…/` directory manually (e.g. via a
`git rm -r` commit on the disposable repository). Do not attempt automated
re-cleanup against a real repository.

## Verifying the repository after a live run

After `npm run test:integration` completes, confirm the test repository is
back to its pre-run state:

1. List the repository on GitHub: the content root (`src/posts/`) should
   contain **no** `__gitdatnote-integration-*/` directories.
2. Check the commit history: the run adds exactly the create/update
   commits for `integration-article.md` and the cleanup deletion commit —
   nothing else.
3. If anything unexpected remains, treat it as a cleanup failure (see
   above) even if the test run reported success.

## CI behavior

The live suite is **not** part of normal CI. The existing Node 24/26 GitHub
Actions jobs run without integration credentials and without
`GITHUB_INTEGRATION=true`; no integration token is provided to them and no
scheduled live job exists. Ordinary CI must continue to pass without real
GitHub credentials. A separately authorized live-integration workflow, if
ever needed, is a future task — not part of task 5.3.

## Validating your local setup

```bash
node integration/setup.mjs --help          # full guide
node integration/setup.mjs --check         # offline, fail-closed check
node integration/setup.mjs --check-access  # --check + ONE read-only repo lookup
```

`--check` never touches the network and never writes to GitHub. A passing
local check is **not** proof that the repository exists or that the token
has the right permissions — `--check-access` makes one read-only request
and confirms that the repository is reachable **and** that the response
identifies the configured `OWNER/REPO`, but still does not prove Contents
**write** permission; only the task 5.3 live suite exercises that (after
its own read-only preflight). Its output is fixed and credential-safe: on
success it prints only the verified `full_name`, the `private` boolean, and
`default_branch` when it is a safe single-line Git reference name (anything
else prints a fixed `(unavailable)`); every failure is named by condition
(401 / 403 / 404, rate limiting, unexpected response format, network
failure), and raw network exception text, response bodies, and response
fields are never forwarded.

## Security warnings

- Integration tests **write and delete** content when enabled. Never point
  `GITHUB_INTEGRATION_REPO` at anything you care about.
- The fail-closed validator rejects the application source repository,
  `SecondBrain` (case-insensitive), placeholder values, malformed
  `OWNER/REPO` strings, and any repository not following the
  `gitdatnote-integration-test[-suffix]` naming convention.
- The live suite runs once per invocation against a fresh isolation
  namespace; do not run concurrent live invocations against the same
  repository at the same instant (the random suffix prevents directory
  collisions, but concurrent writes to one disposable repository are
  still not supported).
- CI intentionally runs **without** integration credentials; real
  integration testing is never enabled automatically on pushes.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `GITHUB_INTEGRATION must be set to exactly "true"` | Enable the suite: `export GITHUB_INTEGRATION=true`. Only the literal `true` counts. |
| `GITHUB_INTEGRATION_REPO is missing` / malformed | Set `OWNER/gitdatnote-integration-test` — one slash, no spaces, no URL. |
| Placeholder / reserved / source-repo error | Create the dedicated test repository first; the validator lists exactly what was rejected. |
| `GITHUB_INTEGRATION_TOKEN is missing` / placeholder | Export a dedicated fine-grained token (Contents read/write on the test repo only). The value is never echoed. |
| `--check-access` fails with 404 | The repository was not created yet, or the token does not cover it. |
| `--check-access` fails with 403 | The token lacks Contents read permission for that repository. |
| `--check-access` fails: "does not identify the configured repository" | The HTTP 200 response did not identify your `GITHUB_INTEGRATION_REPO` (a different repository, or an unexpected body). Re-check the repository value — no response fields are printed. |
| `--check-access` fails: "unexpected response format" | GitHub answered HTTP 200 with a body that is not a repository object. Fixed diagnostic only — the parsing error and body are never printed; retry or check the token scope. |
| Live run fails at preflight | The repository is missing, the identity does not match, or the client is not pointed at GitHub's API. Re-run the operator checklist; the fixed diagnostic names the failing condition. |
| Live run reports `Cleanup failed: test content may remain in …` | The run is a **failure**. Inspect the printed repository + directory path on GitHub and remove the leftover directory manually (see "If cleanup fails"). |
| Vitest "no tests found" under the integration config | Should not happen — `integration/harness.test.ts` always exists. If you see it, check you are running `npm run test:integration` (not plain `npm run test`, which is deliberately isolated from `integration/`). |

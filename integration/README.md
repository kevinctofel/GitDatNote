# GitDatNote integration tests (task 5.1)

Opt-in harness for **real-GitHub integration tests**. Everything in this
directory runs only when you explicitly opt in. The normal development and
CI flows never read these variables, never contact GitHub for integration
purposes, and never require real GitHub credentials.

**Milestone status (task 5.1):** this directory contains the configuration
contract, a setup/validation helper, the opt-in runner, and an offline
harness suite. It performs **no live GitHub operations**. Real-GitHub
create/read/update/conflict/list coverage and cleanup are **task 5.3** and
do not exist yet. A green `npm run test:integration` at this milestone
proves only that the harness is configured correctly — it is **not**
evidence of real-GitHub content integration coverage.

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
  profile, or production configuration.
- `GITHUB_INTEGRATION_TOKEN` — the dedicated integration credential
  (see below). Provided via the environment only; never hardcoded.

## Token scope and security decisions

- **Preferred:** a **fine-grained personal access token** restricted to
  the test repository only, with **Contents: Read and Write** (the task
  5.3 suite will create/update/delete test content).
- A suitably scoped GitHub App installation token is also acceptable.
- **Minimum scope:** never request access to all repositories when
  repository-specific access is available.
- **Never** use the GitDatNote production GitHub App credentials for
  integration testing. The integration credential is deliberately
  separate from the production deployment credential.
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
  credentials loaded / no tests executed, and **exits 0**. It never
  claims that real-GitHub tests passed.
- **Enabled but invalid configuration**: fails **closed** — exit 1,
  secret-free error list, and **no test runs and no GitHub contact**
  before validation completes.
- **Enabled and valid**: runs only the dedicated integration suite via
  `integration/vitest.config.ts`. The normal unit/web suites are never
  executed as a side effect.

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
**write** permission; only the task 5.3 live suite exercises that. Its
output is fixed and credential-safe: on success it prints only the
verified `full_name`, the `private` boolean, and `default_branch` when it
is a safe single-line Git reference name (anything else prints a fixed
`(unavailable)`); every failure is named by condition (401 / 403 / 404,
rate limiting, unexpected response format, network failure), and raw
network exception text, response bodies, and response fields are never
forwarded.

## Isolation and cleanup (task 5.3 design)

- All test writes will go to a unique timestamped directory of the form
  `__gitdatnote-integration-<UTC-ISO>/` inside the test repository's
  configured content root.
- Task 5.3 cleanup will delete **only** that directory, directly through
  the GitHub Contents API using `GITHUB_INTEGRATION_TOKEN` — not through
  the production GitDatNote API, and never against production
  repositories.
- Task 5.1 does not implement any writes or cleanup; the configuration
  above is designed so that restriction can be enforced later.

## Security warnings

- Integration tests **write and delete** content once task 5.3 lands.
  Never point `GITHUB_INTEGRATION_REPO` at anything you care about.
- The fail-closed validator rejects the application source repository,
  `SecondBrain` (case-insensitive), placeholder values, malformed
  `OWNER/REPO` strings, and any repository not following the
  `gitdatnote-integration-test[-suffix]` naming convention.
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
| Vitest "no tests found" under the integration config | Should not happen — `integration/harness.test.ts` always exists. If you see it, check you are running `npm run test:integration` (not plain `npm run test`, which is deliberately isolated from `integration/`). |

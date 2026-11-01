# Session Handoff — `modernize-gitdatnote-foundation`

**Date:** 2026-11-01 · **Branch:** `feat/gitdatnote-2` (starting commit `2f3bbef`)
**Status:** All OpenSpec artifacts revised to reflect the 9-point technical correction pass. **No application code was written or modified.** The change is **not archived.**
**Validation:** `openspec validate modernize-gitdatnote-foundation` → **exit 0, "Change ... is valid"** (2 non-blocking length warnings, see below).

## Completed changes (this pass)

All 9 corrections from the final correction pass are encoded in `design.md` and propagated to the specs, tasks, proposal, and decisions. No behavior/decision is marked complete — these are *documented intent*, pending implementation approval.

1. **Token lifecycle (GitHub App user tokens):** No longer "never expire." `ghu_` access token ~8h; `ghr_` refresh token ~6mo, rotates on use. Server persists access token + refresh token + both expiry timestamps. Refresh flow on expiry; expired/invalid refresh → invalidate session, re-auth. (`offline_access` scope added to the web flow.)
2. **Credential distinction:** Four identifiers mapped by use — `GITHUB_APP_ID` (JWT `iss` only), `GITHUB_APP_CLIENT_ID` (web flow), `GITHUB_APP_CLIENT_SECRET` (web-flow token exchange), `GITHUB_APP_PRIVATE_KEY` (RS256 JWT → installation token). Web flow = client ID + client secret; JWT/installation = private key + App ID.
3. **Node.js:** Target **Node.js 24 LTS**; `engines: {"node": ">=24"}`; no end-of-life releases. Propagated to proposal, specs, tasks (2.1, 2.8, 6.2), DECISIONS (D-04).
4. **Repository authorization:** Dual condition — user permission **AND** App installation access (scoped read/write). Visible-but-not-writable repos are read-only (read OK, write → `403 REPO_NOT_ALLOWED`). `GET /api/repositories` returns per-repo `canRead`/`canWrite`.
5. **Markdown security:** `setHTML()` must NOT be "fixed" with unsanitized `innerHTML`. Render via Markdown parser + sanitizer (DOMPurify) with a conservative allowlist (strip scripts, `on*` handlers, `javascript:`/`data:` URIs, iframe/script/object). **XSS regression tests required.**
6. **CSRF:** Single mechanism — `X-CSRF-Token` header only (never body/cookie/query) on **all** state-changing verbs (POST/PUT/DELETE) **including `POST /api/auth/logout`**. All contradictory `csrfToken` body fields removed from request examples.
7. **Commit identity:** Never invent/hardcode/guess a name or email. Omit committer field by default (GitHub attributes to token owner); author name MAY be public login; email only if publicly visible.
8. **Integration-test cleanup:** Isolated, test-only. Unique timestamped subdirectory `__gitdatnote-integration-<UTC-ISO>/`; cleanup via GitHub Contents API directly with `GITHUB_INTEGRATION_TOKEN` — **not** through the production API (no delete added). Failed cleanup = logged failure, never a pass. Never against SecondBrain/production.
9. **Task-state evidence:** Completed checkboxes now carry explicit **Evidence** notes. Only 1.1 and 1.2 remain checked (both evidence-backed); all implementation/verification tasks are unchecked. New task 1.3 added for recording initial build behavior (no build has been run yet).

## Files modified (all on disk)

| File | Change |
|---|---|
| `openspec/changes/modernize-gitdatnote-foundation/design.md` | 14 patches covering all 9 corrections (token lifecycle, 4-credential table, dual repo auth, CSRF header-only + logout, commit identity, Node 24, integration cleanup, Markdown sanitization) |
| `.../tasks.md` | Node 24, DOMPurify preview, XSS tests, credential split, token-refresh task, CSRF-includes-logout, dual auth + `canRead`/`canWrite`, commit identity, integration cleanup, Node 24 in 6.2, task-evidence renumbering (1.1–1.5) |
| `.../specs/github-connection/spec.md` | Token expiry/refresh scenarios, 4-credential distinction, dual authorization + visible-but-not-writable, CSRF-includes-logout (header-only) |
| `.../specs/repository-content/spec.md` | Commit-identity requirement (no fabricated email), explicit "file deletion is not part of this API" |
| `.../specs/application-foundation/spec.md` | Node 24 LTS, Safe Markdown rendering + XSS regression tests requirement |
| `.../proposal.md` | Node 24 LTS in changes + impact |
| `docs/DECISIONS.md` | D-04 (Node 24), D-11 (commit identity) reworded; new D-12…D-17; deferred table renumbered D-18…D-22; security baseline expanded |
| `docs/SESSION-HANDOFF.md` | This file (new) |

## Remaining tasks (NOT complete — do not start without explicit approval)

- **1.3** Record initial build behavior (`npm install` + `npm run build` on starting commit) — no build run yet.
- **1.4** Characterization tests (Vitest) for existing behavior.
- **1.5** Delete obsolete code (`updatePost.js`, `addImage.js`).
- **2.x** App foundation (package.json/tsconfig/vite/vitest, shared/server/web, DOMPurify preview, XSS tests, CI, ESLint).
- **3.x** Secure GitHub connection (sessions, auth flow with token refresh/rotation, CSRF, dual repo auth, UI, credential-leak checks).
- **4.x** Repository content service (Octokit adapter, endpoints, error mapping, UTF-8, commit identity, tests, retry UI).
- **5.x** Integration + E2E tests (dedicated test repo, Playwright, real integration run + isolated cleanup).
- **6.x** Verify & document (run all checks, update README/security docs, review scenarios, record follow-ups).

## Unresolved / non-blocking issues

- **2 OpenSpec length warnings** (non-blocking; change still valid): `github-connection/spec.md` requirements "Secure GitHub authorization" and "Repository-scoped authorization" exceed 500 chars. Optional cleanup: split each into smaller requirements or move detail into scenarios. Not required for validity.
- **No build/tests have been executed** (no app code). Task 1.3 and all of sections 2–6 remain open.
- **No secrets stored** — env var names are documented; all values redacted/absent from these artifacts.

## Commands to resume

```bash
cd /home/kct/Projects/GitDatNote
git switch feat/gitdatnote-2            # branch for this change
# Re-validate the change (should still pass):
/home/kct/.local/bin/openspec validate modernize-gitdatnote-foundation
# Confirm what is checked off vs. pending:
grep -nE '^\s*- \[(x| )\]' openspec/changes/modernize-gitdatnote-foundation/tasks.md
```

**Next, only after explicit user approval to begin implementation:** start at task **1.3** (record initial build behavior), then proceed through sections 2–6 in order. Do **not** archive this change until implementation and verification are complete.

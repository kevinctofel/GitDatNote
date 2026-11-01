# Design: Modernize GitDatNote foundation

## Context
Public GitDatNote repository is a small React/Vite app originally targeting SecondBrain. This is an architectural plan; the implementing agent MUST inspect live source files, dependency versions, app behavior, and Git history before modifying them. Do not pretend the full current code was exhaustively audited in this document.

## Goals / Non-Goals
**Goals:** clean frontend/backend boundary, secure authorization, repository-independent content access, predictable errors, automated tests, and a usable connected-state shell.
**Non-goals:** create new user blog repositories, production hosted multi-tenancy, Eleventy publishing, DNS configuration, complete post editor.

## Proposed architecture
```
React/Vite UI (no secrets)
    -> same-origin backend APIs (session + CSRF)
        -> GitHub authorization/session service
        -> repository content service (Octokit adapter)
            -> GitHub REST API
```

Module boundaries:
- `web`: account connection state, repo selector and diagnostics UI; no direct privileged GitHub API calls.
- `server`: authentication endpoints, session cookie handling, GitHub adapter endpoints and validation.
- `core`: typed repository, path, SHA and error-domain interfaces shared where appropriate.
- tests: unit tests for validation/error mapping, service tests with fake GitHub client, browser smoke tests.

## Decisions and alternatives
1. **GitHub App / secure backend:** default choice to avoid client-side long-lived PATs. Before coding, validate GitHub App permission and installation flows. Alternative OAuth app only if permissions and security review justify it. Never treat installation permission as blanket permission to create user repositories.
2. **Backend state:** server-managed session (encrypted/signed cookie reference with server-side credential storage where necessary). For locally run use, document safe environment variables and session rotation. Avoid assuming a multi-tenant database in MVP.
3. **Repository file adapter:** API `listContent`, `getContent`, `createContent`, `updateContent` with explicit owner/repo/path and version SHA. Update operations MUST supply expected SHA, rejecting conflicts rather than overwriting.
4. **Paths:** approved content-root allowlist, canonical forward-slash paths, reject traversal and absolute paths; verify installations/permissions on each operation.
5. **Frontend:** React + TypeScript/Vite migration in place when feasible. Preserve behavior through tests; do not blindly replace application files.
6. **Error handling:** map GitHub 401/403/404/409/422/429/network into understandable UI states with safe retry guidance.

## API sketch (subject to source audit)
- `GET /api/session`: connected user and active repository summary.
- `GET /api/auth/github/start` and `GET /api/auth/github/callback`: server-controlled auth flow.
- `POST /api/auth/logout`: invalidate session.
- `GET /api/repositories`: allowed repositories.
- `GET /api/content?repo=...&path=...`: list or read depending on operation contract chosen in implementation.
- `POST /api/content`: create file with path/content.
- `PUT /api/content`: update file with path/content/expected SHA.

The implementing agent must finalize route shapes, HTTP status codes, CSRF controls, and authorization checks in an ADR or API contract before implementation. Never pass arbitrary GitHub owner/repo from frontend to backend without verifying authorization.

## Risks / Trade-offs
- GitHub App permission and installation UX may limit onboarding; validate early.
- Backend adds deployment complexity to self-hosting but is necessary for safer credential handling.
- Concurrent edits can produce conflicts; preserve both versions and ask users to resolve.
- API rate limits and remote outages: give recoverable UI states, never imply saves succeeded.
- Migration can regress original behavior; establish baseline test or characterization checks first.

## Open questions
- Which supported hosting/runtime environment should local and self-hosted backend use?
- How will GitHub App be registered/distributed for self-hosters?
- Which repositories and content-root selections are allowed in the foundation UI?
- Does legacy app have tests worth porting? Confirm in source audit.

## Verification strategy
Mocked GitHub unit tests plus opt-in integration tests against an isolated **test repository only**; failure-case tests for authorization, token expiry, invalid paths, SHA mismatches, duplicate create, and rate limits; CI runs lint/typecheck/tests. No automated commits to SecondBrain.

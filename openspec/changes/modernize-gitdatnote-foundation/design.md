# Design: Modernize GitDatNote foundation

## Context
GitDatNote is a small React/Vite app originally targeting a hardcoded SecondBrain GitHub path. This design document resolves the architectural decisions for the foundation change. The source audit (`audit.md`) records the existing code's state; all decisions below are informed by that audit.

## Goals
- Clean frontend/backend boundary: no privileged credentials in browser bundles.
- Secure, repository-agnostic GitHub integration via a GitHub App.
- Server-managed sessions with persistent storage.
- Typed, testable repository content service with SHA-based conflict detection.
- Predictable error mapping from GitHub API failures to user-safe UI states.
- Repeatable local development: install, run, lint, typecheck, test, CI.

## Non-Goals
- Article editor, Eleventy template generation, blog provisioning.
- GitHub Pages deployment, domain configuration, hosted SaaS, billing.
- AI writing, team collaboration, file deletion (deferred to editor change).
- Multi-tenant database or production hosting infrastructure.

---

## Resolved Architectural Decisions

### A-01: Authentication — GitHub App

**Mechanism:** GitHub App with fine-grained repository permissions and a server-side web authorization (OAuth) flow.

GitHub Apps can be owned by personal accounts, which suits the self-hosted single-user model. Device Flow is not selected for the MVP (it still requires a registered application and adds a code-entry step).

**Permissions:** `Contents: read/write`, `Metadata: read`. The App MUST NOT have repository-creation permission. Permission to edit existing repositories does not imply permission to create new ones.

**Authorization flow:**
1. User clicks "Connect GitHub" in the UI.
2. Backend generates a cryptographically random `state` token and stores it server-side (SQLite, tied to a pending session record).
3. Backend redirects the browser to the GitHub OAuth authorization URL for the App.
4. User reviews permissions and clicks "Authorize" on GitHub.
5. GitHub redirects back to the backend callback URL with `code` and `state`.
6. Backend validates `state` against the pending session, then exchanges `code` for a user access token at `POST https://github.com/login/oauth/access_token` using the App's `client_id` and `client_secret`. The authorization request MUST include the `offline_access` scope so GitHub returns an expiring user access token plus a refresh token.
7. Backend stores the credentials (encrypted, see A-04) in SQLite: the user access token, the refresh token, the access-token expiration timestamp, and the refresh-token expiration timestamp. It creates the user session and sets the session cookie.
8. Backend redirects the browser to the app.

**Token lifecycle:** GitHub App user access tokens (`ghu_`) are short-lived. With the App configured for expiring tokens (the recommended, default configuration) and the `offline_access` scope requested, the token exchange returns a user access token that **expires after 8 hours** and a **refresh token** (`ghr_`) that **expires after 6 months**. The server SHALL persist the access token, refresh token, and both expiration timestamps (encrypted, see A-04) and SHALL consult them before every privileged operation:
- If the access token is still valid, use it.
- If the access token is expired (or within a safety threshold of expiry) and the refresh token is still valid, refresh it: `POST https://github.com/login/oauth/access_token` with `grant_type=refresh_token`, the `client_id`, and the stored refresh token. GitHub returns a **new** access token and a **new** refresh token; the old access token and the old refresh token are invalidated. Store the new encrypted pair. This is **rotation** — a refresh token that has been used can never be used again.
- If the refresh token is expired or invalid (GitHub returns `bad_refresh_token`), the token pair cannot be recovered. The server SHALL invalidate the session and prompt the user to reconnect; a fresh token pair is obtained only by re-running the web authorization flow.
- If the user revokes the App, or the App installation is removed, an in-flight API call returns `401`; the server SHALL invalidate the session and prompt the user to reconnect.
The server MUST NOT assume that a token "never expires." All expiration decisions use the persisted timestamps. (Authority: GitHub "Generating a user access token for a GitHub App" and "Refreshing user access tokens.")

**Permitted repositories:** A repository is "permitted" only when BOTH conditions hold — the user-to-server token is limited to the permissions that **both** the App and the user have, per GitHub's docs:
1. **User permission:** the connected user has the required permission (read for reads, write for writes) on the repository through their GitHub account.
2. **GitHub App installation access:** the GitHub App is installed on the repository (or its owner/organization) with the required `Contents` permission (`read` for reads, `write` for writes).

A repository may therefore be **visible but not writable** — e.g., the user can read it but the App is installed read-only, the user has no write permission, or the App is not installed on it at all. The backend SHALL verify repository authorization (both conditions, scoped to the operation's required permission) on every content operation. When a write is attempted on a visible-but-not-writable repository, the backend SHALL return `403 REPO_NOT_ALLOWED` with a cause-specific message and MUST NOT leak private content. The `GET /api/repositories` endpoint SHALL return each accessible repository with `canRead` and `canWrite` flags so the UI can disable write actions where `canWrite` is false.

**Local registration and configuration:**
- The operator registers a GitHub App in their own GitHub account (Settings → Developer settings → GitHub Apps).
- Configure the callback URL (e.g., `http://localhost:3000/api/auth/github/callback` for local development).
- Set repository permissions to `Contents: read/write` and `Metadata: read`.
- Enable user-to-server token expiration (the recommended default) so the App issues expiring tokens with refresh tokens.
- Store the App's credentials in environment variables. The App has four distinct identifiers and the application needs two separate credential pairs:

| Credential | Env var | Used for | Never used for |
|---|---|---|---|
| **App ID** | `GITHUB_APP_ID` | JWT `iss` claim | web flow |
| **Client ID** | `GITHUB_APP_CLIENT_ID` | Web authorization flow (`/login/oauth/authorize`, `/login/oauth/access_token`) | JWT signing |
| **Client secret** | `GITHUB_APP_CLIENT_SECRET` | Web flow token exchange (confidential client) | JWT signing |
| **Private key** | `GITHUB_APP_PRIVATE_KEY` | Sign the App JWT (RS256) to request an **installation access token** (`ghs_`) | web flow |

The **user-to-server web flow** uses the **client ID + client secret** only. **App-level JWT / installation-token authentication** uses the **private key + App ID (as `iss`)** — the JWT is signed with the private key, and GitHub returns an installation access token (valid ~1 hour). The server uses installation tokens only for App-level operations that do not act as a user (e.g., checking installation status); content operations that act on behalf of the user use the **user access token**. The client secret and private key MUST NOT be committed to source control.

**Alternatives considered and rejected:**
- **OAuth App (non-App):** Simpler registration but broader permission scopes (no fine-grained repository selection). Rejected for security.
- **Device Flow:** Requires a registered application and adds a code-entry step. Not selected for MVP.
- **PAT (Personal Access Token):** Requires users to create and manage tokens in GitHub settings; tokens are long-lived and hard to revoke selectively. Rejected for the self-hosted UX.

### A-02: Content Root Configuration

**Decision:** Per-repository content root, stored server-side in SQLite.

- New Eleventy sites default to `src/posts`.
- Existing repositories (e.g., SecondBrain) may use other roots, including `Journal`.
- The content root is a single directory path (forward slashes, relative to the repository root).
- Legitimate nested directory structures under the root are preserved (e.g., `2024/December/` under root `Journal`).
- All file operations are validated to stay within the configured root.

**Path validation rules:**
1. Canonicalize the path (resolve `.`, collapse `..` segments lexically).
2. Reject absolute paths (starting with `/`).
3. Reject `..` traversal that escapes the content root after canonicalization.
4. Reject null bytes (`\0`).
5. Reject empty path for file operations (empty path is valid only for directory listing at the root).
6. The final path (content root + relative path) MUST be within the repository.

**Configuration:** The content root is set when a repository is first connected (via the `GET /api/repositories` response or a configuration endpoint) and stored in SQLite. It can be changed by the repository owner. The default for new repositories is `src/posts`.

### A-03: Project Structure

**Decision:** Single-package TypeScript architecture.

```
GitDatNote/
├── src/
│   ├── shared/          # Types, pure functions, validation (NO platform APIs)
│   │   ├── types.ts     # Repository, FileContent, DirectoryListing, ErrorDomain
│   │   ├── validate.ts  # Path validation, content validation, size limits
│   │   ├── errors.ts    # Error codes, error mapping from GitHub API
│   │   ├── slug.ts      # Filename slug generation (generateSlug, pure/deterministic)
│   │   └── frontMatter.ts # Front matter generation and parsing
│   ├── web/             # React UI (Vite build target)
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   └── components/
│   └── server/          # Node backend
│       ├── index.ts     # HTTP server entry
│       ├── auth/        # GitHub App auth flow, session management
│       ├── content/     # Repository content service (Octokit adapter)
│       ├── session/     # SQLite session storage
│       └── middleware/  # CSRF, error handling, logging
├── test/                # Vitest unit + mocked integration tests
├── e2e/                 # Playwright browser E2E tests
├── integration/         # Real GitHub integration tests (opt-in)
├── data/                # SQLite database (excluded from source control)
├── tsconfig.json
├── tsconfig.web.json
├── tsconfig.server.json
├── vite.config.ts
├── vitest.config.ts
├── .eslintrc.cjs
├── .github/workflows/ci.yml
└── package.json
```

**Shared code constraint:** `src/shared/` MUST NOT import or reference browser APIs (`document`, `window`, `fetch` in browser context), Node APIs (`process`, `fs`, `path`), or platform-specific modules. It contains only TypeScript types, pure functions, and validation logic that can run in any environment.

**Build targets:**
- `src/web/` → Vite build → static assets in `dist/`.
- `src/server/` → Node/TypeScript, run via `tsx` in development, compiled to `dist-server/` for production.

**Development proxy:** `vite.config.ts` proxies `/api` to `http://localhost:3000` so the frontend can call the backend without CORS issues.

### A-04: Session Storage

**Decision:** SQLite for persistent sessions and encrypted credential storage.

- **Library:** `better-sqlite3` (synchronous, fast, prebuilt binaries for common platforms).
- **Database file:** `./data/sessions.db` (configurable via `SESSION_DB_PATH` env var). The `data/` directory MUST be in `.gitignore`.
- **Session records:** session ID (random), user login, user name, user avatar URL, timestamps.
- **Credential storage:** user access token, refresh token, access-token expiry, and refresh-token expiry, encrypted using AES-256-GCM with a key derived from the `SESSION_ENCRYPTION_KEY` environment variable. The key is NOT stored in SQLite or source control.
- **Session persistence:** Sessions survive ordinary server restarts.
- **Session cookie attributes:**
  - `HttpOnly` — not accessible from JavaScript.
  - `Secure` — in production (HTTPS); omitted in local development (HTTP).
  - `SameSite=Lax` — prevents cross-site request forgery.
  - `Path=/` — valid for all paths.
- **Maximum session age:** Configurable via `SESSION_MAX_AGE_DAYS` env var (default: 7 days). Sessions are invalidated on logout, token revocation, or expiry.
- **Concurrent access:** `better-sqlite3` is single-connection by default, which is sufficient for a single-user self-hosted deployment.

### A-05: API Contract

**Base URL:** All API endpoints are same-origin, prefixed with `/api`.

**Authentication:** All `/api/*` endpoints except `/api/auth/github/start`, `/api/auth/github/callback`, and `/api/health` require a valid session cookie. **All state-changing requests — POST, PUT, and DELETE — MUST include a valid CSRF token in the `X-CSRF-Token` header, including `POST /api/auth/logout`.** (The foundation defines no DELETE endpoint; this rule covers any future state-changing verb and is stated uniformly.)

#### CSRF Protection
- On session creation, the server generates a cryptographically random CSRF token (32 bytes, hex-encoded) and stores it server-side (SQLite, tied to the session).
- The CSRF token is exposed to the client via `GET /api/session` (in the response body, not a cookie).
- **All state-changing requests (POST, PUT, DELETE) MUST carry the token in the `X-CSRF-Token` header.** The header is the single accepted location — the token is never read from the request body, a cookie, or the query string, so all endpoint examples below use the header consistently.
- Invalid or missing CSRF tokens result in `403 CSRF_INVALID`.
- The CSRF token is NOT the session cookie value; it is a separate random token.

#### Endpoints

##### `GET /api/health`
No authentication required.

Response `200`:
```json
{ "status": "ok" }
```

##### `GET /api/session`
Returns the current session state.

Request: (none; cookie-based auth)

Response `200`:
```json
{
  "connected": true,
  "user": { "login": "string", "name": "string", "avatarUrl": "string" },
  "repository": { "owner": "string", "name": "string", "contentRoot": "string" },
  "csrfToken": "string"
}
```

Response `401`:
```json
{ "error": { "code": "UNAUTHORIZED", "message": "No active session", "retryable": false, "status": 401 } }
```

##### `GET /api/auth/github/start`
Initiates the GitHub App authorization flow. No session required.

Response `302`: Redirect to the GitHub OAuth authorization URL.
- Generates and stores a `state` token server-side.
- Sets a short-lived pending-session cookie (TTL: 10 minutes) to carry the `state` token.

##### `GET /api/auth/github/callback?code=...&state=...`
Completes the GitHub App authorization flow. No session required (uses the pending-session cookie).

Response `302`: Redirect to `/` on success.
Response `302`: Redirect to `/error?reason=<code>` on failure.

Failure codes:
| Code | Cause |
|---|---|
| `state_mismatch` | `state` in query does not match the pending session |
| `consent_denied` | User denied the authorization |
| `code_expired` | Authorization code has expired or been used |
| `token_exchange_failed` | Server failed to exchange the code for a token |

On success:
- Validates `state` against the pending session.
- Exchanges `code` for an OAuth access token.
- Fetches user info (`GET /user`).
- Lists accessible repositories (`GET /user/repos`).
- Stores token (encrypted) and user info in SQLite.
- Creates a session record and CSRF token.
- Sets the session cookie.
- Clears the pending-session cookie.

##### `POST /api/auth/logout`
Invalidates the current session.

Request: no body. The `X-CSRF-Token` header carries the CSRF token.

Response `204`: No content.
Response `401`: No active session.
Response `403`: Invalid CSRF token.

##### `GET /api/repositories`
Lists repositories the connected user can access.

Response `200`:
```json
{
  "repositories": [
    {
      "owner": "string",
      "name": "string",
      "contentRoot": "string",
      "canRead": true,
      "canWrite": true,
      "private": false
    }
  ]
}
```

Response `401`: No active session.

##### `GET /api/repos/{owner}/{repo}/content?path=<relative-path>`
Reads a file or lists a directory.

Query: `path` — relative path within the content root. Empty or omitted means list the content root directory.

Authorization: The repository MUST be accessible through the current user's account. The path MUST be within the configured content root.

Response `200` (file):
```json
{
  "type": "file",
  "path": "string (relative to content root)",
  "content": "string (UTF-8 decoded)",
  "sha": "string (git blob SHA from GitHub Contents API)",
  "size": 1234
}
```

Response `200` (directory):
```json
{
  "type": "directory",
  "path": "string (relative to content root, or empty for root)",
  "children": [
    { "name": "string", "type": "file" | "dir", "sha": "string", "size": 1234 }
  ]
}
```

Response `403`: Repository not authorized.
Response `404`: Path not found.
Response `422`: Invalid path.

##### `POST /api/repos/{owner}/{repo}/content`
Creates a new file.

Request:
```json
{
  "path": "string (relative to content root)",
  "content": "string (UTF-8)",
  "message": "string (optional; derived from operation if absent)"
}
```
The `X-CSRF-Token` header carries the CSRF token.

Response `201`:
```json
{ "path": "string (relative to content root)", "sha": "string (new blob SHA)" }
```

Response `403`: Repository not authorized or invalid CSRF.
Response `409`: File already exists at the path.
Response `422`: Invalid path or content too large.

##### `PUT /api/repos/{owner}/{repo}/content`
Updates an existing file with SHA-based conflict detection.

Request:
```json
{
  "path": "string (relative to content root)",
  "content": "string (UTF-8)",
  "expectedSha": "string (blob SHA from a prior read)",
  "message": "string (optional; derived from operation if absent)"
}
```
The `X-CSRF-Token` header carries the CSRF token.

Response `200`:
```json
{ "path": "string (relative to content root)", "sha": "string (new blob SHA)" }
```

Response `403`: Repository not authorized or invalid CSRF.
Response `404`: File not found.
Response `409`: SHA mismatch (concurrent modification). The response `error` object includes `currentSha`, the file's current blob SHA (see Error Response Format below).
Response `422`: Invalid path or content too large.

#### Error Response Format (all error responses)
```json
{
  "error": {
    "code": "string (machine-readable error code)",
    "message": "string (human-readable description, safe for display)",
    "retryable": true | false,
    "status": 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502
  }
}
```

`SHA_CONFLICT` responses add one field to the `error` object: `currentSha`, the file's current blob SHA (the `repository-content` specification requires the current SHA to be included in a stale-update `409` response so the client can rebase).

#### Error Codes
| Code | Status | Meaning | Retryable |
|---|---|---|---|
| `UNAUTHORIZED` | 401 | No valid session or token revoked | No |
| `REPO_NOT_ALLOWED` | 403 | Repository not accessible to the user | No |
| `CSRF_INVALID` | 403 | Missing or invalid CSRF token | No |
| `PATH_INVALID` | 422 | Path is absolute, contains traversal, null bytes, or escapes content root | No |
| `FILE_NOT_FOUND` | 404 | File does not exist | No |
| `FILE_EXISTS` | 409 | Create targeted an existing path | No |
| `SHA_CONFLICT` | 409 | Expected SHA does not match current file SHA (response `error` includes `currentSha`) | No |
| `CONTENT_TOO_LARGE` | 422 | Content exceeds the size limit | No |
| `RATE_LIMITED` | 429 | GitHub API rate limit exceeded | Yes |
| `GITHUB_UNAVAILABLE` | 502 | GitHub API unreachable or returned a server error | Yes |
| `INTERNAL_ERROR` | 500 | Unexpected server error | No |

#### File Size Limits
- Text content (Markdown): maximum **1 MB** per file.
- Binary content (images, if supported in a future change): maximum **10 MB** per file.
- The limit is checked on the server before contacting the GitHub API.
- Exceeding the limit returns `422 CONTENT_TOO_LARGE`.

#### Commit Metadata
- **Commit message:** Derived from the operation and file path. Default format: `"{Create|Update} {relative-path}"` (e.g., `"Create 2024/December/my-post.md"`). If a custom `message` is provided in the request, it is used instead (sanitized: newlines stripped, max 200 characters).
- **Committer identity:** The application MUST NOT invent, hardcode, or fabricate a committer name or email, and MUST NOT embed the authenticated user's profile name or email as the committer (a profile email can be missing or private). GitHub supports this by letting the API derive the committer from the token's owner when no committer is supplied, so the default is to **omit the committer field entirely** and let GitHub attribute the commit to the authenticated user.
  - The `author` (or committer) name MAY be set to the authenticated user's profile **login** (which is always present) for readability; it MUST NOT be fabricated.
  - A commit email is set ONLY if the authenticated user has an email that is **publicly visible** on their profile (e.g., from `GET /user`'s `email`); if the email is absent or private, the email field is omitted and never guessed.
- **One commit per API operation** (no batching).

#### UTF-8 Encoding
- All file content in API requests and responses is UTF-8.
- The server encodes content as UTF-8 base64 before sending to the GitHub Contents API (`Buffer.from(content, 'utf8').toString('base64')`).
- The server decodes GitHub responses from base64 to UTF-8 before returning to the client.
- Non-ASCII content (accented characters, CJK, emoji) MUST round-trip correctly.

#### Logging
- The server SHALL NOT log request or response bodies containing file content.
- Log lines MAY include: operation type, path (relative), HTTP status code, response duration.
- Tokens, session IDs, CSRF tokens, and file content MUST NOT appear in logs.
- Log level: configurable via `LOG_LEVEL` env var (default: `info`).

#### Markdown rendering and sanitization
The web UI renders post Markdown for preview. This is an **XSS surface** because Markdown can embed raw HTML and script.
- The `setHTML()` bug in the existing `App.jsx` MUST NOT be "fixed" by assigning `marked` output to `innerHTML` unsanitized. Assigning unsanitized rendered Markdown to `innerHTML` is a stored-XSS vector.
- The web layer SHALL render Markdown with **sanitization**: parse with a Markdown parser, then pass the result through an HTML sanitizer (e.g., `DOMPurify`) configured with an allowlist that **strips scripts, event handlers (`on*`), `javascript:`/`data:` URIs, and iframe/script tags** before the HTML is inserted into the DOM.
- The sanitizer allowlist MUST be explicit and conservative; content that does not match the allowlist is dropped, not passed through.
- The UI SHALL render preview HTML into a dedicated, scoped element and MUST NOT inject Markdown-derived HTML into untrusted or unscoped regions.
- **XSS regression tests are required:** the test suite MUST include cases asserting that `<script>`, `onerror=`/`onload=` attributes, `javascript:` links, and raw `<iframe>`/`<object>` embedded in Markdown are neutralized (removed or inert) in the rendered preview. These tests belong in the web E2E/component test layer (Playwright/Vitest + jsdom).
- Sanitization is a **web-layer** concern. The server content service stores and returns raw Markdown (UTF-8) and MUST NOT render or sanitize it server-side; the API contract is unaffected.

### A-06: Error Handling Strategy

GitHub API errors are mapped to the error codes above:

| GitHub Response | Domain Error Code | Notes |
|---|---|---|
| `401` (bad/revoked token) | `UNAUTHORIZED` | Invalidate session; prompt reconnect |
| `403` (permission denied) | `REPO_NOT_ALLOWED` | Check if it's rate-limit vs. permission |
| `404` (not found) | `FILE_NOT_FOUND` or `REPO_NOT_ALLOWED` | Distinguish by checking if the repo exists |
| `409` (SHA mismatch) | `SHA_CONFLICT` | Include current SHA in response for UI |
| `422` (validation) | `PATH_INVALID` or `CONTENT_TOO_LARGE` | Parse GitHub error message |
| `429` (rate limit) | `RATE_LIMITED` | Include `Retry-After` header value if present |
| Network timeout / ECONNREFUSED | `GITHUB_UNAVAILABLE` | Retryable |
| Any other error | `INTERNAL_ERROR` | Log server-side; show generic message to user |

The UI displays `error.message` for the user and uses `error.retryable` to show/hide a retry button.

### A-07: Testing Strategy

| Layer | Framework | Scope |
|---|---|---|
| Unit tests | **Vitest** | Validation logic, error mapping, path canonicalization, front matter generation, slug generation |
| Mocked integration tests | **Vitest** + mock Octokit | Content service end-to-end (list, read, create, update, conflict, invalid path, size limit, UTF-8) without network |
| Browser E2E tests | **Playwright** | Sign-in state, repository selection, read/create/update flows against a local or mocked backend |
| Real GitHub integration tests | **Vitest** (opt-in) | Against a dedicated test repository; credentials from CI secrets or local env var `GITHUB_INTEGRATION_TOKEN` |

**Vitest configuration:** `vitest.config.ts` with `environment: 'node'` for server tests and `environment: 'jsdom'` for web component tests. The existing legacy characterization suite (`tests/characterization/`, 25 JavaScript tests, task 1.4) MUST remain in the include set and passing alongside the new suites.

**Playwright configuration:** `playwright.config.ts` with a local backend fixture.

**Real GitHub integration tests:**
- Opt-in via `GITHUB_INTEGRATION=true` env var.
- Run against a dedicated test repository (created manually or via a setup script).
- Tests create files only inside a **unique timestamped subdirectory** (e.g., `__gitdatnote-integration-<UTC-ISO>/`) within the test repository's content root.
- **Cleanup is test-only and isolated:** after the test run, the test harness deletes the test subdirectory and its files **directly through the GitHub Contents API using the dedicated test credential** (`GITHUB_INTEGRATION_TOKEN`). This does NOT expand the production content API with a delete operation — the production API in this change exposes only list, read, create, and update. Cleanup failure is logged and must not be treated as a passed test.
- Credentials: `GITHUB_INTEGRATION_TOKEN` env var (fine-grained PAT or App token with access to the test repo).
- MUST NOT run against the SecondBrain repository or any production content.

### A-08: Dependency Strategy

**Remove:**
- `node` (runtime, not a package)
- `react-scripts` (CRA; unused)
- Duplicate `dotenv` (keep in `devDependencies` only, or remove if the server uses a different env loader)
- `node-base64-img` (imported in deleted `addImage.js`)

**Keep:**
- `react`, `react-dom`
- `marked` (Markdown preview)
- `slugify` (filename generation)
- `octokit` (GitHub API client, server-side only)
- `vite`, `@vitejs/plugin-react`
- `eslint`, `eslint-plugin-react`, `eslint-plugin-react-hooks`

**Add:**
- `typescript`
- `@types/node`
- `@types/react`, `@types/react-dom` (already present, verify versions)
- `vitest`
- `@playwright/test`
- `better-sqlite3`
- `zod` (request validation)
- `tsx` (TypeScript execution for server in development)

**npm scripts (introduced where their backing files exist — no placeholder or fake-passing scripts):**
- `dev` (`vite`), `build` (`vite build`), `lint` (`eslint`), `test` (`vitest run`) — established in task 2.1.
- `typecheck` (`tsc` against `tsconfig.web.json` + `tsconfig.server.json`) — added in task 2.2, once the tsconfigs exist.
- `test:e2e` (`playwright test`) — added in task 2.7, together with `playwright.config.ts`.
- `test:integration` (opt-in real-GitHub suite) — added in task 5.1, together with the `integration/` harness.

**Package name:** `gitdatnote`.

**Node version:** **Node.js 24 LTS** is the minimum supported runtime. It is documented in `package.json` `engines` (`"node": ">=24"`), setup docs, and CI. **CI MUST verify on both Node 24 LTS and Node 26.** End-of-life Node.js releases MUST NOT be targeted.

**Dependency security (Phase 2 gate — task 2.10):** Before Phase 2 is complete, run a targeted `npm audit` review. Known high and critical vulnerabilities reachable from the runtime tree (the `octokit` tree ReDoS advisories; `jws` via `@octokit/app`) MUST be fixed with non-breaking updates where a fix exists. Remaining high/critical entries (currently dev-tooling only: `happy-dom`, `tinypool`/`vitest`, `esbuild`) may stand as documented exceptions in `audit.md` when a fix requires a breaking-major upgrade the verification battery cannot absorb; each exception records rationale and a follow-up. `npm audit fix --force` and broad forced upgrades are prohibited.

---

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| GitHub App registration adds onboarding friction for self-hosters | Clear setup docs with step-by-step instructions; consider a "guided setup" UI in a future change |
| `better-sqlite3` is a native module requiring compilation | Prebuilt binaries available for common platforms; document `npm rebuild better-sqlite3` for unusual environments |
| Single-package layout requires careful build configuration | Separate `tsconfig.web.json` and `tsconfig.server.json`; Vite handles web, `tsc` handles server |
| Concurrent edits produce SHA conflicts | UI presents both versions for user resolution (deferred to editor change); foundation returns clear `SHA_CONFLICT` errors |
| GitHub API rate limits | Server caches rate-limit headers; UI shows `RATE_LIMITED` with retry guidance; no automatic retries (user-initiated only) |
| Migration can regress original behavior | Characterization tests (task 1.3/1.4) capture reusable concepts before rewrite; no writes to SecondBrain in any test |
| Session encryption key management | Key is an env var; document that it must be set before starting the server; if the key changes, all sessions are invalidated (acceptable for MVP) |

## Open Questions

All previously open questions are now resolved:
- ~~Hosting/runtime environment~~ → Node.js 24 LTS minimum (`engines: "node": ">=24"`), CI-verified on 24 and 26; self-hosted.
- ~~GitHub App registration/distribution~~ → Operator registers their own App; setup docs provided.
- ~~Repository and content-root selections~~ → Per-repo content root, default `src/posts`, configurable.
- ~~Legacy tests worth porting~~ → No existing tests. See audit.

No open questions remain for this change.

## Verification Strategy

- Mocked GitHub unit tests (Vitest) for all validation, error mapping, and content service logic.
- Opt-in integration tests against an isolated dedicated test repository.
- Failure-case tests: authorization denied, token expired/revoked, invalid paths (traversal, absolute, null byte), SHA mismatches, duplicate create, rate limits, CSRF missing/invalid, UTF-8 round-trip, content too large.
- CI runs on a **Node 24 LTS + Node 26 matrix**: install, lint, typecheck (web + server), build, unit tests (including the 25 legacy characterization tests), mocked integration tests.
- **Targeted dependency-security review before Phase 2 completion (task 2.10):** non-breaking fixes for runtime-reachable high/critical advisories; documented exceptions only for breaking-major dev-tooling fixes; no `npm audit fix --force`.
- Playwright E2E: sign-in state, repository selection, read, create, update flow.
- No automated commits to SecondBrain or any production repository.

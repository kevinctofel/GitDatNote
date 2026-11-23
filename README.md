# GitDatNote 2.0

A self-hostable, GitHub-backed blogging tool. GitDatNote's goal is to make
GitHub-based blogging accessible to nontechnical creators: write, preview, and
publish articles directly in a GitHub repository — no local Git workflow
required.

This repository currently contains the **foundation** of GitDatNote 2.0. It is
not yet a finished blogging product: the full article editor, turnkey blog
creation, and the complete publishing workflow are **not yet implemented** (see
[Current limitations and next steps](#current-limitations-and-next-steps)).

## Current implementation status

Implemented today:

- **React frontend** — connection-state UI (loading / connected / disconnected /
  error) with a GitHub Connect action and a clearly labeled sample-data preview.
- **Node.js backend** — built-in `http` server (no framework), structured
  request logging, and a standard JSON error envelope.
- **GitHub App user authorization** — OAuth code flow with PKCE and the
  `offline_access` scope, so user tokens expire and can be refreshed.
- **Encrypted session storage** — server-side SQLite session database with
  AES-256-GCM encryption at rest; GitHub credentials never reach the browser.
- **Token refresh and rotation** — transparent refresh with full rotation
  (GitHub rotates both tokens), single-flight per session, fail-closed
  invalidation on rejection.
- **Repository discovery** — lists the repositories the connected user and the
  GitHub App installation may access, with read/write capability per repo.
- **GitHub-backed content API** — read, create, and update Markdown files in a
  repository's content root, with repository-authorization, path-validation,
  size-limit, and SHA conflict protection.
- **Markdown preview** — client-side rendering with sanitized output (see
  [Security architecture](#security-architecture)).
- **Security boundaries** — CSRF protection, session cookies, repository
  authorization, and sanitized logging (below).
- **Automated testing** — 800+ unit tests, browser E2E tests, and an offline
  integration safety suite; a credentialed live-GitHub suite exists behind an
  explicit opt-in gate (see [Testing](#testing)).

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js 24 LTS** | Recommended development runtime. `package.json` `engines` requires `>=24`; Node.js 26 remains a tested CI runtime. |
| **npm** | Ships with Node. Dependencies install from the committed lockfile. |
| **Git** | For cloning the repository. |
| **A GitHub account** | Required for authenticated functionality (sign-in, repositories, content). |
| **A GitHub App** | Required to connect a real account (see [GitHub App registration](#github-app-registration)). |

Install dependencies using the committed lockfile:

```bash
npm ci
```

> A local preview works **without** a configured GitHub App, but no
> authenticated functionality (sign-in, repositories, content) is available
> until the App and environment are configured (below). The application is not
> fully operational in its unconfigured state.

## Quick start — local preview (no GitHub App needed)

Terminal 1 — backend API server (port 3000):

```bash
npm run dev:server
```

Terminal 2 — Vite frontend (port 5173):

```bash
npm run dev
```

Then open <http://localhost:5173>. Without GitHub App configuration you will
see the **disconnected state** and can use the "Preview the connected layout
(sample data)" affordance to see the connected layout with fixture data — no
live GitHub connection is made and no server credentials are involved.

- Backend: `http://127.0.0.1:3000` (default `HOST`/`PORT`)
- Frontend: `http://localhost:5173`
- The Vite dev server proxies `/api/*` to `http://localhost:3000`, so the
  frontend needs no separate API configuration in development.

## GitHub App registration

GitDatNote 2.0 authorizes through a **GitHub App** (not a traditional OAuth
app). The current flow uses the App's *user authorization* endpoint (the web
OAuth flow): a browser-based code exchange with PKCE, requested with the
`offline_access` scope so GitHub issues **expiring** access tokens plus a
**refresh token** (~180-day lifetime) that the server refreshes with full
rotation.

1. **Create the App.** In GitHub: *Settings → Developer settings → GitHub
   Apps → New GitHub App* (or <https://github.com/settings/apps/new>).
2. **Note the Client ID.** The App page shows two identifiers:
   - **App ID** — a plain number (e.g. `123456`). This is the App-level
     identity used for App installation webhooks/installation APIs.
   - **Client ID** — begins with `Iv1.`. This is what the authorization URL
     uses. Configure `GITHUB_APP_CLIENT_ID` with the **Client ID**, not the
     numeric App ID.
3. **Generate a Client Secret.** On the App page, *Generate a client secret*.
   It is shown **once** — store it as `GITHUB_APP_CLIENT_SECRET`.
4. **Set the Authorization callback URL.** It must **exactly match**
   `GITHUB_OAUTH_CALLBACK_URL` (including scheme and port), e.g.
   `http://127.0.0.1:3000/api/auth/github/callback` for local development. A
   mismatch makes GitHub reject the redirect.
5. **Set repository permissions.** Grant **Contents: Read and write** and
   **Metadata: Read**. Do **not** grant repository-creation permission —
   the project intentionally does not create repositories. No other
   permissions are needed for the current flow.
6. **Install the App.** Install the App on your own (personal) account and
   select the specific repositories GitDatNote may access — not necessarily
   all repositories. Repository access comes from this installation and the
   permissions declared above, not from traditional OAuth repository scopes.
7. **Authorize in the browser.** Clicking **Connect GitHub** in the UI (or
   `GET /api/auth/github/start`) redirects you to GitHub's consent page. The
   server holds a short-lived (10-minute) pending authorization bound to your
   browser. After you approve, GitHub redirects to the callback URL, the
   server exchanges the code for tokens, creates an encrypted session, and
   returns you to the app connected as your user.

**Disconnecting.** Use the **Disconnect** action (or
`POST /api/auth/logout`, which is CSRF-protected like every state-changing
route): the server session is deleted and the session cookie is cleared.

> `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are App-level values (identity
> and installation signing credential). The current user-authorization flow
> does **not** consume them — see the environment table below.

## Environment variables

The backend reads configuration from the **process environment**. Note: the
server does **not** automatically load a `.env` file — copy `.env.example` to
`.env`, fill in real values, then load it into your shell before starting the
backend, for example:

```bash
set -a
source .env
set +a
```

or export individual variables inline for a single command.

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | No (default `3000`) | Backend HTTP port. Must be an integer 1–65535; invalid values fail fast at startup. |
| `HOST` | No (default `127.0.0.1`) | Backend bind address. |
| `LOG_LEVEL` | No (default `info`) | Server logging level: `debug`, `info`, `warn`, or `error`. |
| `SESSION_ENCRYPTION_KEY` | Yes for sessions/auth | 64-character hex string (256-bit key) for AES-256-GCM session encryption. Must be unique per deployment; env-only — never logged, never in the repo. The server **starts** without it, but no session can be created (you stay permanently disconnected). |
| `SESSION_DB_PATH` | No (default `./data/sessions.db`) | SQLite session database location. The parent directory is created on startup. The database is gitignored — never commit it. |
| `SESSION_MAX_AGE_DAYS` | No (default `7`) | Session lifetime in whole days (1–3650). |
| `SESSION_COOKIE_SECURE` | No | Set to `true` or `1` to force the `Secure` cookie attribute outside production. `NODE_ENV=production` always sets it. |
| `GITHUB_APP_CLIENT_ID` | Yes for auth | The GitHub App **Client ID** (`Iv1.…`). Drives the authorization URL. |
| `GITHUB_APP_CLIENT_SECRET` | Yes for auth | Server-side secret for the authorization-code exchange. Never exposed to the browser. |
| `GITHUB_OAUTH_CALLBACK_URL` | Yes for auth | Must exactly match the App's Authorization callback URL, e.g. `http://127.0.0.1:3000/api/auth/github/callback`. |
| `GITHUB_APP_ID` | No | App-level identity (the numeric App ID). **Not consumed by the current user-authorization flow.** |
| `GITHUB_APP_PRIVATE_KEY` | No | App-level signing credential. **Not consumed by the current user-authorization flow.** |

### Generating a session encryption key

Generate a fresh 256-bit key per deployment (never reuse one across
deployments, and never commit one):

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

This task's documentation deliberately does not include any real secrets; put
generated values in your local `.env` or environment only.

## Starting frontend and backend

**Development (two terminals):**

```bash
# Terminal 1 — API server on http://127.0.0.1:3000
npm run dev:server

# Terminal 2 — Vite frontend on http://localhost:5173 (proxies /api to :3000)
npm run dev
```

**Production:**

```bash
npm run build        # frontend bundle → dist/
npm run build:server # backend build → dist-server/
NODE_ENV=production npm start   # node dist-server/server/index.js
```

With `NODE_ENV=production`, the session cookie is always sent with the
`Secure` attribute (serve over HTTPS).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (frontend) with the `/api` proxy. |
| `npm run dev:server` | Backend dev server via `tsx` (no build step). |
| `npm run build` | Production frontend build (Vite). |
| `npm run build:server` | Production backend build (TypeScript → `dist-server/`). |
| `npm start` | Run the compiled backend (`node dist-server/server/index.js`). |
| `npm run lint` | ESLint over the project. |
| `npm run typecheck` | `tsc --noEmit` over all three TypeScript projects (web, server, integration). |
| `npm test` | Vitest unit/mock suite (no network access). |
| `npm run test:e2e` | Playwright browser E2E suite (Chromium). |
| `npm run typecheck:integration` | Typecheck the integration test modules. |
| `npm run test:integration:offline` | Offline integration **safety** suite (no credentials, no network). |
| `npm run test:integration` | **Real-GitHub integration suite — opt-in only** (see below). |

## Testing

- **Unit/mock tests** (`npm test`) — fast, hermetic, mock GitHub; no network.
- **Browser E2E tests** (`npm run test:e2e`) — Playwright driving Chromium
  against the local stack; includes assertions that no credentials appear in
  the DOM/console. If it fails with "Executable doesn't exist", the Playwright
  browser binaries are missing — run `npx playwright install chromium` and
  re-run.
- **Offline integration safety tests** (`npm run test:integration:offline`) —
  verify the live-suite safety gates (opt-in handling, token handling,
  cleanup) without any credentials or network.
- **Real-GitHub integration tests** (`npm run test:integration`) — run against
  an **actual GitHub API** with a real token. This suite is **explicitly
  opt-in** and requires a **disposable, dedicated test repository** with a
  **restricted token**. Never point it at a production repository (e.g.
  SecondBrain or the GitDatNote source repository). Full instructions and the
  opt-in environment variables are in [`integration/README.md`](integration/README.md).

## Security architecture

The following describes the **implemented** behavior, verified against source
and tests. Claims are limited to what the current code actually does.

### CSRF protection

- Every state-changing `POST`, `PUT`, and `DELETE` request under `/api/*`
  — **including logout** — must present a session-bound CSRF token in the
  **`X-CSRF-Token` header** (header-only; no cookie or query-string tokens).
- The token is generated securely (32 random bytes, hex) when the session is
  created, stored in the session database's `csrf_token` column, and returned
  to the authenticated browser through `GET /api/session` (which also reports
  connection status). It is a session-bound bearer credential for header-based
  protection and must be treated as sensitive — it is not public data. (In
  contrast, the GitHub access and refresh tokens are encrypted at rest with
  AES-256-GCM.)
- Checks are constant-time and reject duplicate/malformed headers; a missing
  session yields `401 UNAUTHORIZED`, a missing/malformed/mismatched token
  yields `403 CSRF_INVALID`, and an unreadable token store fails closed with
  `500`.
- CSRF is a separate boundary from repository authorization: passing one never
  substitutes for the other.

### Session cookies

- Cookie name `gitdatnote_session`, carrying a 64-hex random session
  identifier.
- `HttpOnly` (never readable by page scripts), `SameSite=Lax`, `Path=/`.
- `Secure` when `NODE_ENV=production` or when `SESSION_COOKIE_SECURE` is set
  to `true`/`1`.
- `Max-Age`/`Expires` track the session lifetime (`SESSION_MAX_AGE_DAYS`,
  default 7 days); sessions expire and are purged, and logout clears the
  cookie immediately.
- Any missing, malformed, unknown, or expired cookie is treated as
  unauthenticated — no error is surfaced.

### Credential storage, refresh, and rotation

- Sessions (user, GitHub access token, refresh token, expiry) persist in
  server-side **SQLite** (`better-sqlite3`) at `SESSION_DB_PATH`
  (default `./data/sessions.db`, gitignored; parent directory created with
  restrictive permissions on POSIX).
- The GitHub access and refresh tokens are stored **AES-256-GCM encrypted**
  with a random 12-byte IV per write, keyed by `SESSION_ENCRYPTION_KEY`. The
  CSRF token is stored separately in the `csrf_token` column and is not
  encrypted by the session credential encryption routine. The key must be a
  64-hex
  (256-bit) value, unique per deployment, supplied only via the environment,
  and is never logged.
- GitHub **access tokens expire** (the flow requests `offline_access`). When a
  request needs an expired (or within-60-second) token, the server refreshes
  it via GitHub's documented refresh endpoint.
- GitHub **rotates both tokens** on refresh: the new access token and new
  refresh token replace the old ones, and the **old refresh token is consumed
  — it is never retried**.
- Refresh outcomes: HTTP `401` and a genuine credential-rejection `403`
  (including the documented `bad_refresh_token`) **invalidate the session**
  (the user must reconnect); a recognized GitHub rate-limit `403` (indicated
  by `X-RateLimit-Remaining: 0`), HTTP `429`, and transient `5xx`/transport
  failures **preserve the session** for a later retry.
- Refreshes are single-flight per session (one in-flight refresh in this
  single-process server), and refresh-token lifetime is ~180 days.
- The GitHub Client Secret, access tokens, and refresh tokens are never sent
  to browser JavaScript. The browser receives the session identifier in the
  `gitdatnote_session` cookie, which is `HttpOnly`, preventing page
  JavaScript from reading its value. The authenticated session endpoint
  returns the user's non-secret identity, connection status, and the
  session-bound CSRF token — not GitHub credentials.

### Repository and content safety

- Every content request to `/api/repos/{owner}/{repo}/content` passes a
  **fail-closed authorization boundary**: the server re-authorizes the exact
  repository per request (user permission **and** the App installation's
  permission). `GET`/`HEAD` require read access; `POST`/`PUT`/`DELETE` require
  write access. Unauthorized repositories receive a safe `403`
  (`REPO_NOT_ALLOWED`); a rejected GitHub token (`401`) invalidates the
  session.
- **Path validation:** requested paths are relative to the server-resolved
  content root (default `src/posts`; never browser-supplied) and must stay
  beneath it. Absolute paths, `..` traversal, backslashes, and control
  characters are rejected (`PATH_INVALID`).
- **Size limits:** a single Markdown file may not exceed **1 MiB
  (1,048,576 UTF-8 bytes)**; oversized content is rejected as
  `CONTENT_TOO_LARGE` before any upstream write.
- **Update conflict handling:** updates supply the file's current `sha`; a
  mismatch (concurrent modification) is rejected as `SHA_CONFLICT` and returns
  the current `sha` so clients can reconcile. Creates reject an existing
  path as `FILE_EXISTS`.
- Repository discovery (`GET /api/repositories`) reports per-repository
  `canRead`/`canWrite` capability from the same live authorization.

### Logging

- Structured single-line JSON request logs gated by `LOG_LEVEL`.
- Log lines carry only the method, a **sanitized route label**, status, and
  duration — dynamic paths are reduced to fixed templates (e.g.
  `/api/repos/{owner}/{repo}/content`); unparseable request targets log a
  fixed `(unparseable)` marker.
- Query strings, request/response bodies, headers, tokens, session cookies,
  authorization headers, article content, and raw sensitive paths are never
  logged (the OAuth callback query string, which contains the code, is never
  logged).
- Unexpected errors are logged server-side as the error **name only** and
  returned to clients as a safe `500` envelope without messages, stacks, or
  paths.

### Markdown sanitization

- Markdown preview is **client-side only** (`src/web/markdown.ts`); the
  server returns raw content and never renders Markdown.
- Parsing uses `marked` (GFM) and output is sanitized with **DOMPurify's
  default profile** plus an explicit deny list: `script`, `style`, `iframe`,
  `object`, `embed`, `form`, `meta`, `base`, `noscript` tags; `style` and
  `formaction` attributes.
- This removes script execution, inline event handlers, dangerous URL
  schemes (`javascript:`, `data:`), and embedded active content from
  previewed articles.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "Not connected" and Connect GitHub fails with a config error | GitHub App env vars are missing. The unconfigured server logs `auth_not_configured`; set `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, and `GITHUB_OAUTH_CALLBACK_URL`. |
| GitHub redirect error ("callback URL mismatch") | The App's Authorization callback URL and `GITHUB_OAUTH_CALLBACK_URL` differ (scheme, host, port, or path). Make them identical. |
| Session/storage errors at sign-in | `SESSION_ENCRYPTION_KEY` is missing or malformed (must be 64 hex chars). The server starts without it and logs `session_storage_unavailable`, but no session can be created. Generate a fresh key with the command above. |
| Backend won't start: invalid port | `PORT` must be a base-10 integer 1–65535; invalid values log `invalid_port` and the server exits. |
| Port already in use | Stop the other process or change `PORT`; verify with your OS tooling (e.g. `ss -ltn`). |
| Frontend loads but API calls fail | The Vite proxy targets `http://localhost:3000` — make sure the backend is running on that port (or adjust `vite.config.ts` and `HOST`/`PORT` consistently). |
| `401 UNAUTHORIZED` on a state-changing request | No valid session — sign in again (the session may have expired or been invalidated, e.g. after a refresh-token rejection). |
| `403 CSRF_INVALID` on save/logout | The `X-CSRF-Token` header is missing, stale, or doesn't match the session. Re-fetch `GET /api/session` and use the current `csrfToken`. |
| `403 REPO_NOT_ALLOWED` on repository/content access | The App is not installed on (or lacks the Contents/Metadata permission for) that repository — check the App installation and repository selection. |
| `npm run test:e2e` fails with "Executable doesn't exist" | Playwright browser binaries are missing: run `npx playwright install chromium`, then re-run. |

## Current limitations and next steps

The foundation is verified and tested, but GitDatNote 2.0 is **not yet a
finished blogging product**:

- **No article editor UI** — the content API (read/create/update with SHA
  conflict protection) is implemented and tested, but there is no
  user-facing editor yet.
- **No turnkey blog creation** — the App intentionally cannot create
  repositories; users work with repositories they already have access to.
- **No full publishing workflow** — the connected view is a layout preview
  with sample data; writing and publishing flows arrive in later changes.
- The current authorization flow does not yet use `GITHUB_APP_ID` or
  `GITHUB_APP_PRIVATE_KEY` (reserved for App-level operations such as
  repository creation, out of scope for this change).

See the OpenSpec change `modernize-gitdatnote-foundation` for the tracked
plan.

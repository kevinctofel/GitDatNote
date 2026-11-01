# Architecture decisions

## Resolved decisions (foundation change)

| ID | Decision | Rationale |
|---|---|---|
| D-01 | React + TypeScript + Vite frontend | Standard stack; Vite already in use; TypeScript adds type safety for the new shared domain |
| D-02 | Single-package TypeScript: `src/web`, `src/server`, `src/shared` | Simplest layout for a single-user self-hosted app; `src/shared` constrained to platform-agnostic code |
| D-03 | GitHub App with fine-grained permissions, server-side web auth flow | GitHub Apps can be owned by personal accounts; fine-grained `Contents: read/write` + `Metadata: read`; no repository-creation permission. Device Flow and OAuth App rejected (see design A-01) |
| D-04 | Node.js 24 LTS, self-hosted | Current LTS line; documented in `package.json` engines (`>=24`); end-of-life releases not targeted |
| D-05 | SQLite (`better-sqlite3`) for sessions; AES-256-GCM encrypted credentials; key in env var | Durable, survives restarts; no external service needed for self-hosting; key outside DB and source control |
| D-06 | Per-repository content root, default `src/posts`, existing repos may use e.g. `Journal` | Generic CMS must support existing repo layouts; nested directory structures preserved |
| D-07 | Explicit API contract: typed endpoints for list/read/create/update, standard error format | Removes the "list or read" ambiguity; frontend and backend can be built against a fixed contract |
| D-08 | Vitest (unit + mocked integration), Playwright (E2E), opt-in real GitHub integration tests | Vitest pairs with Vite; Playwright for browser flows; real integration tests isolated to a dedicated test repo |
| D-09 | CSRF protection: per-session random token, `X-CSRF-Token` header on all state-changing requests (POST/PUT/DELETE, incl. logout), `SameSite=Lax` cookie | Same-origin API with session cookies needs explicit CSRF defense; header is the single token location |
| D-10 | UTF-8 encoding throughout; 1 MB text / 10 MB binary size limits; no file content in logs | Fixes the existing `btoa()` Latin-1 bug; prevents abuse and log leakage |
| D-11 | Commit messages derived from operation + path; committer via GitHub attribution (no hardcoded/invented identity; email only if public) | No hardcoded personal names, emails, or repository identifiers; safe for missing/private profile email |
| D-12 | GitHub App user tokens modeled as expiring: access token 8h, refresh token 6m, secure rotation, recovery via re-auth | Matches GitHub's current behavior; never assume tokens are non-expiring |
| D-13 | Two credential pairs: client ID+secret for web flow; private key+App ID for JWT/installation tokens | Distinguishes the App's four identifiers by use; keeps secrets out of the wrong flows |
| D-14 | Repository authorization = user permission AND App installation access; visible-but-not-writable repos are read-only | Prevents writes where the App is installed read-only or uninstalled; per-repo `canRead`/`canWrite` |
| D-15 | Markdown preview rendered with an HTML sanitizer (allowlist), XSS regression tests | Prevents stored XSS; `setHTML()`/`innerHTML` not used unsanitized |
| D-16 | CSRF token required on logout and every state-changing request, via `X-CSRF-Token` header only | Uniform, unambiguous CSRF across all state-changing verbs including logout |
| D-17 | Integration-test cleanup via dedicated test credential + isolated test subdirectory; no delete in production API | Keeps test isolation without expanding the foundation content API with deletion |

## Deferred decisions (later changes)

| ID | Topic | Deferred to |
|---|---|---|
| D-18 | Eleventy starter package layout and versioning | `generate-eleventy-blog` |
| D-19 | GitHub Pages deployment mechanics and job status | `publish-blog` |
| D-20 | Custom domain verification and HTTPS | `connect-custom-domains` |
| D-21 | File deletion API and UI | `implement-article-editor` |
| D-22 | Hosted SaaS infrastructure, tenancy, billing | `gitdatnote-cloud` |

## Security baseline
- Never accept arbitrary repository paths without canonical validation against the configured content root.
- Never commit or log tokens, session IDs, CSRF tokens, or file content.
- Never put privileged credentials into Vite `VITE_*` variables or any browser bundle.
- GitHub App flow uses server-side state validation; no client-side secrets.
- CSRF token required on all state-changing requests (POST/PUT/DELETE, incl. logout), via `X-CSRF-Token` header only.
- Session cookies: `HttpOnly`, `SameSite=Lax`, `Secure` (production).
- Content size limits enforced server-side before contacting GitHub.
- Repository access verified server-side on every content operation (user permission AND App installation access).
- Never assign unsanitized rendered Markdown to `innerHTML`; sanitize with a conservative allowlist.
- Never assume a GitHub App token never expires; model access/refresh expiry, rotate refresh tokens, recover via re-auth.
- Use client ID + client secret for the web flow; use private key + App ID only for JWT/installation tokens.
- Never embed or fabricate a committer email; use GitHub commit attribution.
- If webhooks are added later, handle signature verification and replay protection.

## Migration strategy
- Work on feature branch `feat/gitdatnote-2`; preserve Git history.
- Source audit complete (`audit.md`): reusable concepts documented, obsolete code identified.
- Delete `updatePost.js` and `addImage.js` (obsolete, Node-specific, wrong repo, top-level await bugs).
- Rewrite `getPostTitles.js`, `newPost.js`, `buildFrontMatter.js` as server-side services.
- Rewrite `App.jsx` as the connected-state shell in `src/web/App.tsx`.
- Keep `main.jsx` (renamed), `Post.jsx` (updated), CSS files (updated).
- Characterization tests capture reusable concepts before rewrite.
- No writes to the SecondBrain repository or any production repository in automated tests.

# Source Audit: GitDatNote Existing Code

> Audit of all source files in the GitDatNote repository on branch `feat/gitdatnote-2` (commit `2f3bbef`).
> This document is the deliverable for task 1.2 and informs all subsequent tasks.

## File-by-File Findings

### `package.json`
| Issue | Detail |
|---|---|
| Package name | `"11tycms"` — incorrect; should be `"gitdatnote"` |
| `"node": "^21.1.0"` as a dependency | `node` is the runtime, not an npm package. Fails or is ignored by npm; signals confusion |
| `"react-scripts": "^5.0.1"` | CRA dependency; unused (app uses Vite). Remove |
| `dotenv` duplicated | Appears in both `dependencies` and `devDependencies` |
| Missing: `node-base64-img` | Imported in `addImage.js` but not declared |
| No test framework | No test runner configured |
| No TypeScript | No `typescript`, `@types/node`, or `tsconfig.json` |

### `src/components/getPostTitles.js`
| Issue | Detail |
|---|---|
| Hardcoded owner/repo/path | `kevinctofel/SecondBrain`, `Journal/2024/December/` |
| Browser-side privileged token | `import.meta.env.VITE_GITHUB_TOKEN` — token in browser bundle |
| No error handling | Unhandled promise rejections |
| Unused internal function | `postInfo` defined but never called |
| **Concept to retain** | Directory listing → filter `.md` → extract `{ title, url, sha }` |

### `src/components/newPost.js`
| Issue | Detail |
|---|---|
| Hardcoded owner/repo/path | Same as `getPostTitles.js` |
| Browser-side privileged token | Same `VITE_GITHUB_TOKEN` issue |
| Unused circular import | `import App from "../App.jsx"` — circular dependency, never used |
| `btoa()` encoding | Latin-1 only; corrupts non-ASCII content (accented chars, CJK, emoji) |
| No conflict detection | `PUT` without `sha` — silently overwrites existing files |
| Hardcoded committer identity | Name and email as string literals |
| `slugify` usage | Correct concept (title → slug filename), but no collision handling |
| **Concepts to retain** | Front matter generation, slug-based filename, commit message pattern |

### `src/components/buildFrontMatter.js`
| Issue | Detail |
|---|---|
| Minimal front matter | Only `title` and `date`; missing `description` and `tags` |
| Date format | `toISOString()` produces full ISO 8601 with time; convention is `YYYY-MM-DD` |
| No YAML safety | Titles containing `:`, `#`, or leading special characters produce malformed YAML |
| **Concept to retain** | Front matter structure (title, date, description, tags) |

### `src/components/updatePost.js`
| Issue | Detail |
|---|---|
| **Top-level `await`** | `await octokit.request(...)` at module scope — executes on import, not on call |
| Node-specific | Uses `process.env.GITHUB_AUTH_KEY` (Node env var, not Vite) |
| Different repo | References `kevinctofel/MyConsciousStream` |
| Correct pattern | Uses `sha` in `PUT` request (conflict detection) — **retain this concept** |
| **Recommendation** | **Delete.** The SHA-based update concept moves to the server-side content service |

### `src/components/addImage.js`
| Issue | Detail |
|---|---|
| **Top-level `await`** | Same bug as `updatePost.js` |
| Node-specific | Uses `process.env.GITHUB_AUTH_KEY` and `node:fs/promises` |
| Different repo | References `MyConsciousStream` |
| Undeclared dependency | `node-base64-img` not in `package.json` |
| Hardcoded file path | `./images/IMG_0076.jpeg` |
| **Recommendation** | **Delete.** Image upload is out of scope for the foundation change |

### `src/components/Post.jsx`
| Issue | Detail |
|---|---|
| Stub component | Renders title only; no date, URL link, or delete |
| Acceptable | Placeholder; full post card is an editor change |

### `src/App.jsx`
| Issue | Detail |
|---|---|
| `setHTML()` bug | `previewElement.setHTML(...)` — not a DOM method; should be `innerHTML` |
| No error handling | `handlePublish` calls `newPost()` without `await` or `catch` |
| `populateTextArea` stub | Sets placeholder text, doesn't load post content |
| No loading states | No indicator while posts are fetched |
| No connected-state UI | No indication of GitHub connection status |
| **Concepts to retain** | Overall layout structure (post list + editor + preview) |

### `src/main.jsx`
Clean. Standard React 18 entry point. No issues.

### `src/index.css` / `src/App.css`
Minimal styling. Will need rework for the new UI.

### `vite.config.js`
Minimal: only the React plugin. Needs proxy configuration for the backend API in development.

### `.eslintrc.cjs`
JS-only: no TypeScript rules. Needs updating for `.ts`/`.tsx` files.

### `index.html`
Standard Vite template. No issues.

### `public/vite.svg`, `src/assets/react.svg`
Template assets. Harmless; can be kept or removed.

---

## Reusable Concepts

| # | Concept | Source | Migration Target |
|---|---|---|---|
| 1 | Front matter structure (title, date, description, tags) | `buildFrontMatter.js` | `src/shared/frontMatter.ts` |
| 2 | Slug-based filenames (`slugify(title)`) | `newPost.js` | `src/shared/slug.ts` |
| 3 | SHA-based conflict detection (`sha` in `PUT`) | `updatePost.js` | `src/server/content/` |
| 4 | Directory listing → post list (filter `.md`, extract metadata) | `getPostTitles.js` | `src/server/content/` |
| 5 | Markdown preview (`marked`) | `App.jsx` | `src/web/` (keep `marked` dependency) |
| 6 | Overall app layout (post list + editor + preview) | `App.jsx` | `src/web/App.tsx` |

## Obsolete Code (Delete or Rewrite)

| File | Action | Reason |
|---|---|---|
| `src/components/updatePost.js` | **Delete** | Top-level await, Node-specific, wrong repo |
| `src/components/addImage.js` | **Delete** | Top-level await, Node-specific, wrong repo, undeclared dep |
| `src/components/getPostTitles.js` | **Rewrite** | Move to server-side; remove hardcoded paths and browser token |
| `src/components/newPost.js` | **Rewrite** | Move to server-side; remove browser token, add conflict detection |
| `src/components/buildFrontMatter.js` | **Rewrite** | Add description/tags, fix date format, add YAML safety |
| `src/App.jsx` | **Rewrite** | Fix `setHTML` bug, add error handling, add connected-state UI |
| `src/components/Post.jsx` | **Keep (update)** | Extend with date, URL; full card in editor change |
| `src/main.jsx` | **Keep** | Rename to `src/web/main.tsx` |
| `package.json` | **Rewrite** | Fix name, remove obsolete deps, add TypeScript/test framework |
| `vite.config.js` | **Rewrite** | Add proxy, TypeScript config |
| `.eslintrc.cjs` | **Rewrite** | Add TypeScript rules |

## Security Issues

| # | Issue | Severity | Mitigation |
|---|---|---|---|
| 1 | `VITE_GITHUB_TOKEN` in browser bundle | **Critical** | Move all GitHub API calls to server-side; token never reaches browser |
| 2 | `btoa()` encoding | **High** | Use UTF-8 base64 (`Buffer.from(content, 'utf8').toString('base64')`) |
| 3 | No CSRF protection | **High** | Per-session CSRF token, `X-CSRF-Token` header on POST/PUT |
| 4 | No input validation | **High** | Path canonicalization, size limits, content type checks |
| 5 | Hardcoded committer identity | **Medium** | Derive from authenticated GitHub user |
| 6 | No error handling | **Medium** | Typed error domain with user-safe messages |
| 7 | No rate-limit handling | **Low** | Map GitHub 429 to recoverable UI state |
| 8 | No session management | **High** | Server-side session with SQLite storage, encrypted credentials |

## Migration Recommendations

1. **Delete** `updatePost.js` and `addImage.js` immediately (obsolete, Node-specific, wrong repo).
2. **Rewrite** `getPostTitles.js`, `newPost.js`, `buildFrontMatter.js` as server-side services in `src/server/content/`.
3. **Rewrite** `App.jsx` as the new connected-state shell in `src/web/App.tsx`.
4. **Keep** `main.jsx` (renamed to `src/web/main.tsx`), `Post.jsx` (updated), CSS files (updated).
5. **Fix** `package.json`; add `tsconfig.json`, `vitest.config.ts`.
6. **Add** `vite.config.ts` proxy for `/api` in development.
7. **Add** `src/shared/` with types, validation, and error domain.
8. **Add** `.github/workflows/ci.yml` for lint/typecheck/build/test.
9. **Do NOT** write to the SecondBrain repository in any automated test.

---

## Initial Build Behavior (task 1.3)

> Recorded 2026-11-01 on branch `feat/gitdatnote-2`. Goal: establish and document how the
> original application builds, including failures, dependency problems, and environment limits.
> No source code was modified.

### Environment
| Item | Value |
|---|---|
| OS / arch | Linux x64 (7.2.8-9-omarchy) |
| Node.js | **v26.7.0** (npm **11.19.0**) — **newer than the target Node 24 LTS** and newer than the bogus `node@^21.1.0` dep |
| Lockfile | `package-lock.json` present (lockstep install) |
| `node_modules` | absent before install |

### Command: `npm install` — result **exit 0 (success)**
- **1402 packages** added, 1403 audited (~11s).
- `npm warn deprecated` for eslint@8.57.1 and several babel/rollup/transitive packages.
- **78 vulnerabilities** reported (19 low, 21 moderate, 34 high, 4 critical) — consistent with the audit's finding that the dependency set is obsolete.
- **4 install scripts were skipped** because npm 11 does not cover them under `allowScripts`:
  - `core-js@3.39.0` and `core-js-pure@3.39.0` (`postinstall`)
  - `esbuild@0.18.20` (`postinstall: node install.js`)
  - `node@21.7.3` (`preinstall: node installArchSpecificPackage`)
- **The bogus `node` dependency installed successfully**: `node_modules/node` is present at version `21.7.3`. It is the Node runtime published to npm as a shell package — it is **not** a usable application dependency and should be removed (task 2.1). Its install script was among the skipped scripts, so no native Node binary was wired in; this has no effect on the Vite build (the real runtime is the host Node).
- **`react-scripts` installed** (unused CRA dependency) and adds to the footprint.
- The skipped `esbuild` postinstall was **not** a blocker in this environment: the platform binary `node_modules/@esbuild/linux-x64` is present and `node_modules/.bin/esbuild` resolves, so Vite's bundler worked. *(In environments where the esbuild binary is unavailable, the skipped postinstall would surface as a build failure.)*

### Command: `npm run build` — result **exit 0 (success)**
- Build script is **`vite build`** (package name still reads `11tycms`).
- Output:
  ```
  vite v4.5.5 building for production...
  ✓ 113 modules transformed.
  dist/index.html                   0.45 kB │ gzip:  0.30 kB
  dist/assets/index-97468755.css    2.18 kB │ gzip:  1.00 kB
  dist/assets/index-d3ec8392.js   335.02 kB │ gzip: 94.64 kB
  ✓ built in 561ms
  ```
- `dist/` produced: `index.html`, `vite.svg`, `assets/index-*.js`, `assets/index-*.css`.

### Why the build succeeds despite known source bugs
- The top-level-`await` bugs in `src/components/updatePost.js` and `src/components/addImage.js` are **not reachable from the bundle**: no other module imports either file (`grep` for `updatePost|addImage` across `src/` returns no importers). Vite tree-shakes/unreached modules are never evaluated, so their module-scope `await` never executes. The bundle therefore builds cleanly even though those files are broken.
- The `setHTML()` bug in `src/App.jsx` is a **runtime** (render-time) error, not a build-time one — it does not affect `vite build`.

### Conclusion
- **The original application builds successfully** (`npm install` and `npm run build` both exit 0) in this environment, producing a `dist/` bundle.
- **Environment limitation / caveat:** the build was verified on **Node v26.7.0**, which is newer than the project's target **Node 24 LTS** and newer than the stray `node@^21` dep. The build is not guaranteed reproducible on exactly 24 LTS until re-verified there; the obsolete dependency set (78 vulnerabilities, deprecated tooling) remains a risk.
- **Dependency problems (for task 2.1):** remove `node` and `react-scripts`, de-duplicate `dotenv`, and declare any missing import (`node-base64-img`) — though `addImage.js` is slated for deletion, making that import moot.
- **No source code was modified** to achieve this result; the build ran against the unmodified starting commit.

---

## Legacy Characterization Tests — Task 1.4

> Recorded 2026-11-01 on branch `feat/gitdatnote-2`. Goal: write characterization tests
> for reusable behavior in the original application, without refactoring. Tests live in
> `tests/characterization/legacy-behavior.test.js` (run via `npm run test`, Vitest 2.1.9).
> **Result: 25 tests, all passing.** No application source code was modified.

### Testing infrastructure added
- **Vitest 2.1.9** + **happy-dom 15.11.7** as devDependencies (chosen for compatibility with the
  locked Vite 4.5.5 — Vitest 2.x supports Vite 4/5; a nested Vite 5.4.21 ships inside
  `vite-node`/`vitest` and does not affect the app build).
- `vitest.config.js`: include only `tests/characterization/**/*.test.js`, node environment.
- `package.json`: `"test": "vitest run"` script. No other scripts or dependencies touched.

**Lockfile review (lesson from task 1.3 applied):** `npm install` again attempted a spurious
`typescript` downgrade (5.7.2 → 4.9.5). It was corrected with an explicit
`npm install -D typescript@5.7.2`. Final lockfile delta vs. HEAD:
- **0 packages removed; 112 added** (the Vitest/happy-dom trees only).
- **Only 2 existing package versions changed**, both expected transitive upgrades pulled in by
  Vitest's Vite-5 toolchain: `@jridgewell/sourcemap-codec` 1.5.0→1.6.0 and
  `@types/estree` 1.0.6→1.0.10.
- `typescript` preserved at 5.7.2. No other version drift.
- Build re-verified after the dependency change: `npm run build` exit 0, identical output
  (113 modules, same asset hashes).

### A. Front matter generation — `src/components/buildFrontMatter.js` → `buildFrontMatter(title)`
**Legacy behavior characterized (7 tests, all passing):**
- Exact output for an ordinary title: `---\ntitle: <title>\ndate: <new Date().toISOString()>\n---\n`.
- Emits **only** `title` and `date` — no description, no tags.
- Date is full ISO 8601 with time and `Z` (e.g. `2024-12-01T12:00:00.000Z`), not `YYYY-MM-DD`.
- Date fixed in tests by spying on `Date.prototype.toISOString` (the exact method the legacy
  code calls). **Test-infrastructure finding:** `vi.spyOn(Date, "now")` does **not** affect
  `new Date()` in the test environment, and `vi.unspyAll` does not exist in Vitest 2.1.9
  (use `mockRestore()` on the spy).
- **Characterized defects (documented, not fixed):**
  - Titles containing `:` (e.g. `A: B`) are emitted **unquoted** → malformed YAML value.
  - Titles starting with special characters (`*star*`) are unquoted.
  - Titles containing newlines produce a multi-line, unquoted value that corrupts the front matter.

### B. Slug generation — `slugify` (v1.6.6) as used in `src/components/newPost.js`
Legacy usage: `postURL = slugify(postTitle)` then PUT to `path: ${postURL}.md`.
**Characterized behavior (8 tests, all passing) — verified empirically:**
- **Case is preserved** (no `lower: true` in legacy call): `"Hello World"` → `"Hello-World"`.
- Whitespace runs collapse to a single `-`.
- **Apostrophes are kept**: `"What's New?"` → `"What's-New"` (apostrophes end up in filenames).
- **Some punctuation survives into slugs/filenames**: `"!!!"` → `"!!!"`, `"*star*"` → `"*star*"`,
  `"A: B"` → `"A:-B"` — `*`, `!`, `:` are invalid characters in Windows filenames. Trailing
  `.`/`!` also kept (`"Hello."` → `"Hello."`).
- Trailing `?` is stripped; leading `--` is stripped.
- **Unicode:** accented characters are transliterated to ASCII base (`"café"` → `"cafe"`,
  `"résumé"` → `"resume"`); CJK characters are **stripped entirely** (no transliteration):
  `"日本語"` → `""`.
- **Collision risks identified:** distinct titles map to identical slugs (`"My Post"` =
  `"My-Post"`; `"My Post."` = `"My-Post."`; `"Café"` = `"Cafe"`; `"日本語"` = `"???"` = `""`).
  The legacy caller (`newPost.js`) PUTs directly to `<slug>.md` with **no existence check** —
  a second post with the same slug silently overwrites the first. Documented only; no
  replacement slug function implemented (out of scope per task).

### C. Directory listing → post selection — `src/components/getPostTitles.js`
Tested with a **hoisted `octokit` module mock** (no real GitHub API requests).
**Characterized behavior (6 tests, all passing):**
- Calls the hardcoded endpoint `GET /repos/{owner}/{repo}/contents/Journal/2024/December/`
  with hardcoded `owner: "kevinctofel"`, `repo: "SecondBrain"`.
- Maps directory entries whose `name` ends in `.md` to `{ title: name-without-.md, url: html_url, sha }`, preserving order.
- Filters out non-`.md` entries (`.txt`, extension-less).
- Empty directory → empty post list.
- **Characterized defect:** entry `type` is ignored — a **directory** named `*.md` is treated as a post.
- **Characterized limitation (not testable without refactoring):** the per-file helper
  `postInfo` (single-file GET) is **dead code** — defined but never invoked; its behavior
  cannot be characterized without substantial refactoring.
- **Mocking finding (test-infrastructure pitfall):** `vi.restoreAllMocks()` in `afterEach`
  also restores a `vi.mock`ed module's implementation, silently breaking subsequent module
  mocks in the same file. Use `mockReset()` on the hoisted fn instead.

### D. SHA-based conflict detection — **no functional conflict detection on the live path**
**Finding (documented; no new functionality created):**
- The live update path is `src/components/newPost.js` (called from `App.jsx`): a plain
  `PUT /repos/{owner}/{repo}/contents/{path}` containing owner/repo/path/message/committer/
  content/headers — **no `sha` field**. It silently overwrites existing files.
- The only SHA-based update in the codebase is `src/components/updatePost.js`, which
  reads a file then PUTs with `sha: data.data.sha`. However, it performs a **top-level
  `await` at module scope** (executes on import, not on call) and hardcodes a *different*
  repository (`MyConsciousStream`) and path — it is not part of any callable, testable
  update flow. Executing the module to characterize it would hit the real GitHub API.
- **Conclusion:** SHA-based conflict detection is effectively **absent** from the original
  application's user-facing behavior.
- **Cannot be characterized without refactoring:** the logic is entangled in module-scope
  async code with hardcoded endpoints; it must first be extracted into a callable,
  dependency-injected function.
- **Appropriate future home:** the `repository-content` spec requirements "Create without
  overwriting" (409 `FILE_EXISTS`) and "Update with expected SHA" (409 `SHA_CONFLICT`), to be
  implemented in **tasks 4.3 (POST) and 4.4 (PUT)** of this change.

### Defects / limitations summary
| # | Area | Finding |
|---|---|---|
| 1 | A | `buildFrontMatter` emits unquoted YAML — titles with `:`, leading specials, or newlines produce corrupt front matter |
| 2 | A | No `description`/`tags` fields (incomplete vs. modern post requirements) |
| 3 | B | slugify keeps `*`, `!`, `:`, `'` in slugs → invalid filenames on Windows; case preserved (inconsistent with typical slug expectations) |
| 4 | B | No collision handling in caller; same-slug posts silently overwrite each other |
| 5 | B | CJK titles slug to `""` (empty filename body) |
| 6 | C | `post.type` ignored — directories named `*.md` are listed as posts |
| 7 | C | `postInfo` is dead code; not characterizable without refactoring |
| 8 | C | Hardcoded owner/repo/path in `getPostTitles` — not parameterized |
| 9 | D | No `sha` on the live PUT path — no conflict detection |
| 10 | D | `updatePost.js` SHA pattern exists but is unreachable (module-scope await, wrong repo) |

### Uncharacterized behavior (and why)
- **`getPostTitles` error handling** (HTTP 404 for a missing journal directory, network failure):
  the function has no try/catch; a rejected `request` promise would propagate as an unhandled
  rejection. Not exercised by tests because it is not isolable without a failing-mock scenario
  that would require asserting on unhandled-rejection behavior — deferred to the integration
  work in Section 5 of this change.
- **`updatePost.js`** executable behavior: module-scope `await` + hardcoded real-repo request
  on import; executing it in a test would contact the real GitHub API. Requires refactoring
  before it can be characterized.
- **`App.jsx` render flow** (the `setHTML()` call): a React runtime concern requiring a full
  component mount; out of scope for these module-level characterization tests.

---

## Obsolescence Removal — Task 1.5

> Recorded 2026-11-01 on branch `feat/gitdatnote-2`. Goal: remove obsolete, unreferenced
> legacy code. **Files removed: `src/components/updatePost.js` (861 B), `src/components/addImage.js` (1,030 B).**

### Why each file is obsolete
- **`updatePost.js`:** A module-scope script (not a callable function) — it performs a
  top-level `await` GET + PUT against a **hardcoded, different repository**
  (`MyConsciousStream`, path `content/blog/testpost.md`), hardcodes a personal name/email
  (`Kevin C. Tofel` / `kevin@kctofel.com`), and uses the `GITHUB_AUTH_KEY` env var which is
  **not used by any other module** in the app. It is imported by nothing.
- **`addImage.js`:** Same pattern — module-scope top-level `await` PUT of a base64-encoded
  image (`./images/IMG_0076.jpeg` → `public/img/test1.jpg`) to the same hardcoded
  `MyConsciousStream` repo, same hardcoded identity and `GITHUB_AUTH_KEY`. It also imports
  **`node-base64-img`, which is not declared in `package.json`** — a latent missing-dep
  bug that disappears with the file.

### Reference scan (no active imports remain)
- `grep -rn -E "updatePost|addImage" src/ index.html vite.config.js` → **0 matches.**
- Project-wide scan (excluding `node_modules`, `dist`, `.git`, `openspec`, `docs`) → the only
  remaining mentions are two **historical comment references** inside
  `tests/characterization/legacy-behavior.test.js` (the task 1.4 finding D notes), which are
  explicitly allowed per the task instructions and are not code references.

### Verification (no regressions)
| Check | Result |
|---|---|
| `npm run test` | **25/25 passing** (exit 0) |
| `npm run build` | **exit 0** — identical 113-module output, same asset hashes (`index-97468755.css`, `index-d3ec8392.js`) |
| `openspec validate modernize-gitdatnote-foundation` | **exit 0** — "Change ... is valid" (same 2 pre-existing non-blocking length warnings) |
| `git diff --check` | **exit 0** (clean) |
| `git status --short` | exactly two deletions: `D src/components/addImage.js`, `D src/components/updatePost.js` |

### Notes
- No dependencies were removed or upgraded (per instruction); the undeclared `node-base64-img`
  import is simply gone with its file — it is not a declared dependency in `package.json`, so
  there was nothing to remove there.
- No other application source files were changed; no replacement editing/image-upload
  functionality was implemented (future home: repository-content service, tasks 4.x).
- `git status` confirms only the two intended deletions are staged-for-commit (uncommitted).

---

## Dependency Modernization — Task 2.1

> Recorded 2026-11-01 on branch `feat/gitdatnote-2` (starting commit `9f51ba9`). Goal: clean up
> and modernize project dependencies, package metadata, and npm scripts.

### `package.json` changes
| Change | Detail |
|---|---|
| Name | `11tycms` → **`gitdatnote`** |
| `engines` | added: `"node": ">=24"` (Node.js 24 LTS minimum, per design) |
| Removed deps | **`node` ^21.1.0** (runtime, not a package), **`react-scripts` ^5.0.1** (CRA; app is Vite), **`react-error-overlay` ^6.0.9** (CRA dev overlay) and its `resolutions` pin, **duplicate `dotenv`** in `devDependencies` (kept single copy in `dependencies`) |
| Added deps (runtime) | **`better-sqlite3` ^13.0.3** (session DB; native module, prebuilt binaries), **`dompurify` ^3.4.17** (Markdown preview sanitization), **`zod` ^4.6.7** (request validation) |
| Added deps (dev) | **`@playwright/test` ^1.64.1** (e2e), **`tsx` ^4.23.15** (server dev execution), **`@types/node` ^24.0.0** (resolves 24.19.2 — pinned to the Node 24 floor, not latest 26.x, to match `engines`) |
| Already present (task 1.4) | `typescript` ^5.7.2, `vitest` ^2.1.9 — kept at their versions; no other versions changed |

Version selection: latest stable on npm at implementation time. Engine floors verified:
`@playwright/test` ≥20, `better-sqlite3` ≥22, `tsx` ≥18 — all satisfied by the `>=24` floor.
**Node 26 compatibility** verified in-place: running environment is Node v26.7.0; install, build,
all 25 tests, and a live `better-sqlite3` native-module load (`SELECT 1` on an in-memory DB) all
succeed on Node 26.

### `package-lock.json` (intentional regeneration via `npm install`)
- **1536 → 507 packages (net −1029).** Removed **1,064** — the entire react-scripts/babel/webpack/CRA tree, the bogus `node` package, and `react-error-overlay`.
- Added **35** — `@playwright/test` + `playwright` + `playwright-core`; `better-sqlite3` + `node-addon-api`; `dompurify`; `zod`; `tsx` + its private `esbuild` 0.28.2 tree; `@types/node`.
- **Version changes: 2**, both expected from adding `@types/node`: `@types/node` 22.10.2 → 24.19.2 and its transitive `undici-types` 6.20.0 → 7.24.6.
- **Zero unrelated upgrades**: every previously locked package kept its exact version (react 18.3.1, vite 4.5.5, vitest 2.1.9, typescript 5.7.2, eslint 8.57.1, marked 11.2.0, octokit 3.2.1, slugify 1.6.6, dotenv 16.4.7, happy-dom 15.11.7, etc.).
- `npm ls --depth=0` → clean tree, exit 0 (no missing/invalid/peer conflicts).

### npm scripts
Established and verified (real checks, all exercised):
| Script | Command | Status |
|---|---|---|
| `dev` | `vite` | existing, kept |
| `build` | `vite build` | verified exit 0 |
| `lint` | `eslint . --ext js,jsx --report-unused-disable-directives --max-warnings 0` | script kept, but currently **broken by pre-existing config defect** (see below) |
| `test` | `vitest run` | verified 25/25 |
| `preview` | `vite preview` | existing, kept |

**Deferred (documented, no placeholder scripts created)** — each depends on files from later tasks:
| Script | Blocked by | Reason |
|---|---|---|
| `typecheck` | task 2.2 | needs `tsconfig.json`/`tsconfig.web.json`/`tsconfig.server.json` (created in 2.2) |
| `test:e2e` | task 2.7 (+ Playwright browsers) | needs `playwright.config.ts` and e2e specs; browsers installed via `npx playwright install` |
| `test:integration` | tasks 5.x | needs the integration test suite and mocked GitHub fixtures |

### Security findings (`npm audit`, not fixed in this task)
**25 vulnerabilities (1 low, 10 moderate, 11 high, 3 critical).** Placement:
- **Runtime-reachable** (via `octokit` 3.2.1, used by current and planned server code):
  `@octokit/endpoint`, `@octokit/plugin-paginate-rest`, `@octokit/request`, `@octokit/request-error`
  (4× moderate ReDoS) and **`jws` 3.2.2 (high, improper HMAC verification)** via
  `@octokit/app → @octokit/auth-app → universal-github-app-jwt → jsonwebtoken`.
- **Dev-only** (test/build tooling): eslint tree (`ajv`, `js-yaml`, `flatted`, `brace-expansion`,
  `minimatch`), vite/vitest tree (`esbuild`, `postcss`, `nanoid`, `rollup` 3.x), and the 3 criticals:
  **`happy-dom` 15.11.7 (VM-context-escape RCE)**, **`tinypool` (vitest 2.1.9)** and **`esbuild`
  dev-server (via vite 4.5.5 / vite 5.4.21)** — criticals all require **breaking** majors
  (`happy-dom` 21.0.4, `vitest` 5.0.5).
- Per instruction, **`npm audit fix --force` was not run**, and the broad non-breaking
  `npm audit fix` was **deferred** to avoid unrelated transitive upgrades (instruction 8).
  Recommendation: a dedicated security/upgrade pass (e.g., during/after the 2.x foundation)
  targeting: `octokit` tree (runtime), then `vitest` 5 + `happy-dom` 21 majors, then the eslint/vite
  transitive set.

### Pre-existing issues found (not fixed in this task)
- **`npm run lint` fails (exit 2, config error, not code errors):** `.eslintrc.cjs` contains an
  invalid top-level property `node: true` (legacy CRA-template remnant; correct form is
  `env: { node: true }`). Task 2.9 rewrites the ESLint config for TypeScript and will fix this.
- **Playwright browsers not installed** — package install only downloads the driver; browser
  binaries are a 2.7 concern (`npx playwright install`, `playwright.config.ts`).

### Task 2.1 status
**Left unchecked** — all `package.json` acceptance criteria (name, removals, additions, `engines`,
working `dev`/`build`/`lint`/`test` scripts) are met, but the **essential script requirements**
`typecheck`, `test:e2e`, and `test:integration` cannot perform real checks without files created in
tasks 2.2, 2.7, and 5.x respectively. Per the assignment, 2.1 is updated only when its acceptance
criteria are fully met; the dependency is reported here.

## TypeScript, Vite, and Vitest Configuration — Task 2.2 (2026-11-01)

**Scope:** configuration only. No application source files migrated; `src/web`, `src/server`, and `src/shared` contain no files yet (tasks 2.3/2.4).

**Files created:** `tsconfig.json`, `tsconfig.web.json`, `tsconfig.server.json`, `vite.config.ts`, `vitest.config.ts`. **Removed:** `vite.config.js`, `vitest.config.js`. **Modified:** `package.json` (`typecheck` script), `.gitignore` (`dist-server`).

**Configuration choices (documented deviations/notes vs. design.md A-03/A-08):**

1. **Each domain config carries its root tooling config** so that `tsc --noEmit` has genuine inputs today, before any `src/` TypeScript exists: `vite.config.ts` is checked under `tsconfig.web.json` (the web build's own config), `vitest.config.ts` under `tsconfig.server.json` (node-side tooling). Alternative rejected: adding a fourth `tsconfig.node.json` (deviates from the A-03 file tree) or leaving configs empty (`TS18003 No inputs found`); rejected: including the legacy `src/*.jsx` with `allowJs` (would pull unmigrated code into the typecheck gate).
2. **Base `tsconfig.json` is extend-only** (`"files": []`); it is never run directly. The design's `typecheck` command (`tsc --noEmit` against web + server) is implemented verbatim as two `-p` invocations in the npm script.
3. **Server config:** `module: NodeNext`, `moduleResolution: NodeNext`, `lib: ES2022`, `types: ["node"]` — matches Node.js 24 LTS (`engines: ">=24"`) and the `tsx` dev runner; `outDir: dist-server` is in place for the future production compile (task 2.4+). The base `noEmit: true` is inherited, so the production compile will need an explicit override or a dedicated build config when task 2.4 lands; `rootDir` is deliberately not set while `vitest.config.ts` sits at the project root.
4. **Web config:** `lib: ES2022 + DOM`, `jsx: react-jsx`, `types: ["vite/client", "node"]`. Vite (esbuild) still owns JSX transformation and bundling; `tsc` only type-checks. Legacy `src/*.jsx` is not in any include set (no migration, per task scope).
5. **Strictness:** `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`, `isolatedModules` (required for esbuild/Vite compatibility), `skipLibCheck` (speed; library types not our concern).

**Verification (2026-11-01):** `npm run typecheck` exit 0 (both projects; `--listFilesOnly` confirms the two tooling configs are the only inputs today); `npm run test` 25/25 pass under `vitest.config.ts`; `npm run build` exit 0, output assets unchanged (`dist/index.html`, one CSS, one JS bundle, same sizes as task 1.5); `git diff --check` clean.

**Legacy compatibility:** none introduced. The legacy app continues to run through Vite/esbuild exactly as before; typechecking does not touch it until task 2.5 migrates sources.

**Not done (out of scope):** ESLint TypeScript config (task 2.9 — `npm run lint` still fails on the pre-existing invalid `.eslintrc.cjs`); first `src/shared`/`src/server`/`src/web` modules (tasks 2.3/2.4/2.5); Playwright (task 2.7); CI (task 2.8).

## ESLint Configuration — Task 2.9 (2026-11-02)

**Scope:** working lint for existing JavaScript/JSX and new TypeScript/TSX, fixing the pre-existing `.eslintrc.cjs` defect.

**Dependency change:** added `@typescript-eslint/parser` and `@typescript-eslint/eslint-plugin` (both resolve to 8.72.1) as devDependencies. ESLint stays at 8.57.1 — v8 of the plugin line is the ESLint-8-compatible line (v9+ requires ESLint 9). No other dependency touched; lockfile delta is only the two new trees.

**Configuration decisions (`.eslintrc.cjs`):**
1. **Fix:** invalid top-level `node: true` moved into `env: { browser: true, es2020: true, node: true }` (legacy CRA-template remnant; also covers server/tooling files and test globals).
2. **TS override:** `files: ['*.ts', '*.tsx']` → `parser: @typescript-eslint/parser`, `extends: ['plugin:@typescript-eslint/recommended']`. Covers `vite.config.ts`, `vitest.config.ts` today and every `src/web`, `src/server`, `src/shared` file from tasks 2.3 onward. JSX/TSX handled by the same override (parser is JSX-aware) plus the inherited `react/jsx-runtime` + `react-hooks` settings.
3. **ignorePatterns:** `dist`, `dist-server`, `node_modules`, `.eslintrc.cjs` (generated artifacts + dependencies explicitly excluded per task requirement).
4. **Lint script:** `eslint . --ext js,jsx --report-unused-disable-directives --max-warnings 0` → `eslint . --ext js,jsx,ts,tsx --report-unused-disable-directives --max-warnings 0`. The extension list makes the script a real gate over TS files instead of silently skipping them (script names unchanged per the no-placeholder principle).
5. **No broad rule-category disables.** Legacy-code handling was source fixes plus one narrow per-file override (below).

**Legacy source fixes (behavior-neutral, documented):**
- `src/App.jsx`: removed unused `useEffect` import (its only usage is commented out) and the unused `index` parameter of `populateTextArea` (call site passes no argument).
- `src/components/Post.jsx`: removed unused `url` prop from destructuring (component renders only `title`).
- `src/components/getPostTitles.js`: removed dead `postInfo` async function (assigned, never called — defect #7 in the task 1.4 table).
- `src/components/newPost.js`: removed unused `import App from "../App.jsx"` (unused; its removal also eliminates the App→newPost→App circular import).
- **Override:** `files: ['src/components/Post.jsx']` → `react/prop-types: off`. Rationale: the standard fix requires adding the deprecated `prop-types` package for a 7-line legacy component that task 2.5 replaces with a typed TSX component; not worth the dependency. One file, one rule, justified — not a broad disable.

**Verification (2026-11-02):** `npm run lint` exit 0 (0 errors, 0 warnings under `--max-warnings 0`; `vite.config.ts`/`vitest.config.ts` confirmed in scope via a direct lint run); `npm run typecheck` exit 0; `npm run test` 25/25 pass; `npm run build` exit 0 (unchanged asset hashes); `openspec validate` exit 0; `git diff --check` clean.

**Not done (out of scope):** npm-audit remediation (task 2.10); `test:e2e` (task 2.7); CI lint/typecheck matrix (task 2.8).

---

## Shared Domain Modules — Task 2.3 (2026-11-02)

Five modules created in `src/shared/`, all strict TypeScript, pure, and platform-independent (no fs/DOM/Node APIs, no network, no database, no imports from `src/web`/`src/server`, no new dependencies, no framework/DI layer):

| File | Lines | Exports |
|---|---|---|
| `types.ts` | 105 | `Repository`, `FileContent`, `DirectoryListing`, `ErrorDomain` (11 codes), `ErrorStatus`, `ErrorDetail`, `ErrorResponse`, `RepositoryPath`, `RelativePath` |
| `validate.ts` | 133 | `MAX_MARKDOWN_BYTES` (1 MiB), `utf8ByteLength`, `PathKind`, `PathValidationResult`, `ContentValidationResult`, `validateContentPath`, `validateMarkdownContent` |
| `errors.ts` | 141 | `ERROR_CODES`, `GitHubErrorContext`, `mapGithubHttpError`, `mapGithubNetworkError`, `defaultDetail`, `toErrorResponse` |
| `frontMatter.ts` | 108 | `FrontMatterMeta`, `buildFrontMatter` |
| `slug.ts` | 48 | `SLUG_FALLBACK`, `generateSlug` |

**Key implementation choices:**

1. **Path validation (`validateContentPath`).** Lexical canonicalization: split on `/`, drop `.` and empty segments, collapse `..` against preceding segments; a `..` with nothing to collapse against rejects with `PATH_INVALID` (never clamps or silently rewrites the destination). Rejected: backslashes, null bytes, any C0 control character, leading `/`, and empty paths for file operations. An empty path (or one canonicalizing to empty, e.g. `.`) is allowed only for `kind: 'directory'` (listing the content root). Result carries both a `relativePath` (content-root-relative) and a `repositoryPath` (content root joined with `/`), keeping the spec's two path kinds distinct. The trusted server-configured content root is still defensively checked for `..` escapes and control characters.
2. **UTF-8 handling.** `utf8ByteLength` uses `TextEncoder` — a Web platform global available in both browsers and Node — avoiding Node's `Buffer` to keep the module platform-independent. Content limit is 1 MiB measured in UTF-8 bytes (a 1,048,576-byte string of 3-byte characters correctly exceeds the limit where code-unit length would not).
3. **Error mapping.** `ERROR_CODES` centralizes status + retryability per code. `mapGithubHttpError(status, context?)` handles the documented ambiguous cases conservatively: 403 → `REPO_NOT_ALLOWED` by default, `RATE_LIMITED` (retryable) when the caller reports a rate-limit header/context; 422 → `PATH_INVALID` by default, `CONTENT_TOO_LARGE` when the validation context identifies a size failure; 429 consumes a `Retry-Seconds` hint into the message; 500/502/503 → `GITHUB_UNAVAILABLE`; unknown statuses → `INTERNAL_ERROR` rather than guessing. `mapGithubNetworkError()` (fetch failure/timeout) → `GITHUB_UNAVAILABLE`, retryable. All client-facing messages are fixed strings from a table — no stack traces, tokens, request contents, or repository identifiers. `toErrorResponse` produces the standard `{ error: ErrorDetail }` envelope.
4. **Front matter (`buildFrontMatter`).** Field order `title`, `description`, `date`, `tags`. Titles/descriptions are always double-quoted with escaping of `\`, `"`, and CR/LF/TAB — safe for colons, quotes, newlines, and leading YAML specials. The date is emitted unquoted (matching the legacy wire format) after validating it is an ISO 8601 date/date-time string, so it can never produce a YAML parse ambiguity. Empty/absent `description` and `tags` are omitted (not emitted as empty values). Invalid inputs (blank title, non-ISO date, empty tag) throw rather than silently altering content. Unicode is preserved exactly. A minimal built-in serializer is sufficient for this fixed 4-field set, so no YAML library dependency was added; parsing front matter is not a task 2.3 requirement and is intentionally omitted.
5. **Slug (`generateSlug`).** NFKD normalize → strip combining marks (`\p{M}`) → lowercase → replace every run of `[^a-z0-9]+` with one hyphen → trim hyphens → `untitled` fallback. Deterministic; fixes the characterized legacy `slugify` defects (case preservation, apostrophes, `*`/`!`/`:` surviving into filenames). Non-Latin scripts (CJK, etc.) are dropped without transliteration — same observable behavior as legacy `slugify` for CJK; a title of only such characters yields `untitled`. The `slugify` dependency is retained per the design for the legacy app (A-08). Uniqueness/collision detection is out of scope (article-creation workflow).
6. **Module resolution.** Relative imports between shared modules use explicit `.js` extensions so the same files typecheck under `NodeNext` (server project) and `bundler` (web project) resolution without `allowImportingTsExtensions`.

**Verification (2026-11-02):** `npm run lint` exit 0 (ESLint 8.57.1 + @typescript-eslint 8.72.1; `src/shared` confirmed in scope via a direct lint run); `npm run typecheck` exit 0 (`tsconfig.web.json` and `tsconfig.server.json` both include `src/shared`); `npm run test` 25/25 legacy characterization tests pass (unchanged); `npm run build` exit 0 (unchanged asset hashes); `openspec validate modernize-gitdatnote-foundation` valid; `git diff --check` clean. Runtime behavior of every export additionally exercised with a throwaway `tsx` probe (~65 assertions: traversal/rejection cases, empty-root listing, UTF-8 boundary, front-matter escaping and omission rules, all status mappings) — probe deleted after use. No vitest include-set changes: the dedicated unit-test matrix belongs to task 2.6.

**Deviations/limitations:** none against the approved design. Notes for later tasks: (a) task 2.4 should wire `mapGithubHttpError`/`mapGithubNetworkError` with the real Octokit error objects (`context.rateLimited` from `x-ratelimit-remaining: 0`/secondary-rate headers, `context.validation === 'size'` from the 422 body); (b) task 2.6 should cover the exact probe cases listed above plus CJK-only and mixed-script slug inputs.

**Not done (out of scope):** unit tests (task 2.6); HTTP server and API endpoints (task 2.4); React shell (task 2.5); image upload (not assigned in this phase).

## Task 2.3 Code Review Corrections (2026-11-02)

Independent review of commit `ed0516c` on `feat/gitdatnote-2` identified five issues in the shared modules. All five were corrected in a narrowly scoped pass (no task 2.4/2.5/2.6 work, no backend conflict handling, no new dependencies).

**1. Content-root validation (`src/shared/validate.ts`).** The review required the configured content root itself to obey the same safety rules as user paths. `validateContentPath` now rejects content roots that are absolute, contain backslashes, contain control characters, or whose lexical canonicalization escapes the repository root. This is defense in depth: given a valid root and a valid relative path, the joined repository path can never be outside the configured content root — no lexical step in the function can leave it. Nested roots (`Journal/2024/December`) continue to work; internally resolvable `..` segments in user paths remain allowed (approved lexical canonicalization preserved, per the review's instruction).

**2. YAML serialization (`src/shared/frontMatter.ts`).** The prior serializer escaped `\`, `"`, and CR/LF/TAB but could pass other YAML-sensitive control characters (e.g. NUL, vertical tab, ESC, DEL) into the output. Minimal correction: `buildFrontMatter` now rejects C0 control characters other than tab/LF/CR (which the serializer already escapes) and DEL in `title`, `description`, and `tags` before emitting. The minimal built-in serializer was kept — no YAML dependency added (justified: the fixed 4-field set has no other escape surface).

**3. Date validation (`src/shared/frontMatter.ts`).** The prior check was a shape-only regex and accepted impossible dates (`2023-02-29`, `2026-11-32`) and out-of-range time components (`T24:00:00`). `isIsoDate` now verifies calendar validity (per-month day counts, leap years) and component ranges (hour ≤ 23, minute/second ≤ 59, offset hour ≤ 23, offset minute ≤ 59). The accepted formats are unchanged — plain dates and date-times with optional fractional seconds and `Z`/`±HH:mm` offsets — and accepted strings are never normalized or rewritten. The calendar math is hand-rolled (constant table + leap-year rule); no `Date` object is involved, so behavior is identical in browser and Node.

**4. Repository permission contract (`src/shared/types.ts`, `design.md`).** Design A-01 and the `github-connection` spec require both `canRead` and `canWrite`, but the `Repository` type and the design's `GET /api/repositories` example showed only `canWrite`. Smallest coordinated change: `Repository` gains an explicit `canRead: boolean`, and the design API example now shows both fields. No other specification text required changes (both specs already state both capabilities).

**5. SHA conflict response (`src/shared/types.ts`, `src/shared/errors.ts`, `design.md`).** The `repository-content` spec requires the current blob SHA in a `409 SHA_CONFLICT` response, which the standard `ErrorResponse` shape cannot express. Minimal type-safe shape: `ShaConflictErrorDetail extends ErrorDetail` with `code: 'SHA_CONFLICT'` and `currentSha: string`, wrapped by `ShaConflictErrorResponse`. Constructors `shaConflictDetail(currentSha)` and `toShaConflictResponse(currentSha)` added to `errors.ts`. `design.md` documents the `currentSha` field in the Error Response Format section, the `PUT .../content` 409 line, and the `SHA_CONFLICT` row of the error-codes table. No backend conflict handling is implemented (later task).

**Regression checks:** `tests/characterization/shared-modules-corrections.test.js` (17 tests) — malformed content roots (absolute, backslash, `..` escape, control char), root-escape invariant for user paths, nested-root and canonicalization preservation, YAML control characters (C0/DEL rejected, tab/LF/CR still escaped), invalid calendar dates and out-of-range time/offset components, accepted date strings unchanged, and the conflict response shape. This is the scoped correction set, not the task 2.6 matrix.

**Verification (2026-11-02, post-correction):** `npm run lint` exit 0; `npm run typecheck` exit 0 (both tsconfigs); `npm run test` 25 legacy + 17 correction tests passing; `npm run build` exit 0; `openspec validate modernize-gitdatnote-foundation` valid; `git diff --check` clean. Behavior of every corrected case additionally verified with a `tsx` probe before writing the tests (probe deleted after use).

**Unresolved issues:** none. Task 2.3 remains complete — all original acceptance criteria still hold and the corrections only tighten validation and align the API contract. Corrections are on disk, uncommitted (the user will review and commit them separately).

## Shared Module Unit Testing — Task 2.6 (2026-11-02)

Comprehensive unit tests for the five shared modules (`ed0516c` + review corrections `e79ebd2`). New dedicated suites under `tests/unit/shared/`, written in strict TypeScript against the existing Vitest tooling:

| Suite | Tests | Coverage |
|---|---|---|
| `types.test.ts` | 7 | Compile-time contract shapes (object literals checked by the compiler) plus runtime pinning of discriminators/envelope fields (`Repository` permission flags, `ShaConflictErrorDetail.currentSha`, `ErrorResponse` envelope, 11-code `ErrorDomain`) |
| `validate.test.ts` | 56 | Content-root validation (valid nested roots; absolute, backslash, control-char, root-escaping roots rejected); user paths (simple/nested valid, empty-path policy per operation kind, absolute/backslash/null-byte/C0 control/traversal rejection, internally resolvable `..` canonicalization, repeated separators and `.` segments, correct `relativePath`/`repositoryPath` results); `utf8ByteLength` (ASCII, multibyte, emoji, `€` boundary); `validateMarkdownContent` (empty, ordinary, exactly 1 MiB, one byte over, multibyte crossing the limit) |
| `errors.test.ts` | 64 | All 11 codes (status + retryable via `ERROR_CODES`); safe fixed messages (no tokens/stack traces/payloads); standard `{ error }` envelope; `mapGithubHttpError` for 401, 403 (ambiguous, with/without rate-limit context, `Retry-After` hint), 404, 409, 422 (with/without `validation` context), 429 (with/without retry hint), 5xx, unknown statuses; `mapGithubNetworkError`; `shaConflictDetail`/`toShaConflictResponse` shape. Mocked status codes and local data only — no network |
| `frontMatter.test.ts` | 80 | Exact output formatting (double quotes, escaping of `\`/`"`/CR/LF/TAB, deterministic field order, deterministic output); Unicode/emoji preservation; colons/quotes/apostrophes/backslashes; newlines/carriage returns/tabs; optional and empty descriptions; empty and populated tag arrays; YAML-sensitive punctuation; C0/DEL control-character rejection; valid date and date-time forms (incl. fractional seconds, `Z`, offsets); invalid month/day combinations; leap-year behavior (`2024-02-29` accepted, `2023-02-29` rejected); invalid time/offset components; meaning-preserving round-trips through the real `js-yaml` parser (transitive eslint dependency — no new production dependency); invalid input handling (empty/whitespace/missing/non-string title and date, empty tags) |
| `slug.test.ts` | 29 | `generateSlug`: ordinary English, leading/trailing and repeated whitespace, case normalization, accented Latin, combining diacritics, ligatures, punctuation, apostrophes, repeated hyphens, empty and punctuation-only titles, emoji, CJK-only, mixed Latin/non-Latin, determinism, output restricted to `[a-z0-9-]` with `untitled` fallback |

**New: 236 tests. Total: 278 (42 pre-existing + 236 new).** All 42 pre-existing tests preserved and passing; the 17 correction regression tests were reused, not copied.

**Configuration changes:**
- `vitest.config.ts` — `include` now `['tests/characterization/**/*.test.js', 'tests/unit/**/*.test.ts']` so `npm run test` discovers both sets.
- `tsconfig.server.json` — `include` gains `tests/unit` so the new strict-TS test files are type-checked by the `typecheck` script (server project uses `NodeNext`; `.js` import extensions required).
- ~~`tests/unit/shared/js-yaml.d.ts`~~ — a minimal `declare module 'js-yaml'` shim was created during the original pass so the transitive parser would type-check; **removed by the follow-up dependency correction** below, which replaced it with real type declarations.

**Dependency correction (2026-11-02, follow-up):** `js-yaml` had been used by the frontMatter round-trip tests only as a transitive eslint dependency. Correction: `npm install -D js-yaml@4.1.0 @types/js-yaml` — `js-yaml@^4.1.0` and `@types/js-yaml@^4.0.9` are now explicit devDependencies; the lockfile diff is 9 lines (direct `js-yaml` entry + new `@types/js-yaml` entry, deduped against eslint's copy — no version drift; `js-yaml` still resolves to 4.1.0); the `js-yaml.d.ts` shim was deleted. Test behavior unchanged (278/278, same assertions); `typescript` stayed at 5.7.2 (no npm downgrade). This is a test-infrastructure-only change — no production code touched.

**Defects discovered:** none in the shared modules. All 33 initial test failures were test-side expectation errors, corrected in place (documented here, not in regression tests since they pin no implementation behavior): (a) slug suite imported a non-existent `slugifyTitle` name (actual export: `generateSlug`); (b) a transform-breaking cast in the 422 validation-context table; (c) `€` UTF-8 byte count miscomputed in a size-boundary row (`€` is 3 bytes, so `€uro` is 6, not 5); (d) the expected-`relativePath` helper filtered `..` segments before popping them, unlike the approved lexical canonicalization (pop-then-join); (e) unknown-upstream status `999` maps to `GITHUB_UNAVAILABLE` (any `>= 500`), not `INTERNAL_ERROR`; (f) zone-less ISO date-times are parsed as UTC by `js-yaml` while V8's `Date.parse` treats them as local time — round-trip expectations now use the real parser as ground truth. No shared-module source file was modified by this task.

**Verification (2026-11-02):** `npm run lint` exit 0 (new `.ts` suites linted via the existing `--ext js,jsx,ts,tsx` gate); `npm run typecheck` exit 0 (both tsconfigs); `npm run test` 278/278 passing, 7 test files, zero skipped; `npm run build` exit 0 (unchanged asset hashes — production build unaffected); `openspec validate modernize-gitdatnote-foundation` exit 0 (2 pre-existing non-blocking length warnings); `git diff --check` clean. No real GitHub requests or repository writes (mocked error objects and local data only; `js-yaml` round-trips are in-memory).

**Limitations / not covered:** coverage instrumentation not added (not required; behavior-based reporting above). Branches not exercised: 422 `validation` values outside `'path' | 'size'` (type-level only), `retryAfterSeconds` negative/NaN edge values, and `validateContentPath` behavior for roots containing `.`-only or empty-segment-only strings (all reduce to empty root, covered by the empty-root case). `types.ts` has no runtime behavior; its suite pins shapes at compile time plus runtime discriminators.

**Not done (out of scope at that time):** task 2.5 (web), 2.7 (e2e), 2.8 (CI), 2.10 (dependency security). No commits, pushes, or archiving. (Task 2.4 was completed in the session that followed — see the section below.)

## Backend Foundation — Task 2.4

**Scope:** establish the Node/TypeScript backend foundation: standalone server entry point, `/api/health`, structured request logging, standardized error handling, server build + start scripts, real-HTTP verification.

**Files:**

| File | Change |
|---|---|
| `src/server/index.ts` | New. Standalone Node `http` server: `createApp()` factory (testable, no listening side effect when imported), `main()` entry (env `PORT` default 3000 / `HOST` default 127.0.0.1 / `LOG_LEVEL` default `info`; SIGINT/SIGTERM graceful shutdown with 5 s force-exit; `EADDRINUSE`/server-error → exit 1; direct-run guard via `import.meta.url` vs `argv[1]`). |
| `src/server/middleware/logging.ts` | New. `LogLevel`, `resolveLogLevel()` (env `LOG_LEVEL`), `createLogger()`, `logRequest()` — single-line structured JSON; request entries carry only method, pathname, status, durationMs. |
| `src/server/middleware/errorHandling.ts` | New. `sendJsonError()` (shared `toErrorResponse`), `sendApiNotFound()` (JSON 404, `FILE_NOT_FOUND`), `sendUnexpectedError()` (safe `INTERNAL_ERROR` 500; server log records error name only — no message, stack, paths, or credentials client-side or in logs). |
| `tests/unit/server/server.test.ts` | New. 9 tests over real HTTP on ephemeral ports: health exact JSON, non-GET health 404, unknown `/api/*` JSON 404, non-API plain 404, request-log fields with query-string exclusion, log suppression at `error` level, `LOG_LEVEL` env parsing, unexpected-error boundary (no leakage client- or server-side), clean shutdown. |
| `tsconfig.server-build.json` | New. Extends `tsconfig.server.json`; `noEmit: false`, `rootDir: src`, includes only `src/server` + `src/shared` (tests/tooling configs never emitted). |
| `package.json` | Modified. Scripts: `start` (`node dist-server/server/index.js`), `dev:server` (local `tsx src/server/index.ts`), `build:server` (`tsc -p tsconfig.server-build.json`). No new dependencies. |

**Framework decision:** Node built-in `http` module — the design's approved alternative to `express`; `express` is not in the approved dependency set, so no framework was added.

**Endpoints:** `GET /api/health` → `200 { "status": "ok" }` (no auth; confirms only the HTTP process responds, not future services). Unknown `/api/*` → standard JSON 404 envelope (`FILE_NOT_FOUND`). Non-`/api` → plain-text 404 (frontend territory). The shared `ShaConflictErrorResponse` contract is preserved untouched for future route integration.

**Build:** `npm run build:server` emits ESM to `dist-server/` — verified git-ignored (`git check-ignore -v` → `.gitignore` line 27) and absent from `git status`. `npm run build` remains the frontend-only `vite build` per design A-08; output verified byte-identical (`index-fd616a1b.js`, `index-97468755.css`).

**Verification (2026-11-02):** `npm run lint` 0 (new server source covered by the existing `--ext js,jsx,ts,tsx` gate and `tsconfig.server.json`); `npm run typecheck` 0; `npm run test` 287/287 (278 pre-existing + 9 new server tests), 8 test files; `npm run build` 0; `npm run build:server` 0; `openspec validate modernize-gitdatnote-foundation` exit 0 (2 pre-existing non-blocking length warnings); `git diff --check` clean. Real HTTP smoke tests: compiled server (`npm start`, port 3999) and tsx dev server (port 3998) both started, served `{"status":"ok"}`, logged requests without sensitive data, returned JSON errors for unknown API routes, and exited 0 on SIGTERM with a `shutdown` log entry; no server process left running.

**Limitations:** Node 24 runtime compatibility is verified by configuration only (`NodeNext`, Node 24-compatible APIs — `fetch`/structuredClone not used in the server); the Node 24 LTS runtime gate belongs to task 2.8 (local runtime is Node v26.7.0). `npm audit` findings (25 vulnerabilities) remain deferred to task 2.10.

## Task 2.4 Code Review Corrections (2026-11-02)

**Scope:** narrow corrective pass following independent review of commit `71f6e34` (task 2.4 backend foundation). No other OpenSpec task started; no unrelated source refactoring; no new dependencies.

**Findings and corrections:**

| # | Finding | Correction |
|---|---|---|
| 1 | `new URL(req.url, 'http://localhost')` was called *outside* the handler's exception boundary in `src/server/index.ts`: a malformed absolute-form request target (e.g. `http://x:99999/`) threw an uncaught `TypeError: Invalid URL`, crashing the Node process (reproduced pre-fix with a raw-socket probe). | URL parsing moved inside the handler's exception boundary. Parse failure → safe shared `PATH_INVALID` 422 envelope (`"The requested path is not valid."`); the request log line uses the fixed marker `(unparseable)` — the raw target is never echoed (absolute-form lines can carry credentials in userinfo/query). Normal routes unchanged (exact `/api/health` JSON, standard error envelopes). Server verified operational after the parse failure. |
| 2 | `resolvePort` silently substituted the default port for malformed `PORT` values (e.g. `3999abc`). | Hardened, documented fail-fast: `undefined`/empty `PORT` → default 3000 (unchanged); any other value that is not a base-10 integer in 1–65535 (rejects `3999abc`, `+5`, `1e3`, `1_000`, `0`, `65536`) → `main` logs `invalid_port` (error level) and exits 1. `resolvePort` exported for unit testing. |
| 3 | `server.test.ts` header implied the tests ran the compiled server. | Header clarified: the suite exercises the TypeScript application (`createApp`) over real HTTP on ephemeral ports under vitest/tsx; compiled-server execution (`npm run build:server` + `node dist-server/server/index.js`) is verified separately by smoke testing. |
| 4 | No guidance for logging future parameterized/sensitive routes. | Rule documented in `logging.ts` (and the `index.ts` header): future sensitive or parameterized routes must log sanitized route templates (e.g. `/api/articles/{id}`) rather than raw path segments. A general-purpose routing or logging framework is intentionally not built (out of scope for task 2.4). |

**Files:** `src/server/index.ts` (parse boundary + `UNPARSEABLE_PATH` marker + 422 branch, hardened `resolvePort` + `invalid_port` fail-fast in `main`, header docs), `src/server/middleware/logging.ts` (sanitized route-template rule, marker-path documentation), `tests/unit/server/server.test.ts` (header clarification; regression test: raw-socket malformed target `http://x:99999/` → 422 envelope + exact safe log line + server operational afterward; `resolvePort` unit test; 11 tests total).

**Verification (2026-11-02, post-pass):** `npm run lint` 0; `npm run typecheck` 0; `npm run test` **289/289** (287 baseline + 2 new), 8 test files; `npm run build` 0; `npm run build:server` 0; `openspec validate modernize-gitdatnote-foundation` valid (2 pre-existing non-blocking length warnings); `git diff --check` clean. Compiled-server smoke test (port 3997): `GET /api/health` → 200 `{"status":"ok"}`; raw malformed target → 422 with request log line `{"path":"(unparseable)","status":422}` (no raw target in logs); health after → 200; SIGTERM → clean `shutdown` log, exit 0. Invalid-PORT smoke: `PORT=3999abc` → `{"event":"invalid_port"}` error log, exit 1. No server process left running.

**Out of scope (unchanged):** GitHub authentication, database sessions, content APIs, frontend migration, dependency-security upgrades (task 2.10), Node 24 runtime gate (task 2.8). The uncommitted `.hermes/skills/openspec-apply-change/SKILL.md` modification was left untouched.

## Dependency-Security Review — Task 2.10 (2026-11-05)

**Branch/HEAD:** `feat/gitdatnote-2` @ `59977dd`. Local Node 26.7.0 / npm 11.17.0. `npm audit fix --force` never used; no `npm update` broad refreshes; no source-code, CI, or test changes — manifest and lockfile only.

### Baseline (before)

`npm audit` (full tree, post-`npm ci`): **30 findings** — 1 low / 15 moderate / 11 high / 3 critical. This confirms the task-2.8 `npm ci` report (30) rather than the older task-2.1 figure (25); the task-2.1 count predates the dev-tooling major versions installed in task 2.2.

Production-reachable subset (`npm audit --omit=dev`, before): **6 findings** — 5 moderate in the `octokit` tree (`octokit` → `@octokit/plugin-paginate-rest` ReDoS ×2, `@octokit/endpoint` ReDoS, `@octokit/request` ReDoS, `@octokit/request-error` ReDoS) and 1 high in `@octokit/app` → `jsonwebtoken` → `jws@3.2.2` (improperly verifies HMAC signature). The other 24 findings were development-tooling exposure (vite/vitest/happy-dom/tinypool/esbuild trees and ESLint/TS-eslint transitive DoS/ReDoS). The 3 criticals were dev-only: `tinypool` prototype-pollution→RCE (×2, via vitest) and `happy-dom` VM context escape→RCE.

Full advisory inventory (30 affected roots → 102 advisory entries) is preserved in `~/.hermes/cache/scratch/audit-before.json` (local artifact); the per-advisory breakdown is summarized in the resolution table below.

### Resolution by group (each group verified green before the next began)

| Group | Change | Findings resolved | Gate result |
|---|---|---|---|
| 1 (prod) | `octokit ^3.2.1 → ^3.2.2`; `jws 3.2.2 → 3.2.3` (via `@octokit/app`); in-range bumps of the 5 patched `@octokit/*` sub-packages | 6 (5 moderate, 1 high) | prod audit 6 → **0**; lint/typecheck/test (299/299)/build/build:server/e2e (10/10) all green |
| 2 | `js-yaml ^4.1.0 → ^4.3.2` | 5 (3 high, 2 moderate) — merge-key quadratic DoS, `!!omap` DoS, `maxTotalMergeKeys` gap | full group gate green |
| 3 | `vite ^4.5.5 → ^6.4.5`; `vitest ^2.1.9 → ^4.1.12`; `@vitejs/plugin-react ^4.3.4 → ^5.2.0`; in-range bumps (`rollup 4.62`, `esbuild 0.28.7`, `postcss 8.5.9`, `nanoid 3.3.18`, `source-map-js 1.2.2`, `@babel/core 7.29.13`) | 13 — `vite` (19 advisories, 2 high launch-editor + rest moderate/low dev-server), `vitest` (1 critical UI file-read + cascades), `tinypool` (2 critical, removed from tree in v4), `@vitest/mocker` (2 moderate), `vite-node`, `esbuild`, `rollup`, `postcss`, `nanoid`, `source-map-js`, `@babel/core` (1 low), `@babel/helpers` (1 moderate), `browserslist` (2 high — resolved automatically when `@babel/core` re-resolved to 7.29.13, which requires `browserslist ^4.29.5`) | full group gate green; no source/config changes needed (all `vitest.config.ts` / `vite.config.ts` / `tsconfig.*` options remain valid in the new majors; `happy-dom` env still resolved under vitest 4) |
| 4 | `happy-dom ^15.11.7 → ^21.0.4` | 5 (1 critical VM escape, 3 high, 1 moderate) | full group gate green; no test code changes required |
| 5 | `ajv 6.12.6 → 6.15.0` (owned by `eslint-plugin-jsx-a11y`); `flatted 3.3.2 → 3.4.4` (owned by `eslint`'s `flat-cache`); `minimatch 3.1.2 → 3.1.5` (owned by `eslint`/glob tree); `brace-expansion 1.1.11 → 1.1.21` (owned by `minimatch@3.1.5`, `^1.1.7`); scoped override `@typescript-eslint/typescript-estree → minimatch 11.0.5` | 9 — `ajv` (1 moderate ReDoS `$data`), `flatted` (2 high: unbounded-recursion DoS, prototype pollution), `minimatch` (3 high ReDoS + 1 moderate globparts), `brace-expansion` (8 advisories, top high), `typescript-estree` cascade (1 moderate, surfaces under 5 `@typescript-eslint/*` roots) | full group gate green — including `lint` with the TS parser running the overridden `minimatch` |

Every one of the 30 baseline findings is resolved. No advisory was left unresolved; there are no exceptions to record.

### Single npm override (documented, per spec)

```json
"overrides": {
  "@typescript-eslint/typescript-estree": { "minimatch": "11.0.5" }
}
```

Justification: `typescript-estree@8.72.1` (latest; part of the installed `@typescript-eslint` 8.72.1 tree) pins `minimatch ^10.2.2`, whose highest release (10.2.6) still carries the globparts DoS advisory (`<11.0.1`); no non-breaking fix exists within that tree. `minimatch@11.0.5` is API-compatible for the glob usage (verified: full lint run with `@typescript-eslint/parser` + `eslint-plugin` green, full suite green). `minimatch@11.0.5` engines: `20 || >=22` — Node 24/26 compatible. No other overrides were added.

### Node 24 / Node 26 compatibility

Engines of every changed direct dependency: `vite@6.4.5` `^18 || ^20 || >=22`; `vitest@4.1.12` `^20 || ^22 || >=24`; `@vitejs/plugin-react@5.2.0` `^20.19 || >=22.12`; `happy-dom@21.0.4` `>=20`; `minimatch@11.0.5` `20 || >=22`; all others within their existing majors. Local verification ran on Node 26.7.0; the Node 24 leg will be confirmed by hosted CI (Node 24 + 26 matrix, task 2.8 workflow) once these changes are pushed — per spec, Node 24 compatibility is not claimed from local Node 26 runs alone.

### Final audit (after)

- `npm audit`: **0 vulnerabilities** (info 0 / low 0 / moderate 0 / high 0 / critical 0), exit code 0.
- `npm audit --json`: severities `{info:0, low:0, moderate:0, high:0, critical:0, total:0}` (artifact: `~/.hermes/cache/scratch/audit-after.json`).
- `npm audit --omit=dev`: **0 vulnerabilities**, exit code 0.

### Complete verification suite (after final changes, from clean `npm ci`)

`npm ci` clean; `npm run lint` 0; `npm run typecheck` 0; `npm run test` **299/299** (15 files) — no assertions weakened, no tests removed, real-browser Markdown XSS regression tests still exercise the actual `src/web/markdown.ts` pipeline; `npm run build` 0 (134 modules); `npm run build:server` 0; `npm run test:e2e` **10/10** in Chromium; `openspec validate modernize-gitdatnote-foundation` valid (2 pre-existing non-blocking length warnings); `git diff --check` clean; `npm ls --depth=0` — all direct deps at the versions above, no invalid/missing.

### Files changed

- `package.json` — `dependencies`: `octokit ^3.2.2`; `devDependencies`: `@vitejs/plugin-react ^5.2.0`, `happy-dom ^21.0.4`, `js-yaml ^4.3.2`, `vite ^6.4.5`, `vitest ^4.1.12`; new top-level `overrides` (single entry, above).
- `package-lock.json` — lockfile updated through npm (`npm update` per group + the override); no manual lockfile edits.

### Out of scope (unchanged)

No source, test, CI, or OpenSpec content changes. No commit, push, or archive performed. Unrelated local changes (`.hermes/skills/*` modifications, untracked Hermes scripts) preserved untouched. No GitHub credentials, repository identifiers, personal names, or emails introduced; encryption keys remain outside SQLite and source control.

## Secure SQLite Session Storage — Task 3.1 (2026-11-06)

Implements OpenSpec decision A-04: encrypted session storage on the server boundary only.

### Module layout (`src/server/session/`)

- `types.ts` — public contract: `SessionUser`, `SessionCredentials`, `SessionLookupResult`, `StoredSession` (holds the decrypted credentials in server memory only — the database row stores only sealed ciphertexts), `CreateSessionInput`, `SessionStorage` interface, `SessionStorageError` + `SessionErrorCode` (`STORAGE_NOT_OPEN`, `INVALID_SESSION_ID`, `INVALID_CREDENTIALS`, `CONFIG_INVALID`, `ENC_KEY_MISSING`, `ENC_KEY_INVALID`, `DECRYPTION_FAILED`, `DB_ERROR`). Task 3.2 consumes this interface; no database access is needed from the frontend.
- `crypto.ts` — AES-256-GCM `sealSecret`/`openSecret`. Sealed format (versioned, unambiguous): `v1:<iv hex>:<tag hex>:<ciphertext hex>` — 12-byte random IV (NIST-recommended for GCM), 16-byte authentication tag, fresh per encryption. `parseEncryptionKey` accepts exactly 64 hex characters (256 bits); returns `null` otherwise. `openSecret` returns `null` for malformed payloads or failed authentication; callers map that to `DECRYPTION_FAILED` — raw crypto error text never propagates.
- `config.ts` — `resolveSessionConfig`: strict validation. `SESSION_DB_PATH` (default `./data/sessions.db`; absolute or repo-relative, rejects empty/whitespace/unsafe values), `SESSION_ENCRYPTION_KEY` (required; exactly 64 hex — no truncation, padding, hashing, or derivation from arbitrary passwords), `SESSION_MAX_AGE_DAYS` (default 7; whole days 1–3650; rejects floats, 0, negatives, non-numeric). Malformed/unsafe values are rejected with a stable error, never silently substituted. `ensureSessionDbParent` creates only the missing parent-directory segments, each private (`0700` on POSIX), and never chmod's existing directories. Injectable `now` clock for deterministic tests.
- `storage.ts` — `openSessionStorage(config)`. SQLite via `better-sqlite3`. `sessions` table, exactly the 10 required columns: `session_id TEXT PK`, `user_login TEXT NOT NULL`, `user_name TEXT NOT NULL`, `user_avatar_url TEXT NOT NULL`, `csrf_token TEXT NOT NULL`, `token_encrypted TEXT NOT NULL`, `refresh_token_encrypted TEXT NOT NULL`, `token_expires_at INTEGER NOT NULL`, `refresh_expires_at INTEGER NOT NULL`, `created_at INTEGER NOT NULL` (epoch ms). Operations: `createSession` (crypto-random 64-hex `session_id`, 64-hex CSRF value, tokens sealed before insert), `getSession` (missing → `missing`; at/past `created_at + maxAge` → `expired`; both enforced in the storage layer), `rotateCredentials` (single statement inside a transaction replaces the encrypted token pair **and both expiry timestamps atomically**; an expired session is reported as `{ status: 'expired' }` before any write), `deleteSession`, `purgeExpiredSessions`, `close`. Every SQLite failure (open, schema, prepare, statement, runtime) is mapped to a stable `SessionStorageError` with code `DB_ERROR` and a fixed message — never SQL text, database paths, or raw SQLite error text; typed session errors raised by the module itself are preserved unchanged. On POSIX the database file is kept private (`0600`), re-secured if an existing file drifted, and initialization fails closed if it cannot be made private. Expiration is a storage-layer guarantee, not left to cookie expiry.
- `cookies.ts` — fixed documented cookie `gitdatnote_session` (pattern `/^[0-9a-f]{64}$/`). Issue: `HttpOnly; SameSite=Lax; Path=/; Max-Age/Expires` aligned to the session lifetime; `Secure` in production/HTTPS mode or explicit `SESSION_COOKIE_SECURE`, omitted in local HTTP dev per OpenSpec. Parse: malformed/missing cookie → `null` (unauthenticated), never throws. Clear: matching attributes, `Max-Age=0`.
- `better-sqlite3.d.ts` — minimal local type declaration (constructor, `exec`, `prepare`, `transaction`, `close`, `Statement.run/get/all`, `RunResult`). Deliberate: avoids adding an `@types` package to the dependency tree; declares only the surface this module uses.
- `index.ts` — barrel export; the sole import surface for task 3.2.

### Encryption format and key requirements

- Algorithm: AES-256-GCM (Node `crypto` built-ins only).
- `SESSION_ENCRYPTION_KEY`: exactly 64 lowercase-or-uppercase hex characters = 256-bit secret with full entropy. Used verbatim as the key — no truncation, padding, salt, stretch, or derivation. Missing → `ENC_KEY_MISSING`, wrong format/length → `ENC_KEY_INVALID` — initialization failure, never a silent generated key (a silent key would make persisted sessions undecryptable after restart).
- Storage format: `v1:<iv>:<tag>:<ciphertext>` (all lowercase hex). `v1` is the only accepted version today; unknown versions and malformed payloads return `null` from `openSecret`, which storage maps to `DECRYPTION_FAILED`. Tampering is detected by the GCM tag and fails the same way.
- Both the access token and refresh token are sealed separately (independent IVs) and stored in their own columns. Expiry timestamps stored as epoch ms integers. Plaintext tokens never reach SQLite, logs, or responses — verified by test (`SELECT *` scan of the table contains no plaintext).
- Raw crypto/SQL error messages are never propagated: `SessionStorageError` carries stable codes; details are logged server-side only where safe.

### Session lifetime and configuration

- Defaults: `SESSION_DB_PATH=./data/sessions.db`, `SESSION_MAX_AGE_DAYS=7`.
- Expiration: a session at/past `created_at + maxAgeMs` is rejected as `expired` on retrieval; `purgeExpiredSessions` removes only expired rows (returns count). Cookie `Max-Age`/`Expires` are aligned to the same lifetime but are a UX convenience — the storage layer is authoritative.
- `/data/` added to `.gitignore` (it was absent); database files can never be committed. `data/` is created on demand with safe, permission-aware parent-directory handling.

### Cookie attributes and lifecycle

- Name: `gitdatnote_session` (fixed, documented in `cookies.ts`).
- Always: `HttpOnly`, `SameSite=Lax`, `Path=/`.
- `Secure`: production/HTTPS mode (or explicit `SESSION_COOKIE_SECURE=true`); omitted in local HTTP development per OpenSpec.
- Lifetime: `Max-Age` + `Expires` derived from the session lifetime (remaining seconds, minimum 0).
- Clear: `clearSessionCookie` sets the same attributes with `Max-Age=0` and empty value.
- The session ID travels only in the cookie; it is never placed in API responses, frontend JavaScript, or logs.

### Tests (41 initial + 7 correction regression tests, deterministic)

- `tests/unit/server/session.test.ts` (31): initial 24 — lifecycle (create/retrieve, persistence across close+reopen, delete, missing, expired, configurable lifetime, atomic rotation, selective purge); crypto (round-trip access+refresh, fresh IV/ciphertext per seal, tampered ciphertext, invalid tag, malformed payloads, invalid/missing key, distinct keys, no plaintext in the raw table); config (defaults, explicit valid, missing key, malformed key, malformed max-age, unsafe db path, parent-directory creation, deterministic `maxAgeMs`). Plus 7 correction regression tests (see the correction record below): 2 POSIX file-permission tests, 4 SQLite failure-normalization tests, 1 expired-rotation guard test.
- `tests/unit/server/session-cookies.test.ts` (17): required attributes present, `Secure` omitted in dev / present in production, `Max-Age`/`Expires` behavior (remaining lifetime, zero floor, invalid max-age rejected), fixed cookie name, clearing, safe parsing of missing/malformed values (returns `null`), secure-mode resolution.
- All tests use temp databases under the OS tmpdir, fake tokens (`gho_test_*`/`ghr_test_*` — obviously non-real), fake 64-hex test keys, and injected deterministic clocks. No real GitHub credentials, no fake auth routes, no flaky timing.

### Verification (from clean `npm ci`, Node 26.7.0)

- `npm run lint` — 0 (after two self-detected fixes: unused `SCHEMA` constant — table creation was missing until this gate — and missing `better-sqlite3` types, resolved by the local declaration, plus auto-fixed `prefer-const` in tests).
- `npm run typecheck` — 0 (web + server projects).
- `npm run test` — **340/340** Vitest across 13 files (299 pre-existing + 41 new; no existing test weakened or removed).
- `npm run build` — 0 (134 modules). Frontend bundle scanned: contains no session cookie name, key env var, encrypted-token column names, crypto helpers, or `better-sqlite3` references.
- `npm run build:server` — 0; `dist-server/server/session/` contains the compiled module (server boundary).
- `npm run test:e2e` — **10/10** Chromium (unchanged; current server behavior is untouched).
- `npm audit` — 0 vulnerabilities (unchanged since task 2.10; no dependency changes in this task).
- `openspec validate modernize-gitdatnote-foundation` — valid (2 pre-existing non-blocking length warnings in `spec.md`).
- `git diff --check` — clean.

### Focused code review corrections (2026-11-06)

Independent source review of the initial Task 3.1 implementation; four narrowly scoped corrections applied, no other scope touched.

**1. SQLite file protection on POSIX.**
- New database files are made `0600` (SQLite creates them with the process umask, typically world-readable `0644`).
- Only the missing parent-directory segments are created, each `0700` on POSIX; existing parent directories are never chmod'd (an existing `0755` parent is verified untouched in tests).
- An existing database file that drifted to a permissive mode is re-secured to `0600` on open; its content is never modified. If the file cannot be made private, initialization fails closed with a stable `DB_ERROR`.
- `IS_POSIX = process.platform !== 'win32'` gates all permission enforcement and tests (`describe.skipIf`), so behavior and tests are correct on platforms without meaningful permission bits.

**2. SQLite failure normalization.**
- Open, schema (`db.exec`), prepare, and runtime statement failures all map to `SessionStorageError` with code `DB_ERROR` and fixed, outward-safe messages — never SQL text, database paths, or raw SQLite error text.
- If initialization fails after the database handle is open (schema or prepare failure), the handle is closed before the error is thrown.
- Typed session errors raised by the module itself (e.g. `STORAGE_NOT_OPEN`, `INVALID_CREDENTIALS`, `DECRYPTION_FAILED`) are preserved unchanged rather than masked as `DB_ERROR`.

**3. No credential rotation on expired sessions.**
- `rotateCredentials` runs the expiration check (`created_at + maxAge`) and the credential update in a single `better-sqlite3` transaction: an expired session returns `{ status: 'expired' }` before any write, and the check and update cannot interleave.

**4. Audit corrections.** This section's earlier text used incorrect error codes (`not_found`, `crypto_error`, ...), storage method names (`create`/`retrieve`/`delete`/`purgeExpired`), a wrong cookie-parse result (`undefined` instead of `null`), and a wrong per-file test split (25/16 instead of 24/17). All corrected to match the implementation.

**New regression tests (7):** new-file `0600` + new-directory `0700` + existing parent untouched; existing-file re-secure + content preserved across reopen; corrupt-file open → stable `DB_ERROR`; schema conflict → `DB_ERROR` with the file left usable; runtime statement failure (poisoned `CHECK` constraint) → `DB_ERROR` with no SQL/path leakage; typed-error preservation (`STORAGE_NOT_OPEN`); expired-session rotation refused with stored ciphertexts and expiries byte-for-byte unchanged and the new token values absent from the database.

**Verification after corrections:** focused session suites 48/48; `npm run lint` 0; `npm run typecheck` 0; `npm run test` **347/347** (299 pre-existing + 48 session-suite tests); `npm run build` 0; `npm run build:server` 0; `npm run test:e2e` **10/10**; `openspec validate modernize-gitdatnote-foundation` valid; `git diff --check` clean. Local app verified starting via `npm run dev:server` (`/api/health` 200) and `npm run dev` (root 200, proxied `/api/health` 200, disconnected/sample-preview UI unchanged).

### Security constraints honored

- Encryption key stays outside SQLite and source control (env-only; test keys are fake).
- No hardcoded personal names, email addresses, or repository identifiers.
- No GitHub credentials introduced into browser code; bundle scan confirms.
- No silent key generation at startup; no key truncation/padding/derivation.
- No raw SQL or token values exposed through any public API surface; stable error codes only.
- Session database file kept private to the current user on POSIX (mode `0600`).
- No commit of database files (`/data/` gitignored; no DB artifacts left in the working tree).

### Task boundary (deferred to later tasks, untouched here)

- No OAuth routes, no credential exchange, no `GET /api/session`, no `POST /api/auth/logout`, no repository authorization, no CSRF middleware/enforcement (task 3.3), no token-refresh HTTP calls, no frontend UI — all task 3.2/3.3/3.4/3.5/3.6 scope.
- No fake routes or fake successful sessions added; the current server behavior is unchanged.
- No dependency additions, upgrades, or lockfile churn.

### Files changed

Created: `src/server/session/{types,crypto,config,storage,cookies,index,better-sqlite3.d}.ts`; `tests/unit/server/{session.test.ts, session-cookies.test.ts}`.
Modified: `.gitignore` (added `/data/` with explanatory comment); `openspec/changes/modernize-gitdatnote-foundation/{tasks.md, audit.md}` (this task's completion records, including the correction record above).
No commit, push, or archive performed; unrelated local changes (`.hermes/skills/*`, untracked Hermes scripts) preserved untouched.

---

## Task 3.2 — GitHub App user authorization, session endpoints, repository discovery boundary

### Scope discrepancy correction (required wording change)

**What was changed.** `tasks.md` Task 3.2 previously specified `scope=repo read:user user:email offline_access` for the authorization redirect. This is an OAuth App scope set; it does not apply to GitHub Apps. The task text was corrected to the documented GitHub App value `scope=offline_access`, with a one-line note that repository access is controlled by the App's permissions and installations. No other task wording was changed.

**Why.** GitHub's current documentation for the GitHub App web flow states that GitHub Apps do not use traditional OAuth scopes to grant repository access; the only supported authorization scope value for the web flow is `offline_access` (which enables refresh-token issuance). Repository access is determined by the App's configured permissions and the user's installation of the App, not by scopes. Sending the OAuth-App scope set to `https://github.com/login/oauth/authorize` for a GitHub App client ID is not part of the documented GitHub App flow.

**Source.** https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app — "Generating a user access token for a GitHub App" (web flow: `client_id`, `scope=offline_access`, `state`; token response includes `access_token`, `expires_in`, `refresh_token`, `refresh_token_expires_in`).

**Resulting contract.** Authorization redirect uses `client_id`, `redirect_uri`, `state`, `scope=offline_access` (plus `code_challenge` where PKCE S256 is applied). No `GITHUB_APP_ID` or private key is used in the user authorization flow. Repository access stays under App permission/installation control, enforced at the repository discovery boundary (see below) rather than via scopes.

### Implementation summary

- New module `src/server/auth/` (7 files, 1,171 lines): `types.ts` (contracts + stable error reasons), `config.ts` (strict env validation; `resolveAuthConfig` returns a result object; client ID must match the documented GitHub App client ID format — an alphanumeric `Iv…` string such as `Iv1.ab1112223334445c`, explicitly NOT the numeric App ID), `state.ts` (dedicated SQLite `pending_authorizations` table; 32-byte `randomBytes` state; PKCE S256 verifier; expiry; one-time atomic consumption), `cookies.ts` (pending-auth binding cookie, `HttpOnly; SameSite=Lax; Path=/`, conditional `Secure`), `github.ts` (fetch-based GitHub HTTP: token exchange, `/user` profile, `/user/installations` + `/user/installations/{id}/repositories`; stable error mapping 401→`UNAUTHORIZED`, 403/429→`RATE_LIMITED`, ≥500→`GITHUB_UNAVAILABLE`), `routes.ts` (five endpoint handlers), `index.ts` (public barrel).
- Endpoints added to the existing Node HTTP server (no new framework): `GET /api/auth/github/start`, `GET /api/auth/github/callback`, `GET /api/session`, `POST /api/auth/logout`, `GET /api/repositories`.
- Pending authorization: short bounded lifetime (10 min), server-side SQLite, browser-bound via the pending-auth cookie, consumed exactly once (atomic UPDATE combining expiry check and `consumed = 1`); failed or replayed consumption leaves no reusable record. Never stored in the `sessions` table.
- Token exchange: code exchanged server-side with `GITHUB_APP_CLIENT_SECRET` (server-side only) and the PKCE verifier; response must contain a non-empty access token, a refresh token, and positive expiry values — nonexpiring or malformed credential sets are rejected before any session is created.
- Session creation: user identity from `/user` (nullable `name` handled); stored through the Task 3.1 `SessionStorage` interface so both token values and both expiry timestamps are AES-GCM encrypted at rest; the existing `gitdatnote_session` cookie is set with the Task 3.1 attributes; the pending-auth binding cookie is cleared on success.
- `/user/emails` is intentionally NOT called in the callback: the frozen Task 3.1 session contract (`SessionUser`) has no email field, no Task 3.2 endpoint exposes email, and the commit-attribution spec (design.md: committer email) reads the public email from `GET /user` at commit time (Task 4.3/4.4), not from the session. The task text's clause "retrieve `/user/emails` only when supported and needed" therefore does not trigger at this boundary; private email availability is never assumed anywhere in the flow.
- `GET /api/session`: unauthenticated → `{ connected: false }`; authenticated → `connected: true`, non-secret identity fields, per-session CSRF token. Never returns tokens, session IDs, or database internals.
- `POST /api/auth/logout`: requires an authenticated session; validates `X-CSRF-Token` header only (403 `CSRF_INVALID` on missing/invalid); deletes the session server-side and clears the session cookie. Logout is CSRF-protected now, not deferred to Task 3.3.
- `GET /api/repositories`: authentication required; enumerates the user's GitHub App installations (`GET /user/installations`) with the user access token, then each installation's repositories (`GET /user/installations/{id}/repositories`); both paginated list endpoints are followed completely — `Link` pagination is honored only for absolute URLs on the trusted `https://api.github.com` origin and the exact requested path (a present-but-untrusted `rel="next"` — cross-origin, non-HTTPS, or malformed — aborts discovery with a safe `500 INTERNAL_ERROR` instead of returning a partial list, and the bearer token is never sent to such a URL), page counts and response sizes are bounded, and exceeding the safety limit fails loudly (500 `INTERNAL_ERROR`) instead of silently returning a partial list; `canRead`/`canWrite` are derived from the per-repository permissions inside the installation (`pull`/`push`), so a repository with no pull permission is listed truthfully as `canRead: false`, and membership never implies writability; repositories the user can see but that are in no App installation are not listed (they are not accessible to the App — no assumption from `/user/repos`); no application-wide privileged token is used; duplicates are resolved first-occurrence-wins; the configured content-root contract is preserved (`DEFAULT_CONTENT_ROOT`); empty installation lists and GitHub failures (429/500/network) return safe, schema-stable responses.
- `GET /api/health` remains functional with no GitHub configuration; unconfigured auth degrades to safe 302 → `/error?reason=auth_unconfigured` (callback/start) and stable JSON errors (session/repositories), never a crash.
- Callback query strings are never logged (they carry authorization codes); state, verifiers, cookies, codes, and secrets never appear in logs or API responses.
- Frontend: Connect GitHub now performs exactly one top-level navigation to `/api/auth/github/start` (the fetch probe and the double-start assumption were removed from `src/web/api.ts` / `DisconnectedView.tsx`; no start-state probing). Backend authentication failures redirect to `/error?reason=<stable-code>`, rendered by `src/web/components/ErrorView.tsx` with fixed, user-safe copy for a known allowlisted set of reasons (unknown or missing reasons show a generic message; raw query values are never rendered). The rest of the disconnected UI and the Task 3.6 connected-state work are unchanged.
- `.env.example` added: sanitized, no real credentials, lists `PORT`, `HOST`, `LOG_LEVEL`, the session encryption key (outside source control and outside the database), `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, and the callback URL. `.env` remains gitignored.

### Test evidence

- New `tests/unit/server/auth.test.ts` (1,191 lines, **53 tests**): start redirect parameters (client ID, callback URI, `scope=offline_access`, state, PKCE challenge); client-ID format validation (accepts documented alphanumeric GitHub App client IDs such as `Iv1.ab1112223334445c`; rejects numeric App IDs, wrong-case prefixes, too-short, and over-long values as `invalid_client_id`); crypto-generated state and binding cookie attributes; valid callback flow with encrypted session creation; missing/mismatched/expired/replayed state; consent denial; token-exchange failure and incomplete/invalid token responses; profile with `name: null`; session retrieval (authenticated, missing, invalid, expired); logout with valid/missing/invalid CSRF and cookie clearing; repository discovery authorization boundaries and safe failures; **multi-page discovery across both list endpoints** (mocked `Link` pagination), cross-origin, non-HTTPS, and malformed pagination links fail safely (500 `INTERNAL_ERROR`, no partial list, no request and no bearer token to the untrusted origin), bounded page-count/response-size limits that fail loudly (500 `INTERNAL_ERROR`) instead of silently returning a partial list, and GitHub 500 → 502 `GITHUB_UNAVAILABLE` mapping; malformed GitHub API responses; missing configuration; log/response secret-leak checks. All upstream GitHub traffic is mocked via an injectable `fetchImpl`; temporary SQLite databases; injected clock; no real GitHub credentials.
- Frontend suites: `tests/web/api.test.ts` (**16 tests**) — includes the single-navigation regression test (a `connectGithub` click performs exactly one `window.location.assign("/api/auth/github/start")` and zero fetch probes); `tests/web/components.test.tsx` (**10 tests**) — disconnected UI preserves the accessible labeled Connect button that invokes `connectGithub` exactly once, and `ErrorView` renders fixed copy only for known allowlisted reasons (unknown/missing reasons show a generic message; raw query values are never rendered).
- Verification (Task 3.2, incl. final pagination correction): `npm ci` (with dev dependencies) clean; `npm run lint` 0 errors; `npm run typecheck` 0 errors; `npm run test` **403/403** across 14 files (auth suite 53, api client suite 16, component suite 10, remainder unchanged); `npm run build` 0; `npm run build:server` 0; `npm run test:e2e` **10/10**; `npm audit` 0 vulnerabilities; `openspec validate modernize-gitdatnote-foundation` valid (2 pre-existing warnings from Task 3.1 spec requirement text, unchanged); `git diff --check` clean.
- Local verification (no credentials configured): `npm run dev:server` → `/api/health` `{"status":"ok"}`; `npm run dev` → root 200, proxied `/api/health` 200; UI shows the disconnected state ("Not connected to GitHub"), never a false connected state; sample repository preview, warning banner, repository selector, and safe Markdown preview all render; console clean of errors and secrets; `Connect GitHub` performs exactly one top-level navigation and safely lands on `/error?reason=auth_unconfigured` with the fixed ErrorView copy; unconfigured `/api/session` → `{ "connected": false }`; unauthenticated `/api/repositories` → 401; session-less logout → 401.
- Local verification (mocked GitHub configuration, fake but valid-format client ID/secret — no live credentials): authorization start returns 302 to `github.com/login/oauth/authorize` with `scope=offline_access` and `code_challenge_method=S256`; each start (one curl request + one browser click) created exactly **one** `pending_authorizations` row and the server log recorded exactly one `GET /api/auth/github/start` per start — no fetch probes, exactly one state issued; no client secret, session key, or state values appeared in server logs; grep of the built browser bundle and source found no embedded secrets. Live GitHub authorization was NOT performed (no real App credentials in this environment); all GitHub-facing behavior is verified against mocks.

### GitHub App registration prerequisites (for live testing)

- Create a GitHub App (no App ID/private key needed for the user web flow beyond installation).
- Configure Web flow: enable "OAuth App web flow" / user access tokens for the App (per current GitHub App settings).
- Set the callback URL to the exact `GITHUB_OAUTH_CALLBACK_URL` used in the environment (e.g. `http://127.0.0.1:3000/api/auth/github/callback` locally).
- Grant the App the repository permissions the note workflow needs (e.g. contents read/write, metadata) — these permissions, plus the installation, are what make `canRead`/`canWrite` truthful.
- Install the App on the account/organization; the user must consent to the installation before `/user/repos` intersection can report access.
- Provide `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` (server-side only), and `SESSION_ENCRYPTION_KEY` (64 hex chars) via environment; never via `VITE_*` variables.

### Task boundary (deferred, untouched here)

- Task 3.3: generalized CSRF enforcement across all state-changing endpoints (logout already enforces it individually).
- Task 3.4: comprehensive per-operation repository authorization and content APIs.
- Task 3.5: token-refresh implementation and the broader authentication regression matrix.
- Task 3.6: frontend finalization — connected-state UI and remaining connection flow polish (the single-top-level-navigation start and `/error` route rendering were pulled forward into the Task 3.2 review corrections).
- Task 3.7: deployment/production hardening.
- No commit, push, or archive performed; work remains on `feat/gitdatnote-2` at baseline `b77b7ff` with the uncommitted working tree.

---

## Task 3.3 — Generalized CSRF protection for state-changing API requests

### Implementation summary

- New module `src/server/middleware/csrf.ts` (160 lines) — the single centralized CSRF boundary (design.md decision A-05):
  - `CSRF_HEADER_NAME` — the only accepted token carrier: the `X-CSRF-Token` header. Token values carried in request bodies, query strings, or cookies are never read.
  - `readCsrfHeader(req)` — returns `null` for a missing header or for duplicate/ambiguous headers: a raw header array is accepted only when it holds exactly one value, and Node's comma-joined repeated-header string can never pass the strict format gate, so ambiguity is rejected, never resolved by picking one value.
  - `isValidCsrfToken(value)` — strict format gate: exactly 64 lowercase hex characters (the session's 32 random bytes). Uppercase, non-hex, wrong-length, empty, and padded values are rejected.
  - `constantTimeTokenMatch(provided, expected)` — both operands must already pass the format gate; then hex-decoded to byte buffers and compared with `crypto.timingSafeEqual` (length-checked first). Malformed attacker-controlled input is never decoded or compared.
  - `checkCsrf(req, storage, logger)` — performs exactly one session lookup, resolved from the session cookie (missing cookie short-circuits before any database access): missing/unknown/expired session → `unauthorized`; storage failure → `internal` (fail closed); otherwise validates the header token against the session's stored `csrfToken` — wrong/missing/malformed → `csrf_invalid`.
  - `respondToCsrf(res, result)` — maps outcomes to the established contracts: `401 UNAUTHORIZED`, `403 CSRF_INVALID`, `500 INTERNAL_ERROR`, written with the same flat `errorDetail` envelope the baseline logout endpoint used.
- Integration in `src/server/index.ts` dispatch: after URL parsing and the `urlParseFailed` check, before any route matching. The boundary fires for `pathname.startsWith('/api/')` AND method `POST`/`PUT`/`DELETE`, and its authorization decision is **unconditional**: when session storage is unavailable (missing/invalid encryption key or a broken database) the request fails closed immediately with the established flat 401 `UNAUTHORIZED` before route dispatch — no per-route fallback is needed and future state-changing handlers can never bypass the boundary in that failure state; when storage is configured, `checkCsrf` resolves the requesting session and enforces the header token. It therefore protects `POST /api/auth/logout` today and, by construction, every future state-changing `/api/` route — handlers cannot bypass it, and no handler re-implements CSRF validation.
- `handleLogout` refactored in `src/server/auth/routes.ts`: the duplicated per-handler CSRF validation (and its `validateCsrf` helper) was removed only after the centralized boundary demonstrably protected logout. The handler now takes `(res, authDeps, sessionId)` — the verified session ID from the boundary result — and performs only logout behavior: null session → 401, `deleteSession` failure → 500, `deleted === false` → 401, success → 204 + cleared session cookie + `logout` log. Session deletion and cookie clearing behavior are preserved exactly.
- CSRF generation and persistence are unchanged from Tasks 3.1/3.2: the same 64-hex per-session `csrfToken` generated at session creation, stored in SQLite, exposed only via authenticated `GET /api/session`. No second token, no persistence-format change, no second session mechanism.
- Unaffected by design: all read-only (GET) endpoints, OAuth authorization start and callback (callback `state` validation unchanged; OAuth `state` is never treated as CSRF), `GET /api/health`, unauthenticated-safe 404 behavior for unsupported routes, and unauthenticated `POST /api/auth/logout` (401 from the boundary before CSRF validation).
- Logging: `csrf_rejected` (warn; fixed safe reason codes) and `csrf_session_lookup_failed` (error; safe reason) only. CSRF token values, session IDs, cookies, and credentials never appear in logs or responses.

### Protected routes / methods

- All authenticated state-changing API requests: `POST`, `PUT`, `DELETE` under `/api/`, enforced centrally before dispatch. Only `POST /api/auth/logout` is registered today; the boundary covers any future state-changing endpoint without further work.
- Unauthenticated state-changing requests: 401 `UNAUTHORIZED` (session resolution fails before CSRF validation).
- Read-only requests: no CSRF requirement; behavior unchanged.

### Test evidence

- New `tests/unit/server/csrf.test.ts` (949 lines, **60 tests**; no real GitHub credentials — ephemeral HTTP servers on ephemeral ports, mocked `fetchImpl`, temporary SQLite databases, injected clock):
  - Part A (middleware isolation): header-only carrier — body/query/cookie carriers are never accepted; strict 64-lowercase-hex format gate (uppercase, non-hex, wrong length, empty, padded all rejected); duplicate/ambiguous header rejected; constant-time match (equal → true, different or unequal-length → false); `checkCsrf` outcomes — `ok`, `unauthorized` (no cookie, malformed cookie, expired session, missing stored session), `csrf_invalid` (missing header, empty, malformed, wrong token, token from a different session), `internal` (storage failure, fail closed); `respondToCsrf` envelopes (401/403/500, flat `errorDetail` shape identical to the baseline logout responses; no token/session/cookie values in any body).
  - Part B (HTTP security boundary): authenticated session + matching CSRF → logout succeeds (204, session row deleted, cookie cleared, `logout` logged); missing/empty/malformed/wrong/duplicate CSRF → 403 `CSRF_INVALID` with the session preserved; no session cookie → 401 `UNAUTHORIZED`; expired session → 401; token carried only in body, query, or cookie → 403 (never accepted); token from another session → 403; storage failure on a valid session → 500 `INTERNAL_ERROR` (fail closed); unregistered state-changing routes (`POST`/`PUT`/`DELETE /api/notes`) → 401 unauthenticated, 403 without CSRF, and only then the standard safe 404 `FILE_NOT_FOUND` — proving the boundary protects future handlers before they exist; authenticated `GET /api/health` and `GET /api/repositories` work with no CSRF header; OAuth start (`GET /api/auth/github/start`) still 302-redirects with no CSRF header required; no CSRF token, session ID, or cookie value appears in logged payloads or response bodies.
  - Part C (storage-unavailable fail-closed state; a harness with `SESSION_ENCRYPTION_KEY` absent so `resolveSessionConfig` throws `ENC_KEY_MISSING` and the server runs with `session === null`): `POST`/`PUT`/`DELETE /api/notes` (unregistered) → 401 `UNAUTHORIZED` from the boundary itself — before the correction this failure state fell through to the safe 404, and a future state-changing handler could have bypassed the boundary entirely; `POST /api/auth/logout` → 401 `UNAUTHORIZED` with the authenticated surface still reporting `connected: false` and nothing mutated; `GET /api/health` → 200 `{status:'ok'}` — together proving no state-changing route reaches an application handler while read-only behavior stays available.
- Existing suites green: Task 3.1 session suites, Task 3.2 auth suite (53 tests, including logout CSRF and OAuth state validation), frontend suites, and the 10/10 e2e suite. One Task 2.4 contract test in `tests/unit/server/server.test.ts` was updated to the corrected boundary: in a storage-unavailable state, `POST /api/health` now fails closed with the flat 401 `UNAUTHORIZED` from the boundary (previously it fell through to the safe 404); `GET /api/health` is unchanged.
- Verification gates: `npm ci` clean; `npm run lint` 0; `npm run typecheck` 0; `npm run test` **463/463** across 15 files (403 pre-existing + 60 new); `npm run build` 0; `npm run build:server` 0; `npm run test:e2e` **10/10**; `npm audit` 0 vulnerabilities; `openspec validate modernize-gitdatnote-foundation` valid (2 pre-existing warnings from Task 3.1 spec text, unchanged); `git diff --check` clean.
- Local verification (no credentials configured): dev server + Vite as in Task 3.2 — disconnected UI, sample preview, repository selector, and the safe `auth_unconfigured` path unchanged; unauthenticated `/api/repositories` → 401; session-less logout → 401; no CSRF tokens or session IDs in server logs or the built client bundle. Live GitHub authorization was NOT performed (no real App credentials in this environment); all GitHub-facing behavior is verified against mocks.

### Centralized middleware entry point (for future state-changing routes)

Future state-changing routes: register the handler under `/api/` in the dispatch table in `src/server/index.ts`. The CSRF boundary sits immediately after URL parsing and before route matching, so it enforces authentication + CSRF for every `POST`/`PUT`/`DELETE` automatically — handlers must not re-implement CSRF validation. The authorization decision is unconditional: with session storage configured it comes from `checkCsrf` (401/403/500), and without storage the boundary fails closed with the established flat 401 `UNAUTHORIZED`, so no handler can execute in that failure state. The only remaining per-handler CSRF-adjacent code is `handleLogout(res, authDeps, sessionId)`, which receives the boundary-verified session ID and performs only session deletion and cookie clearing. Read-only (GET) endpoints stay outside the boundary by design. If a future endpoint needs a different carrier or a non-`/api/` state-changing path, the boundary predicate in `src/server/index.ts` is the single place to extend.

### Files changed

Created: `src/server/middleware/csrf.ts` (160 lines); `tests/unit/server/csrf.test.ts` (949 lines, 60 tests).
Modified: `src/server/index.ts` (+42/−4: imports, doc comment, centralized CSRF boundary before dispatch with the unconditional authorization decision — fail-closed flat 401 `UNAUTHORIZED` when session storage is unavailable, `checkCsrf`/`respondToCsrf` otherwise — and the `csrf.sessionId` handoff; the previous logout 401 fallback was removed as no longer necessary); `src/server/auth/routes.ts` (+14/−37, net −23: `handleLogout` signature `(res, deps, sessionId)`, duplicated per-handler CSRF validation and its helper removed, logout behavior preserved); `tests/unit/server/server.test.ts` (+12/−8: the `POST /api/health` contract updated to the corrected fail-closed 401 in the storage-unavailable state); `openspec/changes/modernize-gitdatnote-foundation/tasks.md` (+1/−1: Task 3.3 marked complete with evidence); `openspec/changes/modernize-gitdatnote-foundation/audit.md` (+45: this section).
No commit, push, or archive performed; work remains on `feat/gitdatnote-2` at baseline `fe98b9a`. Unrelated local changes (`.hermes/skills/*` files and untracked Hermes scripts) preserved untouched.

## Task 3.4 — Repository authorization (dual: connected user + App installation)

### Implementation summary

A reusable, server-side repository authorization service that authorizes a repository operation only when **both** conditions hold: (1) the connected GitHub user has the required access on the target repository, and (2) the GitHub App's installation for the requested owner carries the required content permission with the repository inside its selected repository set. Read-only repositories are never treated as writable; unauthorized access fails safely with `403 REPO_NOT_ALLOWED` (no existence leakage). No content editing, publishing, or repository creation was introduced — only the service, the fail-closed HTTP boundary for the future `/api/repos/{owner}/{repo}/content` surface, and truthful `canRead`/`canWrite` discovery flags.

### Verified GitHub API permission semantics

Verified against the current official GitHub REST documentation (App authorization endpoints) before implementing:

- `GET /user/installations` (called with the connected user's own user access token) returns the App installations the user has access to. Each entry's `permissions` object is the **App's installation-level** permission map on that installation's selected repository set (e.g. `contents: "read" | "write" | "none"`); `suspended_at` is a non-null string while the installation is suspended.
- `GET /user/installations/{installation_id}/repositories` lists the repositories inside that installation's selected set. Each entry's `permissions` object is the **connected user's** effective per-repository permission visible through the App (`pull: boolean`, `push: boolean`).
- The two objects answer different questions — what the App may do, and what the user may do — so effective access is their **intersection**. Repository visibility (appearing in the list) does not imply write permission; ownership does not imply App access; an installation's general permission never applies outside its selected repository set; `/user/repos` is never consulted or assumed.
- The connected user's existing user-to-server token is sufficient to evaluate both sides — no App-level JWT or installation token is required or used (per the task constraint to avoid unnecessary privileged credentials).
- A `404` from either endpoint is ambiguous (no installation for this user / private or otherwise inaccessible repository) and must fail closed — it is never treated as authorization, and it must not reveal a private repository's existence.
- Rate limiting surfaces as `429` or as `403` with `X-RateLimit-Remaining: 0`; a plain `403` is a permission denial.

Note: the pre-existing `statusError` helper (used by `routes.ts`) maps any `403` to `RATE_LIMITED` — behavior documented in Tasks 3.2/3.3. The authorization path uses a new strict mapper (`authorizationStatusError`) that distinguishes rate-limit signals from true denials, and under which a `403` can never become an authorization success.

### Permission predicates (`src/server/auth/permissions.ts`, 122 lines)

Pure functions shared by repository discovery and the per-operation authorization service so the two surfaces can never drift:

- `installationContentPermission(permissions)` — normalizes the installation-level `permissions` object to its `contents` level (`'read'`/`'write'`/`'none'`); anything missing, non-object, or unexpected normalizes to `'none'`.
- `installationAllowsAccess(permissions, access)` — read is satisfied by `contents: "read"` **or** `"write"`; write requires `contents: "write"` exactly.
- `userAllowsAccess(permissions, access)` — read requires `pull === true`; write requires `push === true && pull === true` (a `push` without `pull` is malformed/ambiguous and never grants write). Missing fields or non-boolean values never grant access.
- `effectiveRepoAccess(userPermissions, installationPermissions, access)` — the intersection; both sides must grant.
- `validateRepositoryRef(owner, repo)` — owner 1–39 chars `[A-Za-z0-9-]` (alphanumeric + hyphens), repo 1–100 chars `[A-Za-z0-9._-]`; malformed references are rejected locally, never sent upstream, never echoed back.

### Authorization service (`src/server/auth/authorization.ts`, 251 lines)

Public interface:

```ts
async function authorizeRepository(
  session: StoredSession | null,
  owner: string,
  repo: string,
  requiredAccess: 'read' | 'write',
  deps: { fetchImpl?: FetchImpl } = {},
): Promise<RepositoryAuthorization>

type RepositoryAuthorization =
  | { status: 'authorized'; owner: string; repo: string; access: 'read' | 'write' }
  | { status: 'unauthorized' }
  | { status: 'denied' };
```

The authorized result carries only owner/repo/access — never tokens, credentials, or installation details. Flow (each step fail-closed, all data fresh — permission state from an earlier discovery call is never cached or trusted):

1. Malformed reference → `denied` (local, no upstream request).
2. No session or empty access token → `unauthorized` (no upstream request).
3. `GET /user/installations` — select an **unsuspended** installation whose account login matches the requested **owner** (case-insensitive); when several match, the lowest installation id is used (deterministic across calls). None → `denied`.
4. **App-level gate** — the selected installation must carry the required content permission (`installationAllowsAccess`); otherwise `denied` (checked before the repository listing is even fetched).
5. `GET /user/installations/{id}/repositories` — the repository must appear in this installation's selected set (owner + name, case-insensitive); absent → `denied`. Every matching entry must satisfy `effectiveRepoAccess` — duplicate entries with inconsistent permissions fail closed; all agreeing entries authorize.
6. Success → `{ status: 'authorized', owner, repo, access }`.

Upstream failure mapping (new `authorizationStatusError` mapper in `src/server/auth/github.ts`): `401` → `unauthorized`; `403` (plain) and `404` → `denied` — never a success, never an existence leak; `429` or `403` with `X-RateLimit-Remaining: 0` → `RATE_LIMITED`; `5xx` or network failure → `GITHUB_UNAVAILABLE`. Rate-limit, unavailability, and internal transport failures propagate as `AuthError` for the caller to map to `429`/`502`/`500` — they are never converted into authorization.

Read/write access is established exactly as above: read requires user `pull: true` **and** installation `contents` ∈ {read, write}; write requires user `push: true && pull: true` **and** installation `contents: "write"`. A repository visible to the user but read-only on either side is never writable.

### HTTP boundary (`src/server/middleware/repositoryAuth.ts`, 151 lines)

- `matchContentRepositoryRef(pathname)` — recognizes the future content route shape `/api/repos/{owner}/{repo}/content` and any path beneath it (regex `/^\/api\/repos\/([^/]+)\/([^/]+)\/content(?:\/|$)/`); returns `{owner, repo}` or `null` without registering any fake endpoint. Owner/repo are re-validated inside `authorizeRepository`.
- `enforceContentBoundary(req, res, ref, requiredAccess, deps, logger) → Promise<boolean>` — gates the session (storage unavailable / missing cookie / session not found → `401 UNAUTHORIZED`; storage failure → `500 INTERNAL_ERROR`), runs a **fresh** `authorizeRepository`, maps `unauthorized` → `401`, `denied` → `403 REPO_NOT_ALLOWED` (structured warn event `content_boundary_denied`, no permission details), propagates `AuthError` codes (`RATE_LIMITED` → `429`, `GITHUB_UNAVAILABLE` → `502`, others → `500`), and unexpected failures → `500 INTERNAL_ERROR`. Returns `true` only when authorized; the caller then responds per its own route rules — today the standard 404 because no content handler is registered yet.

Wiring in `src/server/index.ts` (both dispatch branches, ahead of the standard 404 fallthrough):

- GET/HEAD: boundary runs with `read` for `GET`/`HEAD` and `write` otherwise.
- POST/PUT/DELETE: the centralized CSRF boundary (Task 3.3) runs first, then the authorization boundary with `write`. CSRF proves the request came from the authenticated browser session; authorization proves the session is permitted on the target repository. Each is mandatory; neither substitutes for the other.
- An authenticated, authorized request against the (not-yet-existing) content route therefore receives the standard 404 today; every unauthorized or failed request receives its mapped safe error. This is the integration seam for the future content-operation task.

### Discovery integration (`src/server/auth/github.ts`)

`listAccessibleRepositories` now:

- skips installations with `suspended_at` set (a suspended installation grants no access);
- reads each installation-level `permissions` map;
- computes `canRead`/`canWrite` per repository as `effectiveRepoAccess(userPermissions, installationPermissions, …)` — a repository is never listed as writable without verified write access on both sides, and visible-but-not-writable repositories are reported read-only;
- normalizes entries into `InstallationInfo` / `InstallationRepositoryInfo` (new types in `src/server/auth/types.ts`), skipping malformed entries.

`GET /api/repositories` therefore returns truthful flags under the dual-permission model, and the repository selector can rely on them for read-only affordances (UI wiring is Task 3.6).

### Failure handling

- Every failure is safe, typed, and logged without credentials: `401 UNAUTHORIZED` (no session, session-less cookie, GitHub `401`), `403 REPO_NOT_ALLOWED` (denied — not installed, outside the selection, excluded, read-only, malformed fields, ambiguous `404`, inconsistent duplicates, plain GitHub `403`), `429 RATE_LIMITED`, `502 GITHUB_UNAVAILABLE` (`5xx`, network failure — authorization is never granted), `500 INTERNAL_ERROR` (storage or unexpected failure).
- Malformed inputs (missing/malformed owner, name, permissions, account) are skipped or fail closed — never authorized.
- The service does not throw for expected upstream failures (the typed result is the contract); transport `AuthError`s and unexpected errors propagate to the boundary's safe mapping.
- Responses and logs contain no tokens, credentials, permission details, repository contents, session IDs, or upstream bodies.

### Test evidence (`tests/unit/server/authorization.test.ts` — 57 tests, 1220 lines, deterministic mocks, no real GitHub credentials)

- **29 service-level tests** for `authorizeRepository` (mocked fetch): grant when both sides allow (read and write); each one-sided denial (user read-only, installation read-only, user write + installation read-only, installation write + user read-only); no installation for the requested owner; repository excluded from the installation selection; repository of another owner; unrelated repository for the authenticated user; installation with no contents permission at all; malformed/missing permission fields; missing/malformed installation account; safe denial on GitHub `404` for the repository list and the installation list; `401` → `unauthorized`; plain `403` → denial (never a success); rate-limit propagation (`429`, and `403` with `X-RateLimit-Remaining: 0`); `5xx` → `GITHUB_UNAVAILABLE`; network failure grants nothing; null session makes no upstream request; malformed repository references denied locally before any request; owner/repo matched case-insensitively (GitHub semantics); suspended installations skipped; lowest-id deterministic selection among multiple matches; permission changed after an earlier discovery honored (fresh check); repository removed from the installation after discovery denied; duplicate entries (inconsistent → fail closed, all agreeing → authorized); no credentials or installation details in the authorized result.
- **15 integration tests** over the real `createApp` server (mocked GitHub): unauthenticated content read → `401 UNAUTHORIZED`; unauthenticated mutation → `401 UNAUTHORIZED` (CSRF boundary fires first); authenticated + authorized read reaches the not-yet-existing handler as the standard 404; user with read-only access denied on the mutation path; mutation without a CSRF token → `CSRF_INVALID` (CSRF boundary intact, authorization never reached); authenticated, authorized, CSRF-validated write → standard 404; repository outside the App installation → `403 REPO_NOT_ALLOWED`; repository excluded from the installation selection → `403 REPO_NOT_ALLOWED`; GitHub `401` → `401 UNAUTHORIZED` on the boundary; GitHub plain `403` → `403 REPO_NOT_ALLOWED`; GitHub `404` → safe `403` (no existence leak); rate limit → `429 RATE_LIMITED`; `5xx` → `502 GITHUB_UNAVAILABLE`; network failure → `502` (no authorization); no credentials in responses or server logs.
- **2 matcher tests**: `matchContentRepositoryRef` parses owner/repo from content paths; rejects non-content paths.
- **3 discovery-flag tests**: truthful read/write flags under the dual model; read-only installation ⇒ everything read-only even if the user can push; installation without contents permission ⇒ repositories omitted from discovery entirely (exact entry count + entries asserted, so the check cannot pass vacuously — see compatibility-fix section below).
- **8 GitHub list response envelope regression tests** (added by the Task 3.4 compatibility fix; see below).

Existing discovery tests remain truthful: the default installation fixture in `tests/unit/server/auth.test.ts` now carries `permissions: { contents: 'write' }` and `suspended_at: null` (+8/−1, no assertions weakened or removed).

### Verification gates (fresh `npm ci`, re-run after the compatibility fix)

`npm ci` clean; `npm run lint` 0; `npm run typecheck` 0; focused auth suites **170/170** (`auth.test.ts` 71, `authorization.test.ts` 57, `csrf.test.ts` 42); `npm run test` **520/520** across 16 files (463 baseline + 49 task-3.4 + 8 envelope regression tests); `npm run build` 0; `npm run build:server` 0; `npm run test:e2e` **10/10**; `npm audit` 0 vulnerabilities; `openspec validate modernize-gitdatnote-foundation` valid (2 pre-existing warnings from spec requirement length, unchanged); `git diff --check` clean.

### GitHub API Response Compatibility Fix (2026-11-09)

Independent source review found one blocking defect: `fetchAllPages` in `src/server/auth/github.ts` consumed `response.json()` as a **bare array**, but the official GitHub REST documentation (`GET /user/installations` and `GET /user/installations/{installation_id}/repositories`, https://docs.github.com/en/rest/apps/installations) documents both endpoints as returning **JSON objects containing arrays** — `{ total_count: N, installations: [...] }` and `{ total_count: N, repositories: [...] }` respectively. With the old parser, live responses would be treated as empty lists (or fail), silently breaking discovery and authorization.

**Corrected response contract (now enforced):**

- Endpoint-aware parsing: the installations endpoint accepts only an object with an `installations` array; the repositories endpoint accepts only an object with a `repositories` array. Any other shape — bare array, missing field, non-object body, non-array field, unknown/extra field used as the list — is rejected. Arbitrary response fields are never accepted as the list.
- `total_count` must be a non-negative integer (GitHub sends a number). It is validated for **consistency only** (`total_count === array.length` on every page, including multi-page responses); pagination remains driven by the `Link` header as before — `total_count` never replaces pagination links.
- Each page's list length must be ≤ 100 (GitHub's page cap).
- Malformed bodies are rejected safely: they never become empty lists, never authorize, and never leak partial data.
- Bounded pagination and the trusted `https://api.github.com` origin + exact-path checks on `Link` headers are preserved unchanged; an advertised next page that cannot be fetched or validated still fails closed with no partial list returned.

**Code changes (narrowly scoped):**

- `src/server/auth/github.ts` (+141/−29): new endpoint-aware parser `parseListPage(body, endpoint)`; `fetchAllPages` now takes a `ListEndpoint` (`'installations' | 'repositories'`) and applies the matching envelope; `listAccessibleRepositories` calls it with `'installations'`/`'repositories'`; the authorization service in `src/server/auth/authorization.ts` consumes the **same** `fetchAllPages` (no separate pagination implementation), so both surfaces share one parser and one failure semantics.
- Discovery behavior decision (documented, consistent with OpenSpec): installations whose App-level `permissions` lack `contents` access are **excluded from discovery entirely** (their repositories cannot be operated on through GitDatNote), while read-only installations (App `contents: "read"`, or user `pull` without `push`) remain listed with truthful read-only `canRead`/`canWrite` flags. `listAccessibleRepositories` changed accordingly (+141/−29 total includes this).

**Test fixture corrections (mocked GitHub responses now use the documented envelopes):**

- `tests/unit/server/auth.test.ts`: default discovery fixture now `{ total_count: 1, installations: [{ id: 111, account, permissions: { contents: 'write' }, suspended_at: null }] }`; no assertions weakened or removed.
- `tests/unit/server/authorization.test.ts`: the `GitHubScenario` fixture (and the integration harness's automatic envelope wrapping, plus raw-body override for malformed cases) now produce `{ total_count: N, installations: [...] }` / `{ total_count: N, repositories: [...] }`.
- `tests/unit/server/csrf.test.ts`: the shared `mockGithub` helper now returns documented envelopes for both endpoints (the CSRF suite's GitHub-dependent routes keep working).

**Eight explicit regression tests added** (`tests/unit/server/authorization.test.ts`, "GitHub list response envelope" describe block):

1. A valid installations envelope is accepted.
2. A valid repositories envelope is accepted.
3. Multi-page responses aggregate correctly (two pages per endpoint, `total_count` consistent across pages).
4. Missing or malformed envelope fields are rejected safely (`installations` field missing entirely; `installations` not an array; non-object body — each fails with `AuthError` code `INTERNAL`, never an empty list).
5. A bare array is not mistakenly accepted as a valid response.
6. Permission checks work with realistic GitHub response objects (authorized read on a read-capable repository; write denied on a user-read-only repository; write denied on an App-read-only installation — asserting the full `RepositoryAuthorization` object contract).
7. An authorized repository can be discovered and authorized using realistic mocks (discovery returns the exact repository entry; `authorizeRepository` returns `{ status: 'authorized', owner, repo, access: 'write' }`).
8. Untrusted pagination links still fail without partial success or token leakage (`next` link to a non-`api.github.com` origin → `DISCOVERY_LINK_UNTRUSTED`, zero entries returned, no token in the request).

**Vacuous discovery test corrected:** "omits repositories whose installation lacks contents permission entirely" previously looped over a result that could be empty (passing vacuously). It now asserts the exact repository count **and** the expected entries (excluded installation's repository absent; read-only installation's repository present with `canRead: true, canWrite: false`), so the test cannot pass on an empty result.

**Unchanged (preserved security architecture):** OAuth/PKCE/session handling; Task 3.3 CSRF middleware; the repository authorization interface; the dual user-plus-App permission requirement; fresh per-operation permission checks; GitHub HTTP error mapping; frontend connected/disconnected behavior; content-root configuration; unrelated dependencies/features; unrelated `.hermes/skills/` files. No commit, push, or archive; Task 3.5 not started.

### Local verification (no credentials configured)

Dev server + Vite as in Tasks 3.2/3.3: `GET /api/health` → 200; unauthenticated `GET /api/session` → `{"connected":false}`; unauthenticated `GET /api/repositories` → 401 `UNAUTHORIZED`; unauthenticated `GET` on a content path → 401 `UNAUTHORIZED` (authorization boundary); unauthenticated mutation on a content path → 401 `UNAUTHORIZED` (CSRF boundary first, per Task 3.3 — authorization is never reached for anonymous mutations). Without GitHub credentials configured, the UI shows the safe `auth_unconfigured` error view (no stack trace, no secrets); sample repository preview and Markdown rendering unchanged. "GitHub Connect still initiates exactly one navigation" was NOT verifiable live (no real App credentials in this environment); the route's failure path was verified instead and is safe. Server logs (structured JSON events) and the built client bundle contain no credentials, session IDs, or CSRF tokens. Live GitHub authorization was NOT performed; all GitHub-facing behavior is verified against mocks.

### Task boundary (deferred, untouched here)

- Future content-operation handlers: register in the dispatch table immediately after the `enforceContentBoundary` blocks in `src/server/index.ts`; replace the `sendApiNotFound` in the authorized branch with the real handler. The boundary (read/write by method, fresh check per request) remains the sole authorization gate; handlers must not re-implement CSRF or authorization.
- `canRead`/`canWrite` from `GET /api/repositories` is now truthful under the dual model and can drive the UI's read-only affordances (Task 3.6).
- No content-editing, publishing, or repository-creation functionality; no new public endpoint beyond the boundary seam; no App-level (installation) tokens; no changes to unrelated files.

### Files changed

Created: `src/server/auth/permissions.ts` (122 lines); `src/server/auth/authorization.ts` (251 lines); `src/server/middleware/repositoryAuth.ts` (151 lines); `tests/unit/server/authorization.test.ts` (1002 lines, 49 tests).
Modified: `src/server/auth/github.ts` (+71/−5: new strict `authorizationStatusError` mapper; discovery skips suspended installations, reads installation-level permissions, computes truthful `canRead`/`canWrite` via `effectiveRepoAccess`); `src/server/auth/types.ts` (+29: `InstallationInfo`, `InstallationRepositoryInfo`, `FORBIDDEN`/`NOT_FOUND` error codes); `src/server/auth/index.ts` (+16: exports for the new modules and types); `src/server/index.ts` (+42: authorization boundary wired in both dispatch branches ahead of the standard 404 fallthrough); `tests/unit/server/auth.test.ts` (+8/−1: default installation mock fixture now carries `permissions: { contents: 'write' }` and `suspended_at: null`); `openspec/changes/modernize-gitdatnote-foundation/tasks.md` (+1/−1: Task 3.4 marked complete with evidence); `openspec/changes/modernize-gitdatnote-foundation/audit.md` (+this section).

No commit, push, or archive performed; work remains on `feat/gitdatnote-2` at baseline `342bab7`. Unrelated local changes (`.hermes/skills/*` files and untracked Hermes scripts) preserved untouched.

## Task 3.5 — Secure token refresh lifecycle (GitHub App user tokens)

### Implementation summary

Task 3.5 required the missing GitHub App **user-token refresh lifecycle** plus security regression coverage for token rotation, single-use refresh tokens, and revocation. Scenarios already covered by earlier tasks (successful authorization, state mismatch, consent denied, expired pending session, missing/incorrect CSRF token including logout, unauthorized repository, session expiry, revocation mid-session) were verified present in `tests/unit/server/auth.test.ts`, `csrf.test.ts`, `authorization.test.ts`, and `session.test.ts` and were NOT duplicated. The genuinely missing behavior — the refresh lifecycle — is new: `src/server/auth/refresh.ts` (303 lines), a server-only service wired into the repository-discovery and repository-authorization paths.

### Verified GitHub refresh-token contract

Per the official GitHub App documentation (refreshing user access tokens; generating a user access token for a GitHub App), a GitHub App OAuth **user** access token (obtained with `scope=offline_access`) is refreshed with a server-side request:

- **Request:** `POST https://github.com/login/oauth/access_token` with `client_id`, `client_secret`, `grant_type=refresh_token`, `refresh_token`.
- **Success (200 JSON):** a NEW `access_token`, a NEW `refresh_token` (the previous pair is invalidated by GitHub), `expires_in` (seconds, typically 28800), `refresh_token_expires_in` (seconds; the docs document a fixed value of 15,897,600 = 184 days (approximately six months)), `scope`, `token_type`.
- **Failure:** HTTP 4xx with an error such as `bad_refresh_token` for a revoked/expired/already-rotated refresh token; the affected refresh token is unrecoverable and the session must require a new authorization.

The service uses the existing validated `GITHUB_APP_CLIENT_ID`/`GITHUB_APP_CLIENT_SECRET` (server-side only) and never transmits or returns credentials to the browser.

### Refresh service (`src/server/auth/refresh.ts`, 303 lines)

`createTokenRefreshService({ storage, authConfig, now, fetchImpl, logger })` returns a `TokenRefreshService` exposing `getValidAccessToken(sessionId): Promise<AccessTokenOutcome>` with the typed union `{ status: 'valid', accessToken } | { status: 'unauthorized' | 'rate_limited' | 'upstream_unavailable' }`.

**Behavior:**

1. Loads the session through the existing `SessionStorage.getSession` (encrypted record, same SQLite table — no schema change, no second table, no process-global credential cache).
2. If the access token is not expired (and not within the documented safety window — `REFRESH_SAFETY_WINDOW_MS = 60_000`), returns it without any network call.
3. Otherwise, checks refresh-token expiry LOCALLY first: an expired/missing refresh token invalidates the session (`deleteSession`) and returns `unauthorized` WITHOUT contacting GitHub.
4. Submits exactly one refresh request (see concurrency below) and validates the complete response: JSON object; `access_token` and `refresh_token` non-empty strings; `expires_in` numeric and positive; `refresh_token_expires_in` numeric and positive (defaulting to the documented 15,897,600 when omitted — GitHub omits it for classic-OAuth-issued tokens but the value is documented and stable).
5. Persists the rotated pair through the existing `rotateCredentials()` — both tokens re-encrypted with the existing AES-256-GCM scheme, both new expiry timestamps stored.
6. Returns the new access token to the server-side caller only. Never returned to the browser.

**Failure semantics (fail closed, typed, no retry storms):**

| GitHub / storage outcome | Service outcome | Session state |
|---|---|---|
| `bad_refresh_token` / HTTP 401 / HTTP 403 (genuine credential rejection, no rate-limit indication) | `unauthorized` | deleted — revocation is never recoverable, no retry |
| malformed 200 (missing access token, missing refresh token, zero/non-numeric expiry, non-JSON body) | `unauthorized` | deleted — a half-rotated credential set must not be used |
| transport failure or 5xx | `upstream_unavailable` | **preserved** — transient GitHub outage must not discard valid credentials |
| HTTP 429, or HTTP 403 with `X-RateLimit-Remaining: 0` | `rate_limited` | preserved — a rate limit is transient, not a rejection; callers retry per existing rate-limit mapping |
| session deleted/expired while refresh in flight | `unauthorized` | rotation result discarded (post-rotation re-check) — no token handed out for a dead session |
| `rotateCredentials` storage failure | `unauthorized` | deleted — fail closed; never trust an unverified rotation |
| session lookup failure | `unauthorized` | no crash, no credential in the error path |

### Token rotation and encryption behavior

Rotation goes exclusively through `SessionStorage.rotateCredentials()`: the stored record is replaced in place with the new access token, new refresh token, and both new expiry timestamps, re-encrypted with the session encryption key (AES-256-GCM via the existing crypto layer). The original refresh token is overwritten at rest and is never used again (verified by reloading the session from disk after rotation). No plaintext credential is logged; the structured logger only receives stable event names and reason codes.

### Concurrent refresh protection (single-flight)

A per-session in-flight `Map<sessionId, Promise<AccessTokenOutcome>>` serializes refreshes for the same session within the single-process Node server:

- The first caller for an expired session creates the in-flight promise; concurrent callers for the same session **await the same promise** and receive its result.
- Exactly ONE refresh request reaches GitHub per refresh event (verified with deferred mock responses: two simultaneous callers → one recorded token-endpoint call).
- On success, ALL callers receive the rotated token; on failure, ALL callers receive the same typed failure and the session is invalidated once.
- The in-flight record is removed after the promise settles (success or failure); a later call with a still-valid token makes no request; a later call after a failed refresh makes no further GitHub request (the session is already gone).
- A stale rotation cannot overwrite newer credentials: after `rotateCredentials` the service re-checks the session; if the session no longer exists or is expired, the rotation result is discarded and the caller is unauthorized.
- Independent sessions never share refresh state (separate Map entries).

**Documented boundary:** this coordination is in-process memory. The current application is a single-process Node server; the design does not claim cross-process or cross-instance safety and intentionally avoids distributed locks, Redis, or background workers.

### Integration points

- **`src/server/auth/routes.ts` — `handleSession`:** when the session exists but BOTH the access token and the refresh token are expired, the session is now invalidated server-side and the endpoint reports `connected: false` — it never reports a usable connection for irrecoverably dead credentials. Otherwise behavior is unchanged (`connected`, non-secret identity, per-session CSRF token).
- **`src/server/auth/routes.ts` — `GET /api/repositories`:** the token is obtained from the refresh service instead of the raw stored credential. `rate_limited` → `429 RATE_LIMITED`; `upstream_unavailable` → `502 GITHUB_UNAVAILABLE`; any non-`valid` outcome → `401 UNAUTHORIZED`. A definitive GitHub 401 (401 Bad Credentials) on a protected request additionally invalidates the session server-side — a subsequent `GET /api/session` reports disconnected — while repository permission denials (403), rate limits, and upstream outages never invalidate. Pagination, envelope validation, and permission-flag computation are unchanged. When no refresh service is configured (`refresh === null`), the pre-existing behavior (stored token) applies.
- **`src/server/middleware/repositoryAuth.ts` — content boundary:** after the session gate, the middleware obtains the current access token via the refresh service and builds the session record passed to `authorizeRepository` with the refreshed token. The user-plus-App permission intersection, fresh per-operation checks, selected-repository installation checks, CSRF boundary, and status mapping are all preserved unchanged; no privileged installation token is introduced. A definitive GitHub 401 (401 Bad Credentials) on a protected request invalidates the session at this boundary too — subsequent `GET /api/session` reports disconnected, unrelated sessions remain valid, and 403 permission denials, rate limits, and outages never invalidate.
- **`src/server/index.ts`:** the service is constructed only when both auth config and session storage are available; `handleSession` is now awaited with an error handler (it became async).
- **`src/server/auth/index.ts`:** barrel exports for the new service and its types.

Ordinary unauthenticated requests never touch the refresh service.

### Test evidence (`tests/unit/server/token-refresh.test.ts` — 42 tests, 1,336 lines)

All tests are deterministic: temporary SQLite databases, injected clocks, and a mock `fetch` that records every token-endpoint call (with deferred responses for concurrency). No real GitHub credentials exist in the file — all credential-shaped values are obviously fake constants — and NO live GitHub refresh was performed.

**Success (8):** valid access token → no refresh request; expiry just beyond the safety window → no refresh; within the safety window → refresh; expired access token → documented endpoint and parameters on the wire; both credentials rotated with new expiry timestamps persisted and reloaded from storage; `refresh_token_expires_in` default applied when omitted; original refresh token never reused after rotation; still-valid rotated token → no further refresh.

**Failure (18):** missing refresh token → invalidated without contacting GitHub (defense-in-depth guard, exercised via a simulated record since storage rejects empty tokens on write); expired refresh token → invalidated before any request; `bad_refresh_token` → session deleted, no retry; HTTP 401 → session deleted; HTTP 403 (genuine credential rejection, no rate-limit indication) → session deleted; HTTP 403 with `X-RateLimit-Remaining: 0` → `rate_limited`, session preserved; five malformed-200 shapes (missing access token, missing refresh token, zero `expires_in`, non-numeric `expires_in`, non-JSON body) → session deleted; transient transport failure → session preserved (`upstream_unavailable`); transient 5xx → preserved; 429 → `rate_limited`, preserved; session deleted during refresh → unauthorized, rotation discarded; session expired during refresh → unauthorized, rotation discarded; database rotation failure → fail closed (session deleted); session lookup failure → no crash, no leak.

**Concurrency (6):** two concurrent refreshes of the same expired session → exactly ONE GitHub call; both callers get the rotated credential; a failed shared refresh leaves BOTH callers unauthorized and the session gone; a failed refresh cannot leave one caller authorized with stale credentials; independent sessions do not share refresh state; in-flight record removed after success (next valid call: no request) and after failure (no further GitHub requests).

**Log safety (1):** success and rejection paths never log token or secret values.

**Integration (9), real HTTP app over ephemeral ports with full OAuth sign-in:** valid access token → no refresh request at discovery; expired access token → exactly one refresh and the ROTATED token used for the subsequent repository request; session with both tokens expired → disconnected and invalidated; rejected refresh (`bad_refresh_token`) during discovery → 401 and session invalidated; transient refresh failure (503) → 502 and session preserved; unauthenticated `/api/repositories` → 401 with zero token-endpoint calls; no credential values in HTTP error bodies or server logs on a rejected refresh; plus 2 review-correction flow tests — a definitive 401 Bad Credentials on a protected request returns 401 and invalidates the session at BOTH the repository-discovery and the content-authorization boundary (subsequent `GET /api/session` reports disconnected), while an unrelated sibling session remains connected and usable.

### Verification gates

- `npm run lint` — 0 errors.
- `npm run typecheck` — 0 errors (both `tsconfig.web.json` and `tsconfig.server.json`).
- Focused suite — 42/42 passing.
- `npm run test` — **562/562** across 17 files (520 baseline + 42 new; no assertions weakened, no tests removed).
- `npm run build` — exit 0; `npm run build:server` — exit 0.
- `npm run test:e2e` — 10/10 Chromium.
- `npm audit` — 0 vulnerabilities.
- `openspec validate modernize-gitdatnote-foundation` — valid (2 pre-existing spec-length warnings, unchanged).
- `git diff --check` — clean.

### Local verification (no credentials configured)

Dev server + Vite launched without GitHub credentials (none available in this environment): `GET /api/health` → `{"status":"ok"}`; unauthenticated `GET /api/session` → `{"connected":false}`; unauthenticated `GET /api/repositories` → 401 `UNAUTHORIZED`; unauthenticated `POST /api/session/logout` (with and without a bogus CSRF header) → 401 (CSRF boundary intact); disconnected UI renders ("Not connected to GitHub" + Connect button); Connect GitHub → exactly one in-app navigation to the safe `auth_unconfigured` error view (no secrets, no stack trace); sample repository preview renders through the safe Markdown pipeline (DOM verified: rendered list/blockquote/paragraph, zero `<script>` elements, no inline event handlers); the built client bundle contains no credential or secret strings; server logs contain only structured events and reason codes — no tokens, secrets, or credential values. Live GitHub refresh was NOT performed; all GitHub-facing refresh behavior is verified against deterministic mocks.

### Known limitations

- Refresh coordination is in-process (single-flight Map). If the server were ever run as multiple processes behind one database, two processes could each submit the same refresh token; the second would receive GitHub's rejection and fail closed (session deleted) — safe but disruptive. The current deployment is single-process.
- `refresh_token_expires_in` defaults to the documented fixed 15,897,600 s when GitHub omits it; a future GitHub change to that documented value would silently shift the expiry used for local pre-checks (the refresh request itself would still fail safely via GitHub's rejection).
- A revoked ACCESS token is detected on the next authenticated GitHub call: that call fails with 401 and — since the Task 3.5 review correction — the session is invalidated server-side (subsequent `GET /api/session` reports disconnected) at both repository discovery and the content authorization boundary; 403 permission denials, rate limits, and upstream outages never invalidate. Refresh itself only triggers on local expiry, per the documented contract.
- Live end-to-end refresh against real GitHub credentials was not exercised (no real App credentials in this environment); behavior is verified against the documented contract with mocks.

### Task boundary (deferred, untouched here)

- No Task 3.6 (connect/disconnect UI) or Task 3.7 (broader security audit) work.
- No repository content read/write operations, no article publishing, no GitHub App installation management, no scheduled refresh jobs, no user account management.
- No new dependencies, no distributed lock/Redis/background worker, no SQLite schema change, no OAuth/PKCE/CSRF/cookie/encryption redesign.
- No commit, push, or archive performed.

### Files changed

Created: `src/server/auth/refresh.ts` (303 lines); `tests/unit/server/token-refresh.test.ts` (1,336 lines, 42 tests).
Modified: `src/server/auth/routes.ts` (+84/−18: refresh-service integration in `handleSession` and repository discovery; dual-expired invalidation); `src/server/middleware/repositoryAuth.ts` (+30/−2: refreshed token fed into the authorization step); `src/server/index.ts` (+20/−2: service construction, dependency wiring, async `handleSession` handling); `src/server/auth/index.ts` (+7: barrel exports); `openspec/changes/modernize-gitdatnote-foundation/tasks.md` (+1/−1: Task 3.5 marked complete with evidence); `openspec/changes/modernize-gitdatnote-foundation/audit.md` (+this section).

No commit, push, or archive performed; work remains on `feat/gitdatnote-2` at baseline `70d3b73`. Unrelated local changes (`.hermes/skills/*` files and untracked Hermes scripts) preserved untouched.

## Task 3.6 — GitHub connection and disconnection UI

### Summary

Task 3.6 turns the existing authentication infrastructure into a coherent, accessible connect/disconnect experience: a working Disconnect action, correct authenticated-session transitions, and complete, understandable error states. All of it is built on top of the accepted Task 3.5 baseline (`95d54e5`) without touching server-side security behavior, content operations, or any Task 3.7/Phase 4 work.

### Existing functionality reused (not rewritten)

- Connect GitHub button performing exactly one top-level navigation to `GET /api/auth/github/start` (verified live: the button click produces a single navigation; the server 302s to the safe `auth_unconfigured` error view when App credentials are absent).
- Session probing via `GET /api/session` and the connected/disconnected/error state machine in `App.tsx`.
- The accessible `<select>` repository selector with its existing label, keyboard operation, and `canRead`/`canWrite` labels (read-only repositories remain selectable but clearly labeled).
- Empty, loading, and retryable repository error states (Retry preserved for retryable failures).
- The safe `/error?reason=...` page with fixed messages that never reflects unknown query values.
- The sample-data preview, still explicitly labeled ("Preview — sample data only. This is not a live GitHub connection.") and independent of real authentication.
- The existing `ApiError`/`ErrorDetail` mapping contract and the shared `src/shared/errors.ts` helpers.

### New behavior: the Disconnect action

- `ApiClient.disconnectGithub(csrfToken)` in `src/web/api.ts` (typed, part of the API client — nothing bypasses it): `POST /api/auth/logout`; the CSRF token is sent **exclusively** in the `X-CSRF-Token` header (never in the query string, request body, or cookie; no second CSRF mechanism); the session cookie rides along through same-origin request behavior; HTTP 204 with no body is success; non-success responses are mapped into the existing `ApiError`/`ErrorDetail` contract (bare `ErrorDetail` bodies from the CSRF boundary are handled, not just envelopes); network failures map to a `NETWORK` detail. The token is never logged, displayed, or persisted.
- **Malformed/incomplete session rule:** a connected session without a usable CSRF token must not issue an unprotected logout. `disconnectGithub(undefined)` throws a `BAD_REQUEST` `ApiError` before any network request, and the UI simply offers no Disconnect action for such a session (with a fixed explanatory note) instead of manufacturing a token.
- `src/web/types.ts` adds `SessionUser` (`login`, optional `name`/`avatarUrl`) and `SessionState` (`connected`, `user`, optional `csrfToken`) plus a state-machine docstring; stale comments describing backend APIs as unimplemented were updated where they now exist.

### Connection and logout state transitions

- Connected view (`ConnectedView.tsx`) renders the user's GitHub login, display name (when supplied), an avatar gated by `safeAvatarUrl` (https-only on the GitHub avatar host; anything else is dropped, and no `onerror`/`onload` handlers are ever emitted), a clear "Connected to GitHub" status, the repository selector, and a Disconnect button.
- Disconnect interaction: the button enters an accessible pending/disabled state (no duplicate requests — a second click while pending is ignored); on success `App.handleDisconnected` clears the identity, the selected repository, and the repository list, and transitions to the disconnected view **without a page reload**.
- **Stale-response protection:** a generation ref is incremented on disconnect; in-flight repository and session responses that resolve afterward are discarded, so late responses cannot restore the old connected UI (test: late repository response cannot resurrect connected content).
- **Definitive session loss:** a `401 UNAUTHORIZED` on logout (or a bare 404) means the session is no longer valid server-side; the frontend reconciles into the disconnected state rather than showing a failure. `detail.code` is preferred over the HTTP status alone (`UNAUTHORIZED` is the shared session-gone code).
- **CSRF rejection is NOT a logout:** a `403 CSRF_INVALID` is returned by the centralized CSRF boundary (`src/server/middleware/csrf.ts`) when the token is missing, malformed, or does not match the session. That response does **not** delete the server-side session, so it must not transition the UI to disconnected and must not be shown as "Disconnected" while the server may still hold a valid session. Instead the view stays connected, shows a safe fixed explanation ("Your GitHub connection is still active."), and offers a **Recheck session** action: it re-probes `GET /api/session`, which returns the stored (possibly fresh) CSRF token, and a subsequent logout uses that token. The rejected token is never resent — there is no plain "Disconnect" retry in the CSRF-failure state. Other 403 errors likewise do not imply session invalidation and keep the plain retry.
- **Failed logout** (other errors: 429, 5xx, network): a safe, fixed message in `role="alert"` with retry; the UI never claims the server session was deleted and never shows a misleading success state.

### Error and recovery handling

No new error-management framework. The existing distinct OAuth reasons (not configured, denied, invalid/expired/used state, token-exchange failure, profile failure), the safe error page, the session-expiry reconnection path, and retryable repository errors (429 and 5xx keep their distinct messaging and Retry — never presented as credential revocation) are preserved and verified by tests. The logout failure path adds one safe fixed message distinct from all of them.

### Accessibility

- Semantic `<button>` elements with clear labels; visible 2px keyboard focus outline (verified live with a real Tab keypress).
- `role="status"`/`aria-live="polite"` for pending/success transitions; `role="alert"` for actionable failures.
- Disabled/pending controls expressed via `disabled` + label text, never color-only.
- Readable contrast in light and dark schemes (dark verified live: `rgb(20,20,20)` background / `rgb(242,242,242)` text); responsive without horizontal overflow at 390 px and 1280 px.

### Tests added (25 new; deterministic, no live GitHub credentials)

- `tests/web/api.test.ts` (+10): logout calls `POST /api/auth/logout` with the token only in `X-CSRF-Token` (fetch called exactly once; no query/body/cookie token); 204 empty-body succeeds; missing CSRF fails safely **before any network request**; 401/403/429/500/502 and network failures map into the `ApiError` contract without leaking raw error text; a connected session without a CSRF token still renders connected (`state.connected === true`, no error).
- `tests/web/components.test.tsx` (+15): App-level flow via a dependency-injected client — initial loading state; disconnected view; successful connected session with user identity (login, name, avatar; non-https and cross-origin avatar URLs are dropped and no `onerror`/`onload` attributes appear); connected user with repository `<select>` selection; successful logout clears identity, selection, and repository list (exactly one request); double-click disconnect sends only one request; pending logout is communicated accessibly; **logout 401 transitions to the disconnected state; logout 403 `CSRF_INVALID` does NOT transition to disconnected (identity remains, no "Disconnected" claim, the rejected token is never resent, and a session-recheck recovery action is offered); after a CSRF rejection, rechecking the session yields a fresh token and a subsequent logout succeeds with it; after a CSRF rejection, rechecking a gone session reconciles to the disconnected view (rejected token never resent); a late repository response cannot restore stale connected content; the sample preview is labeled and never implies real authentication.
- All 26 pre-existing web tests in `api.test.ts`/`components.test.tsx` preserved unchanged (plus the untouched `hardening` and `markdown` suites); no assertions weakened; no tests removed. One earlier test that asserted a plain "Disconnect" retry after a 403 CSRF rejection (which would resend the rejected token) was corrected to the behavior above.

### Review correction (post-report, same day)

Independent review flagged one incorrect logout state transition: the original report claimed both HTTP 401 and HTTP 403 logout responses transition the UI to disconnected. That is wrong for 403: the centralized CSRF boundary (`src/server/middleware/csrf.ts`) answers logout rejections with `403 CSRF_INVALID` **without deleting the server-side session**, so the UI must not display "Disconnected" while the server may still hold a valid session.

Corrections made:

- `isSessionLost()` in `ConnectedView.tsx` now prefers the shared error code (`UNAUTHORIZED`) over HTTP status alone; a 403 `CSRF_INVALID` (and any other 403) never reconciles to the disconnected state.
- The 403 `CSRF_INVALID` failure state no longer offers a plain "Disconnect" retry (which would resend the same rejected token indefinitely). It shows a safe fixed explanation ("Your GitHub connection is still active.") and a **Recheck session** action wired to `App.loadConnection`: it re-probes `GET /api/session`, the still-valid session returns its stored (possibly fresh) CSRF token, and a subsequent logout uses that token; if the session has genuinely gone, the recheck reconciles to the disconnected view.
- New regression tests: 403 does not transition to disconnected + no resend of the rejected token + recovery action offered; recheck yields a fresh token and the next logout succeeds with it (`toHaveBeenLastCalledWith(FRESH_TOKEN)`); recheck of a gone session reconciles to disconnected with the rejected token never resent. The earlier test asserting a plain retry after 403 was corrected (not weakened elsewhere).
- Gates re-run after the correction: typecheck 0, full Vitest **587/587** across 17 files (562 baseline + 25 new web tests), both builds exit 0, e2e 10/10, `npm audit` 0, `openspec validate` valid, `git diff --check` clean.

### Verification gates (run from the repository root, after a clean `npm ci`)

- `npm ci` — clean install.
- `npm run lint` — 0 errors, 0 warnings.
- `npm run typecheck` — 0 errors (web and server configs).
- `npm run test` — **587/587** across 17 files (562 baseline + 25 new web tests for Task 3.6).
- `npm run build` — exit 0; `npm run build:server` — exit 0.
- `npm run test:e2e` — 10/10 Chromium (Playwright 1.64.1; the headless-shell 1248 browser had to be reinstalled in this environment — the failure was "Executable doesn't exist", an environment issue, not a code regression).
- `npm audit` — 0 vulnerabilities.
- `openspec validate modernize-gitdatnote-foundation` — valid (2 pre-existing spec-length warnings, unchanged).
- `git diff --check` — clean.
- Node 24/26 compatibility: unchanged from the Task 3.5 baseline (no new dependencies, no engine changes).

### Local browser verification (no credentials configured)

Live against `npm run dev:server` + `npm run dev` at `http://localhost:5173`:

1. Disconnected state renders ("Not connected to GitHub" + Connect button + sample-preview button).
2. Connect GitHub performs exactly one top-level navigation (button click → `GET /api/auth/github/start`; verified the 302 redirect to `/error?reason=auth_unconfigured`).
3. Without GitHub App credentials, the safe `auth_unconfigured` error view appears ("GitHub sign-in is not configured for this GitDatNote instance…").
4. The "Return to GitDatNote" link returns to `/` and the disconnected state re-renders.
5. The sample preview is clearly labeled and never implies a live connection.
6. Sample Markdown renders sanitized (DOM verified: no `<script>`, no inline handlers, no dangerous link schemes).
7. No horizontal overflow at 390 px (mobile) or 1280 px (desktop).
8. Keyboard Tab moves focus with a visible 2px solid outline.
9. Dark scheme is usable (verified computed colors + screenshot); light scheme is the default.
10. No credentials or session IDs in page source or rendered text (only the word "tokens" in explanatory copy); `document.cookie` is empty (the session cookie is HttpOnly); the web code contains zero `console.*` calls, so no credential-shaped console output is possible.

Because actual GitHub App credentials are not configured, connected-state rendering and logout behavior were verified with deterministic mocked HTTP integration and React tests, not live GitHub. **No live GitHub authorization or logout was performed or claimed.**

### Known limitations

- The connected UI (identity, Disconnect, logout states) is verified against mocks; a real OAuth round-trip end-to-end in the browser requires live App credentials that this environment does not have.
- The `SessionState.csrfToken` optionality reflects the backend contract (`GET /api/session` always supplies it for a valid session); a connected session without it is treated as malformed and handled by refusing logout, per the task requirement.
- Avatar display is limited to https URLs on the GitHub avatar host; other supplied avatar URLs are silently omitted (no fallback, no referrer leak).

### Task boundary (deferred, untouched here)

- No Task 3.7 (bundle/log credential audit) work.
- No content editor, publishing capability, repository writes, or content APIs.
- No token refresh moved into the browser; no localStorage/sessionStorage persistence; no browser-side privileged GitHub calls; no OAuth credentials in JavaScript state or client bundles.
- No new dependencies, no architectural redesign, no server-side security behavior changes.
- No commit, push, or archive performed.

### Files changed

- `src/web/api.ts` (+105/−6): `disconnectGithub` method, bare-`ErrorDetail` parsing for logout responses, session-without-CSRF refusal, stale-comment updates.
- `src/web/types.ts` (+20/−11): `SessionUser`, `SessionState`, state-machine docstring.
- `src/web/components/ConnectedView.tsx` (+235/−19): connected identity (login/name/safe avatar), "Connected to GitHub" status, Disconnect button with pending/disabled states, logout failure alert, CSRF-failure recovery ("Recheck session" action — no resend of the rejected token), no-CSRF note, `session`/`onDisconnected`/`onRecheckSession` props.
- `src/web/App.tsx` (+30/−10): `handleDisconnected` (generation bump + state clear), connected-view wiring including `onRecheckSession={loadConnection}`, state-transition updates.
- `src/web/components/DisconnectedView.tsx` (+6/−1): plain-language copy (no personal access tokens; can disconnect).
- `src/web/index.css` (+84/−0): identity/avatar/disconnect/logout-status/logout-error/logout-recovery-note styles, `.btn-secondary`, dark-scheme variants.
- `tests/web/api.test.ts` (+167/−0): 10 new API-client tests.
- `tests/web/components.test.tsx` (+486/−2): 15 new App-level connection-flow tests (including the 403 `CSRF_INVALID` no-transition and session-recheck recovery tests added by the review correction).
- `openspec/changes/modernize-gitdatnote-foundation/tasks.md` (+1/−1: Task 3.6 marked complete with evidence).
- `openspec/changes/modernize-gitdatnote-foundation/audit.md` (+this section).

No commit, push, or archive performed; work remains on `feat/gitdatnote-2` at baseline `95d54e5`. Unrelated local changes (`.hermes/skills/*` files and untracked Hermes scripts) preserved untouched.

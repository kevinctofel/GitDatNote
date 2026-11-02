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

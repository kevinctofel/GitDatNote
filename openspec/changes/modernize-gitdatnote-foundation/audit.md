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

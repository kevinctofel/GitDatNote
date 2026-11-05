# Tasks: Design GitDatNote 2.0 UI/UX

Task ordering respects the foundation change's phases. Phases 1–2 are backend-independent (implementable as soon as `src/web/` exists from task 2.5); later phases unlock as foundation tasks land. Each task is independently verifiable.

## Phase 1 — Design tokens and theming (backend-independent)

- [ ] 1.1 Implement `src/web/theme/`: CSS custom properties for all tokens in design.md §3 (neutral light/dark scales, six palettes with `--accent` and `--accent-strong` values, state colors, typography, spacing, radii, shadows) plus a TypeScript token module exporting the same values for assertions. Verify: `tsc` passes; every referenced token has a light and dark value.
- [ ] 1.2 Add contrast tests (Vitest) asserting, for every palette × mode: primary-button label on `--accent-strong` ≥ 4.5:1, body text on `--surface-panel` ≥ 4.5:1, `--accent` icon/large text on surfaces ≥ 3:1, and focus ring ≥ 3:1 against adjacent colors. Verify: tests pass and encode the measured values.
- [ ] 1.3 Implement the appearance state store (`gitdatnote.appearance.v1` in localStorage): mode (light/dark/system) and palette as independent settings; system mode tracks `matchMedia('(prefers-color-scheme: dark)')` live; graceful in-memory fallback when storage is unavailable (no throw, no repeated writes). Verify: unit tests cover round-trip persistence, fallback, and live system-mode change.
- [ ] 1.4 Build the Appearance tab within the Settings hub (design.md §5.5): horizontal settings nav (General/Appearance/Publishing/GitHub/About), three-card theme picker (line icons + selection ring), circular accent swatches (selection ring + label), current-selection indication, immediate whole-app preview, keyboard operable. Verify: manual + unit tests — selection persists across reload, fallback mode works, focus ring visible in both modes.

## Phase 2 — Application shell (after task 2.5)

- [ ] 2.1 Implement the app shell per design.md §5.1: sidebar (desktop), icon rail + drawer (tablet), top bar + drawer (mobile), brand block (pen-nib logo + "GitDatNote" wordmark), primary nav (Articles, Drafts, Published — counter badges), secondary nav (Sites, Settings, Help), and bottom user profile (avatar + login name). Verify: renders at 320/768/1024/1280 with no horizontal overflow; keyboard nav works.
- [ ] 2.2 Implement the site/repository selector consuming `GET /api/repositories` (foundation task 3.4 when available; before that, a clearly nonfunctional placeholder labeled "Repositories available after GitHub connection"): list, selected state, read-only badge when `canWrite` is false, loading/error states. Verify: unit tests with mocked fetch; read-only flag disables write affordances app-wide.
- [ ] 2.3 Implement not-connected state: minimal nav + "Connect GitHub" action (routes to onboarding once Phase 5 lands; placeholder link until then). Verify: no privileged routes reachable while `GET /api/session` returns 401.
- [ ] 2.4 Shell accessibility pass: landmarks, focus order, focus-visible ring, Escape closes drawers with focus restore. Verify: keyboard-only walkthrough; contrast of nav text in all palette/mode combinations.

## Phase 2P — Front-matter capability prerequisite (shared module; blocks Phases 3 & 4)

The UI read/write flows depend on front-matter capabilities the shared module does not yet have. `src/shared/frontMatter.ts` currently implements `buildFrontMatter` only (it serializes a fixed `title`/`description`/`date`/`tags` set); it does **not** parse front matter, emit a `draft` field, or preserve other fields. This prerequisite must complete before Phase 3 (dashboard parse) and Phase 4 (editor save/publish) can rely on it. It is **separately scoped** and is **not** marked implemented by this design change.

- [ ] 2P.1 Extend the shared front-matter module (or add a sibling shared module) to support the UI's read and write flows:
  - Safe parsing of existing Markdown front matter (parse the leading `---` YAML block into metadata + body without executing/evaluating; reject unsafe control characters; preserve the body exactly).
  - Draft/published status serialization: represent `draft: true/false` (draft = `true`; absent or `false` = published) in the serialized front matter.
  - Preservation of unrelated metadata on edits: parse all front-matter fields and re-emit any fields outside the known set unchanged, so editing title/description/date/tags/status does not drop other Eleventy fields.
  - Compatibility with existing SecondBrain/Eleventy content (faithful round-trip of existing posts' front matter, including their date formats and any extra fields).
  - Round-trip regression tests (parse → build → parse yields equivalent metadata; control-character and traversal edge cases).
  Verify: unit tests pass; a fixture of a real SecondBrain/Eleventy post round-trips without losing fields. **Do not assume the current `buildFrontMatter` supports parsing, draft, or preservation — it does not.**

## Phase 3 — Article dashboard (after foundation 4.2)

- [ ] 3.1 Implement article list: fetch content-root directory via `GET /api/repos/{owner}/{repo}/content?path=`, read each Markdown child, parse front matter using the **safe parser from prerequisite task 2P.1** (the shared `frontMatter.ts` currently serializes only), render rows (article icon, title, excerpt, status badge, "Article date", ⋯ action menu) and a sort control. Verify: unit tests with fixture files; row fields match design.md §5.2.
- [ ] 3.2 Implement filter tabs (All/Drafts/Published) and client-side search over loaded articles. Verify: filtering/search correct for mixed draft/published fixtures; no-match state with clear search action.
- [ ] 3.3 Implement "New Article" (POST content, front matter generated by shared module, `X-CSRF-Token`) and per-article action menu with Edit (read file, open editor with blob SHA). Verify: create flow works against the local API in dev; 409 `FILE_EXISTS` surfaces a field error.
- [ ] 3.4 Implement all dashboard states per design.md §5.2: skeleton loading, empty repository, no repositories, search no-match, read-only repository, access revoked, GitHub unavailable (banner + retry per envelope `retryable`). Verify: each state triggered in a component test; retry only shown when `retryable`.
- [ ] 3.5 Keyboard navigation: semantic focusable rows (each a real link/button), Tab moves between rows, Enter/Space opens, ⋯ menu keyboard-reachable (roving-tabindex deliberately avoided). Verify: keyboard-only walkthrough passes.

## Phase 4 — Markdown editor (after foundation 4.3/4.4)

- [ ] 4.1 Implement editor layout per design.md §5.4: header (breadcrumbs, status pill, save-status indicator, Preview toggle, split Publish), prominent title input, Markdown writing canvas (mono 17px/1.75, 70ch, dominant), the approved initial formatting toolbar (Bold, Italic, Insert Link, Insert Image), collapsible inspector (Details/SEO/Options tabs; overlay on tablet/mobile). Verify: layout checks at all breakpoints; inspector overlay opens/closes with focus management.
- [ ] 4.2 Implement sanitized preview: `marked` → `DOMPurify` allowlist → scoped element (never `innerHTML` of raw Markdown). Verify: XSS regression vectors from foundation task 2.7 fail to execute in preview; safe Markdown (headings, links, images, code) renders.
- [ ] 4.3 Implement save and publish: POST (new) / PUT (existing, `expectedSha`) with CSRF header and shared front-matter generation (**status/draft serialization from prerequisite task 2P.1**); publish = save with status flipped. Verify: save updates the file (dev API); publish changes status front matter; buttons disabled while in flight; success/failure banners announced.
- [ ] 4.4 Implement editor error states per design.md §5.4: unsaved indicator + beforeunload + in-app nav guard; saving/saved/failed-save; network interruption; revoked access (write disabled, content preserved); `409 SHA_CONFLICT` dialog with reload (using `currentSha`) — no automatic merge. Verify: conflict dialog reachable in a component test with a mocked 409.
- [ ] 4.5 Implement inspector Details fields (description, article date, slug with generation, removable tag pills, aspect-locked featured-image control clearly disabled until the image API exists) plus SEO/Options tabs (structural), keyboard shortcuts (`Ctrl/Cmd+S` save, `Ctrl/Cmd+B`/`I` bold/italic, `Ctrl/Cmd+K` insert/edit link, focus-free toggle — **no publish shortcut**; `Ctrl/Cmd+P` stays reserved for the browser's Print, and publish is a labeled control), and preview with accent-styled H1/H2 headings and external links `target="_blank"` + `rel="noopener noreferrer"`. Verify: shortcut tests; focus-free mode removes chrome and restores it.
- [ ] 4.6 Responsive editor: metadata overlay on <1024px, top-bar wrap on mobile, no overflow at 320px. Verify: layout checks at 320/768/1024.

## Phase 5 — GitHub onboarding (after foundation 3.2/3.4)

- [ ] 5.1 Implement the four-step split-panel flow per design.md §5.3: Connect (GitHub logo, accent "Connect GitHub" CTA with external-link icon, trust microcopy with lock icon; `GET /api/auth/github/start`) → Choose repository (list with read-only flags) → Configure site (content-root input validated client-side; image directory default `Images/`; ownership statement; site-config persistence is a future backend/API dependency — placeholder until a config endpoint exists) → You're ready. Verify: step progression and validation in component tests; content-root validation rejects absolute/traversal/null-byte paths via shared rules.
- [ ] 5.2 Implement onboarding error states: authorization canceled, missing App, no eligible repositories, read-only, invalid content root, GitHub API failure, returning user (skip to dashboard with pre-fill), previously configured sites, revoked permissions. Verify: each state rendered from a mocked API response; no state claims success without a server response.
- [ ] 5.3 Implement onboarding completion for **both** states — (a) **placeholder state (no endpoint):** step 3/4 render a visual placeholder (selection summary) and open the dashboard with the repository selected, with **no persistent site configuration claimed and no success message implying persistence**; (b) **fully functional happy path (endpoint available):** persist the configuration via the endpoint and show a success reflecting the real save. Verify: in the placeholder state no false success/invented persistence is shown; once the endpoint is available, the configured site appears selected on the dashboard after confirm.

## Phase 6 — Image management UX (nonfunctional until the image API)

- [ ] 6.1 Implement the Insert Image dialog (Upload / From repository / From URL tabs) per design.md §8: fully built as UI, with Upload and From-repository tabs **clearly disabled and labeled unavailable** until the image-management API exists; the URL tab may function (inserts `![alt](url)` at the cursor). Verify: disabled tabs are visually distinct and announced; no control implies a successful upload; URL insertion produces valid Markdown.
- [ ] 6.2 Implement the image metadata controls (alt text with decorative-image option, caption, filename, dimensions, size, preview) as part of the dialog, inert until the API lands. Verify: decorative vs. informative alt produces the correct Markdown (`alt=""` vs. text).
- [ ] 6.3 Render existing Markdown images in the sanitized preview (allowed `<img>` per the DOMPurify allowlist, safe src only). Verify: relative-path and http(s) images render; `javascript:`/local-file `src` values are stripped.

## Phase 7 — Responsive and accessibility hardening

- [ ] 7.1 Responsive pass across all screens at 320/768/1024/1280: no horizontal overflow, no hover-dependent functions, touch targets ≥24px (primary ≥44px mobile), 200% zoom intact. Verify: scripted layout checks + manual pass.
- [ ] 7.2 WCAG 2.2 AA acceptance pass against design.md §9: keyboard-only walkthrough, focus visibility, labels, contrast assertions, `aria-live` announcements, reduced-motion behavior, no color-alone information. Verify: checklist documented in the change's `audit.md`; failing items fixed before marking the task done.
- [ ] 7.3 Extend the Playwright E2E suite (foundation task 5.2) with UI acceptance scenarios: dashboard list/filter/search, editor save/publish, theme persistence, onboarding step validation, image dialog states. Verify: E2E runs green in CI.

## Phase 8 — Documentation and closeout

- [ ] 8.1 Update README/docs: appearance settings, accent palettes, editor shortcuts, image-management status ("deferred until image API"). Verify: docs match implemented behavior.
- [ ] 8.2 Record that `docs/Design/GitDatNote 2.0 UI Showcase.png` (primary visual authority) and `docs/Design/GitDatNote 2.0 Vision Analysis.txt` (supporting vision analysis) are **already committed to the development branch** (tracked in Git). Verify: both are tracked and unmodified (hash-checked before/after); neither is regenerated, edited, or moved by this correction.

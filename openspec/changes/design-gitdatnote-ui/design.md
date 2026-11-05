# Design: GitDatNote 2.0 UI/UX

## 1. Visual direction

**Approved direction: Balanced C + D** — an efficient, structured, Linear-inspired publishing dashboard combined with a calm, spacious, distraction-free Markdown writing experience. Distinctive GitDatNote branding, restrained lavender/purple accents, soft neutral backgrounds, subtle decoration. Rounded panels, consistent spacing, clear typography. The interface reads as a modern publishing tool, not a traditional cluttered CMS.

**Canonical visual reference:** `docs/Design/GitDatNote 2.0 UI Showcase.png` (repository-relative). The mockup illustrates four primary screens: (1) article dashboard, (2) Markdown article editor, (3) GitHub onboarding, (4) appearance settings. It establishes composition, hierarchy, spacing, and visual personality and must be preserved; it is a design reference, **not** a pixel-perfect implementation requirement.

> **Visual authority:** the approved mockup at `docs/Design/GitDatNote 2.0 UI Showcase.png` is the **primary visual authority**; a Gemini vision analysis of that mockup (`docs/Design/GitDatNote 2.0 Vision Analysis.txt`) is the supporting evidence. This design reconciles the approved direction (Balanced C + D, six calm accent palettes, web-only, writing-first, collapsible metadata sidebar, deferred image uploads) against that report. No visual detail in this document goes beyond what the mockup and the report support; the §5 screen descriptions were revised in this pass to match the report's observations.

**Constraints (hard):**
- No browser chrome, OS title bars, minimize/maximize controls, or decorative desktop window frames — GitDatNote is a web application.
- No substantially different visual direction without explicit user approval.
- The article editor's writing surface remains predominantly neutral regardless of accent.

## 2. Observed repository facts (grounding)

From the foundation change and source (observed, not proposed):

- Frontend will be `src/web/` (React 18 + Vite 4, TypeScript), migrated from `src/main.jsx` / `src/App.jsx` (foundation task 2.5); dev proxy sends `/api` to `localhost:3000`.
- `marked` and `dompurify` are already in dependencies (task 2.1); the XSS sanitization pattern (marked → DOMPurify allowlist → scoped element) is already decided in the foundation `design.md` and spec.
- Session endpoint shape: `GET /api/session` → `{connected, user{login,name,avatarUrl}, repository{owner,name,contentRoot}, csrfToken}`; `401 UNAUTHORIZED` envelope.
- Repository endpoint: `GET /api/repositories` → accessible repos, each with `canRead`, `canWrite`, configured `contentRoot`.
- Content endpoints: `GET` (file read → content + blob SHA + size, or directory listing → children with name/type/sha/size), `POST` (create; `409 FILE_EXISTS`, `422 PATH_INVALID`, `422 CONTENT_TOO_LARGE`), `PUT` (update with `expectedSha`; `409 SHA_CONFLICT` + `currentSha`, `404 FILE_NOT_FOUND`). No delete endpoint.
- Standard error envelope: `{error: {code, message, retryable, status}}`; 11 codes (`UNAUTHORIZED`, `REPO_NOT_ALLOWED`, `CSRF_INVALID`, `PATH_INVALID`, `FILE_NOT_FOUND`, `FILE_EXISTS`, `SHA_CONFLICT`, `CONTENT_TOO_LARGE`, `RATE_LIMITED`, `GITHUB_UNAVAILABLE`, `INTERNAL_ERROR`).
- `src/shared/validate.ts` exists (task 2.3, tested in 2.6) — safe relative-path validation is available to the web layer without new backend work. `src/shared/frontMatter.ts` also exists but currently implements **serialization only** (`buildFrontMatter` → a `title`/`description`/`date`/`tags` block); **front-matter parsing is intentionally not implemented** (per the module doc; the tests re-parse with `js-yaml`), it emits **no `draft` field**, and it does not preserve front-matter fields outside that fixed set. Do not rely on parse/draft/preserve capabilities until the front-matter prerequisite task (see `tasks.md`) lands — see D-07.
- All state-changing requests require the `X-CSRF-Token` header (foundation 3.3).
- UI error rule from the foundation: display `error.message`; show a retry control iff `error.retryable`.

## 3. Design tokens

### 3.1 Color

**Appearance modes:** Light (default), Dark, System (follows `prefers-color-scheme`). Mode and accent palette are **independent** settings.

**Neutral scale (light mode):**
| Token | Value | Use |
|---|---|---|
| `--surface-app` | `#F7F6FA` | App background (soft neutral, whisper of accent via palette-tinted variant) |
| `--surface-panel` | `#FFFFFF` | Cards, panels, editor chrome |
| `--surface-sunken` | `#EFEDEE`-ish `#F0EEE7`→ palette soft bg | Inset areas, code blocks in preview (neutral in editor: `#F6F5F8`) |
| `--border` | `#E4E2EA` | Panel and row borders |
| `--border-strong` | `#C9C6D2` | Emphasized borders, input focus fallback |
| `--text-primary` | `#201E26` | Headings, primary body text |
| `--text-secondary` | `#5C5866` | Secondary text, metadata |
| `--text-tertiary` | `#8A8694` | Captions, placeholders, timestamps |
| `--text-inverse` | `#F7F6FA` | Text on accent fills |

**Neutral scale (dark mode):**
| Token | Value |
|---|---|
| `--surface-app` | `#17161B` |
| `--surface-panel` | `#201F26` |
| `--surface-sunken` | `#141317` |
| `--border` | `#35333D` |
| `--border-strong` | `#4A4854` |
| `--text-primary` | `#EDEBEF` |
| `--text-secondary` | `#B4B1BD` |
| `--text-tertiary` | `#827F8C` |
| `--text-inverse` | `#17161B` |

**Accent palettes (approved values, verbatim):**

| Palette | Primary accent `--accent` | Soft background `--accent-soft` |
|---|---|---|
| Lavender (default) | `#8271C8` | `#F2EFFB` |
| Sage | `#6F947D` | `#EFF5F0` |
| Ocean | `#668FAF` | `#EDF4F9` |
| Slate | `#758396` | `#F0F2F5` |
| Clay | `#B68774` | `#F8F0EB` |
| Teal | `#4E9293` | `#EAF5F4` |

**Foreground-on-accent (measured, not assumed).** White text on the raw accent fails WCAG 2.2 AA (4.5:1) for normal-size text on every palette (Lavender 4.08, Sage 3.38, Ocean 3.44, Slate 3.86, Clay 3.13, Teal 3.59). Each palette therefore defines a **`--accent-strong`** — a darkened variant of the approved hue — as the surface for primary actions with white (`--text-inverse` on light mode / dark on dark) labels; every measured ≥ 4.5:1:

| Palette | `--accent-strong` | White-on-strong contrast |
|---|---|---|
| Lavender | `#7566B4` | 4.87 |
| Sage | `#597664` | 5.00 |
| Ocean | `#577A95` | 4.54 |
| Slate | `#697687` | 4.62 |
| Clay | `#926C5D` | 4.64 |
| Teal | `#427C7D` | 4.76 |

Rule: **small text on accent fills uses `--accent-strong`**; the raw `--accent` is used for (a) large/bold text and icons on neutral surfaces (all pass 3:1), (b) focus rings, selected-nav indicators, progress, and decorative accents, and (c) soft-background tints (`--accent-soft` in light mode; a desaturated `--accent-soft-dark` at 12–18% on dark surfaces in dark mode). Accent-colored body-sized text on neutral backgrounds uses `--accent-strong`.

**State colors (per mode, mode-independent hues):**
| Token | Light | Dark | Use |
|---|---|---|---|
| `--success` | `#3E7D52` | `#6FBF8E` | Success status, saved indicator |
| `--success-soft` | `#E7F3EC` | `#1E3226` | Success banner background |
| `--error` | `#B4443C` | `#E58C82` | Error status, destructive actions |
| `--error-soft` | `#FBEDEB` | `#3A201D` | Error banner background |
| `--warning` | `#9A6B21` | `#D9A65B` | Warnings, unsaved-changes indicators |
| `--warning-soft` | `#F8F0E2` | `#33290F` | Warning banner background |
| `--disabled-text` | `#A6A3AF` | `#6B6875` | Disabled controls |
| `--disabled-surface` | `#F0EEE9` | `#26252C` | Disabled control surfaces |
| `--focus-ring` | `--accent` 2px offset ring | `--accent` 2px offset ring | Keyboard focus indicator |

Hover states: lighten the fill ~8% (light mode) / brighten ~8% (dark mode); focus: 2px `--focus-ring` outline, 2px offset, never border-only (visible in both modes, ≥3:1 against adjacent colors).

**Editor writing surface:** always neutral (`--surface-panel` / `--text-primary`), regardless of palette or mode — palette accents appear only in chrome (title, status, buttons, focus).

### 3.2 Typography

No proprietary fonts; no font downloads. System font stacks only:

| Token | Stack | Use |
|---|---|---|
| `--font-ui` | `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` | Navigation, controls, lists, forms |
| `--font-writing` | same sans stack (readable, comfortable) | Editor body (rendered preview) |
| `--font-mono` | `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace` | Markdown source, code blocks, slugs |

Scale (size / line-height, base 16px, 1.25 ratio):
| Token | Value | Use |
|---|---|---|
| `--text-xs` | 12px / 1.4 | Timestamps, captions, badges |
| `--text-sm` | 14px / 1.5 | Body UI text, table rows, buttons |
| `--text-md` | 16px / 1.6 | Dashboard article titles, form labels |
| `--text-lg` | 20px / 1.4 | Section headings (h2) |
| `--text-xl` | 24px / 1.3 | Screen titles (h1) |
| `--editor-body` | 17px / 1.75 (Markdown source), 18px / 1.75 (rendered) | Writing surface; max-width 70ch centered |

Heading hierarchy is strong but restrained: one `--text-xl` per screen; `--text-lg` for panels; weight contrast (600/700 headings, 400/500 body) rather than color. Markdown rendered preview uses the same scale mapped to H1–H6.

### 3.3 Spacing, borders, radii, shadows

| Token | Value |
|---|---|
| `--space-1..6` | 4 / 8 / 12 / 16 / 24 / 32 px (4px base rhythm) |
| `--radius-sm` | 8 px (inputs, tabs) |
| `--radius-md` | 10 px (cards, panels, dialogs) |
| `--radius-lg` | 12 px (large panels, onboarding cards) |
| `--shadow-sm` | `0 1px 2px rgba(24,20,35,.06)` |
| `--shadow-md` | `0 2px 8px rgba(24,20,35,.10)` (raised cards, dropdowns) |
| `--shadow-lg` | `0 8px 24px rgba(24,20,35,.16)` (dialogs, popovers) |
| `--sidebar-width` | 248 px (desktop) |
| `--touch-target-min` | 24 px hit area (WCAG 2.2 AA target size); 44 px recommended for primary actions |

Decoration is subtle: 1px borders, soft shadows, occasional accent-soft tinted surfaces, a small brand mark (a **pen-nib logo**) in the sidebar, and **soft ambient accent-tinted gradients along the top and bottom borders** of the app — the mockup's signature depth element, kept subtle so it reads as depth, not ornament. No gradients on text; no heavy ornamentation.

## 4. Architecture decisions

### D-01 — Token-based theming, no UI framework
CSS custom properties for all tokens + a small TypeScript token module (`src/web/theme/`) as the single source of truth (JS mirror for contrast assertions and non-CSS consumers). **Decision: build a lightweight in-house component system** (plain React components consuming the tokens) rather than adopting a large UI framework. *Rationale:* existing dependency set is already minimal (React 18, Vite 4); a framework (e.g., Radix+shadcn, Mantine) would add bundle size and a second abstraction over tokens we already define. *Alternative rejected:* framework components would still need the same token mapping and bring unneeded theming constraints. This is revisitable if component count grows; the token layer is framework-agnostic by design.

### D-02 — Appearance state: React context + browser-local persistence
A `ThemeProvider` holds `{mode: 'light'|'dark'|'system', palette: one of six}`. Mode+palette are independent. Persistence key: `gitdatnote.appearance.v1` in `localStorage` (JSON). Fallback when storage is unavailable (privacy mode, quota): in-memory defaults (`system`, `Lavender`), no crash, no repeated write attempts. System mode subscribes to `matchMedia('(prefers-color-scheme: dark)')` changes and re-applies live; explicit Light/Dark never changes on OS switch. Tokens are applied on the document root, so all screens (including dialogs) inherit them.

### D-03 — Dashboard data: client-side aggregation over existing content API
No backend search or metadata endpoint exists. The dashboard lists the content-root directory (`GET .../content?path=`), then reads each Markdown child to parse front matter (title, description, date, tags, status) using a **safe front-matter parser** — the shared `frontMatter.ts` currently serializes only, so a parsing primitive is a **prerequisite task**, not yet implemented (see D-07). *Tradeoff:* N+1 reads for large repositories; acceptable at MVP scale (dozens of articles). *Flagged:* a future server-side article-index endpoint would replace this; the UI contract (article row fields) is designed to consume either source.

**Article row fields and their API source:**
| Field | Source |
|---|---|
| Title, description/excerpt, status (draft/published), date, tags | Front matter of each file, **parsed by a prerequisite safe parser** (the shared module currently serializes only) |
| Filename / slug | Listing `name` |
| Blob SHA | Listing `sha` (used as `expectedSha` when opening in editor) |
| **Article date** | **Not provided by the current API as a timestamp** — listing returns name/type/sha/size only. UI shows the front-matter `date` (labeled "Article date") when present; a true relative/commit timestamp is deferred until the API exposes commit metadata (see §11) |
| Per-article actions | Edit (read+update available); **Delete is not offered** — no delete API (foundation defers it) |

### D-04 — Editor model and save flow
The editor state is `{title, markdownBody, frontMatter, blobSha (null for new), status}`. **Save** = `POST` (new) or `PUT` (existing, with `expectedSha`) to the content endpoint, with `X-CSRF-Token` header, front matter re-generated by `src/shared/frontMatter.ts` (the serialization generator the server tests validate; **the status/draft serialization it depends on is a prerequisite — see D-07**). **Publish** = Save with the status front-matter field flipped to published; both use the same save path. Client-side dirty tracking drives unsaved-change protection; **no autosave, no background sync, no conflict merging** — conflicts surface as the foundation's `409 SHA_CONFLICT` and the UI offers "reload" (re-fetch content + new SHA, show a clear diff-free message) or "keep my version" is *not* offered automatically (that would require a merge; out of scope). The `currentSha` in the 409 response updates the editor's baseline on reload.

### D-05 — Sanitized Markdown preview (foundation decision, restated)
`marked` → `DOMPurify` (explicit conservative allowlist: strips scripts, `on*` handlers, `javascript:`/`data:` URIs, iframe/object/embed) → rendered into a **dedicated scoped element** only. The raw Markdown string is never assigned to `innerHTML`. Preview and Write are a segmented control (no side-by-side panes in the MVP; side-by-side is a deferred enhancement). XSS regression tests per foundation task 2.7.

### D-06 — Image storage and paths
Images are stored **in the user's authorized repository** (never an external hosting service) under a per-repository/site **configured image directory** (default proposal: `Images/` at repository root — the SecondBrain/Eleventy convention; configurable per site). **The configured image directory may be located outside the Markdown content root** (a repo-root `Images/` sits beside, not inside, the content root), so image operations are governed by their own path rules rather than the content-root rules. **Path validation and authorization for image operations are separate from content-root validation:** an image write must (1) resolve against the configured image directory, (2) reject absolute, traversal-escaping, and null-byte paths via the shared `src/shared/validate.ts` rules so it cannot escape that directory, and (3) require repository **write authorization** (`canWrite`) for the owning repository — content-root validity alone never authorizes an image write. **Article-relative URL generation** MUST be computed from the **actual article path and the actual image location** (the relative path from the article's directory to the image within the repository); e.g., `../Images/photo.webp` illustrates **only** the specific case where an article sits one level under a content root that is beside a repo-root `Images/` — it is **not** a universal path. Correctness against the configured Eleventy site layout is a per-site setting (image directory + optional base-URL prefix for the generated site). Exact upload mechanics (content type allowlist, size limit, duplicate/conflict policy) are specified at §8 and finalized when the image-management API is implemented; **functional image uploads remain deferred**.

### D-07 — Article status and front-matter conventions
Draft/published is a front-matter field. **Approved convention:** `draft: true` means draft; absence or `draft: false` means published. **Compatibility caveat:** confirm against the user's Eleventy configuration (SecondBrain uses `draft` front matter in practice); reconcile in the front-matter module if conventions differ. `date` is ISO (YYYY-MM-DD or full ISO datetime), matching the foundation's `frontMatter.ts` validation. Slug is generated by `src/shared/slug.ts` and stored as the filename stem (user-editable in the inspector Details tab). **Current shared-module state (implemented vs missing):** `src/shared/frontMatter.ts` currently implements `buildFrontMatter` only — it serializes a fixed set of fields (`title`, `description`, `date`, `tags`) with validated, escaped, deterministic output (tested in foundation 2.6). It does **not** implement: (a) parsing of existing Markdown front matter (intentionally omitted per the module doc; the tests re-parse with `js-yaml`); (b) `draft: true/false` serialization (no `draft` field in `FrontMatterMeta`; never emitted); (c) preservation of front-matter fields outside that fixed set on edits (unrelated Eleventy metadata would be dropped); or (d) guaranteed round-trip of existing SecondBrain/Eleventy content. These are **not** assumed available in this change; they are scoped as a **separate prerequisite task** (`tasks.md`) that must land before the dashboard parse and the editor draft/publish flows can rely on them.

### D-08 — Error presentation
Every UI error path renders from the foundation envelope: message from `error.message`, retry control iff `error.retryable`, `currentSha` handled in the editor conflict state. Mapping (UI wording, not inventing codes):
| Code | UI state |
|---|---|
| `UNAUTHORIZED` | Session banner: reconnection offered; privileged actions disabled |
| `REPO_NOT_ALLOWED` | Access banner; write actions disabled for that repository |
| `CSRF_INVALID` | Transient: re-fetch session (CSRF token) and retry once; then error banner |
| `PATH_INVALID` / `FILE_EXISTS` / `CONTENT_TOO_LARGE` | Form-level validation message on the relevant field/action |
| `FILE_NOT_FOUND` | Editor: file gone (deleted elsewhere) — offer to start fresh or go back |
| `SHA_CONFLICT` | Conflict dialog: "This file changed since you opened it" + Reload action |
| `RATE_LIMITED` | "Rate limit reached — try again shortly" + retry (honors `Retry-After` if present) |
| `GITHUB_UNAVAILABLE` | "GitHub is unreachable — check your connection" + retry |
| `INTERNAL_ERROR` | Generic safe message + retry; details never shown to the user |

### D-09 — Breakpoints
Mobile `< 640 px` · Tablet `640–1023 px` · Desktop `≥ 1024 px`. Layouts are fluid within these bands; no horizontal overflow at any supported width (320 px minimum test width).

## 5. Screens

### 5.1 Application shell
- **Sidebar (desktop):** brand block (a **pen-nib logo** + bold "GitDatNote" wordmark); site/repository selector at top; **primary nav: Articles, Drafts, Published — each with a counter badge** (the mockup shows e.g. Articles: 24, Drafts: 6, Published: 18); **secondary nav: Sites, Settings, Help**; and a **bottom-anchored user profile** (avatar + login name) with Disconnect. Width `--sidebar-width`. **Counter badges** on nav items are a supported element per the mockup. (The dashboard's All/Drafts/Published filter tabs and sort control mirror these counts in the content area.)
- **Tablet:** sidebar collapses to an icon rail (48–72 px) with labels on hover/focus; full sidebar available as an overlay via a menu button.
- **Mobile:** sidebar hidden; top app bar with brand mark, repository selector (compact), and menu button opening the sidebar as a full-height drawer.
- **Repository selector:** dropdown listing repositories from `GET /api/repositories`, showing `owner/name` plus a read-only indicator when `canWrite` is false. The currently selected repository is always visible in the header area of the active screen (requirement: the dashboard must clearly indicate the selected repository).
- **Not connected:** sidebar shows minimal nav + a prominent "Connect GitHub" action (see onboarding, §5.3). No privileged content is reachable.
- **Help:** links to the README/setup documentation (static; no in-app help system in the MVP).
- Keyboard: sidebar nav is a real focusable list; Escape closes drawers/dialogs; focus returns to the trigger.

### 5.2 Article dashboard
- **Header row:** screen title "Articles", selected repository (owner/name), search field (client-side), "New Article" primary button (accent-strong).
- **Filter tabs + sort:** All / Drafts / Published — segmented control, accent-selected state, announced to screen readers — **with a sort control** beside the tabs (the mockup shows a sorting control above the feed; default sort = newest Article date).
- **Article list:** one row per article card, in the mockup's order: a small **article icon**, **title** (link to editor, bold), optional **description/excerpt** (muted, clamped to 1–2 lines), a **status badge** (**Published = success/green soft badge**; **Draft = neutral/gray badge** — text always present, never color alone), an **"Article date"** (front-matter `date`, per the approved "Article date" decision — no fabricated or commit-derived timestamps in the MVP; the mockup's relative timestamp is sourced from the front-matter date and true relative/commit timestamps are deferred), and a per-article **action menu (⋯)**: Edit (the only wired action in the MVP; delete deliberately absent).
- **States:** loading (skeleton rows, ≤8 rows), empty repository (illustration-free, text: "No articles yet" + New Article CTA), no repositories connected (onboarding CTA), search no-match ("No articles match '…'" + clear search), read-only repository (all write affordances disabled with a reason line "This repository is read-only for you"), access revoked (banner + reconnect), GitHub unavailable (banner + retry).
- **Keyboard navigation:** the list is a **semantic list of focusable rows** (each row a real link/button); **Tab** moves between rows, **Enter/Space** opens the focused article, and the ⋯ action menu is keyboard-reachable and navigable. (Roving-tabindex complexity is deliberately avoided in favor of semantic controls.)
- **No horizontal overflow** at any breakpoint; rows wrap description text.

### 5.3 GitHub onboarding
Sequence: **1 Connect GitHub → 2 Choose a repository → 3 Configure the publishing site → 4 You're ready.**
**Layout:** a centered **split-panel** wizard — a **left column** with the four-step vertical stepper (the active step highlighted in solid accent) and a **right** elevated white **content card** holding the current step's content.
1. **Connect:** the card shows the **GitHub logo**, a bold action title, and concise copy; a **full-width accent "Connect GitHub" CTA** (with an **external-link icon**) initiates `GET /api/auth/github/start`. Beneath the CTA, **trust microcopy with a lock icon** ("Your content stays in your GitHub account"). One line explains that GitDatNote asks for Contents read/write + Metadata read, only for repositories the user selects, and that no repository-creation permission is requested.
2. **Choose repository:** list from `GET /api/repositories` with `canRead`/`canWrite` displayed; read-only repos are selectable but flagged ("read-only"); no eligible repos → explanation + guidance (check App installation / repo access).
3. **Configure site:** content-root input (validated by the same `src/shared/validate.ts` rules client-side before submission) with an explanation of exactly where Markdown files will be stored (`<contentRoot>/<…>`), the image-directory setting (default `Images/`), and a plain-ownership statement: "You keep ownership of all content in your GitHub repository. GitDatNote only writes files you ask it to."
4. **You're ready:** confirmation of the completed setup (summary of selections). **Site-configuration persistence is a future backend/API dependency.** **Two distinct states:** (a) **Placeholder state (current, no endpoint):** step 4 shows the selection summary and opens the dashboard with the repository selected, but **does not persist a site configuration and shows no success message implying persistence** (no false success, no invented persistence); (b) **Fully functional happy path (only once the endpoint exists):** the endpoint persists the configuration and the success shown reflects a real server save (see §10).
- **Error handling:** authorization canceled (safe message + retry, no partial session implied), missing App installation (guided text, no invented install steps beyond GitHub's), no eligible repositories, read-only access (proceed with read-only expectations), invalid content root (field error, no submit), GitHub API failures (envelope message + retry), returning user (skip to dashboard; pre-fill previously configured sites), previously configured sites (offer to re-select or edit existing), revoked permissions (reconnect flow, never a success claim).
- Onboarding is a single-page stepped flow (split-panel stepper + content card), not multi-page redirects; it reuses the shell layout.

### 5.4 Markdown article editor (primary experience)
- **Layout (desktop):** a focused **two-column split** — the **writing canvas** (Markdown source, `--font-mono` 17px/1.75, max-width 70ch, generous padding; **the dominant, most-spacious element on screen**) on the left and a **collapsible inspector sidebar** on the right. The **header bar** holds, left to right: **breadcrumbs** ("Articles / <Title>"), a **Draft/Published status pill**, a **save-status indicator** (Unsaved / Saving… / Saved ✓), a **Preview button**, and a **split Publish control** (primary "Publish" + a dropdown chevron for additional publish actions — scheduling is a deferred dropdown item).
- **Formatting toolbar** (directly above the writing surface, non-obtrusive) — **approved initial set: Bold, Italic, Insert Link, Insert Image** (Insert Image action — see §8). Each command inserts pure Markdown (no HTML) to preserve portability. (The mockup illustrates a fuller toolbar — headings, code, lists — which are **deferred** extensions, not MVP scope.)
- **Write/Preview:** the header **Preview button** toggles between the source canvas and the sanitized rendered Markdown (D-05). In preview, **H1/H2 headings are styled in the accent color** (the mockup shows bold accent headings in the rendered preview); the *source* writing surface stays neutral. **External links in preview use `target="_blank"` and `rel="noopener noreferrer"`** (approved), so the user cannot navigate away from unsaved work within the app.
- **Inspector sidebar (tabbed):** **Details / SEO / Options** tabs (matching the mockup). **Details** (MVP): **Title** (required text input) and **Slug** (required, with generate-from-title), a **Status** select (Draft/Published), **removable tag pills** (each tag a pill with an × to remove; adds to the front-matter tags array), and **Featured Image** — an **aspect-ratio-locked preview** with **floating edit and delete actions**, functional only when the image API exists, otherwise a clearly-disabled control labeled "Available when image upload is available". **SEO** and **Options** tabs are present as structure; their detailed content is **deferred** per scope (no SEO analysis in MVP). On tablet/mobile the inspector becomes an overlay panel (slide-in from right, full-height) opened from the header.
- **Save behavior:** Save keeps current status; the split Publish control's primary action sets published and saves. The header **save-status indicator** reflects idle → "Saving…" (controls disabled) → "Saved ✓" (transient, success) → error states per D-08. Unsaved changes: indicator ("Unsaved changes") + `beforeunload` guard + in-app navigation guard (confirm dialog when leaving to dashboard/onboarding). **Background autosave is NOT in scope** (the mockup's save-status indicator does not imply background autosave; see open question §11 on whether to add it).
- **Distraction-free mode:** toggles sidebar, toolbar, and header chrome away (leaves title + writing surface + status), entered/exited via a top-bar toggle or keyboard shortcut; writing surface widens slightly.
- **Keyboard shortcuts:** `Ctrl/Cmd+S` save; `Ctrl/Cmd+B` / `Ctrl/Cmd+I` bold/italic at cursor; **`Ctrl/Cmd+K` inserts/edits a link** (approved — reserved for Insert/Edit Link, not Insert Image); distraction-free toggle `Ctrl/Cmd+Shift+D`; standard field navigation everywhere. **Publish has no keyboard shortcut** — it remains reachable only through the labeled **split Publish control**; `Ctrl/Cmd+P` is deliberately left unbound so the browser's Print behavior is preserved. Insert Image has no reserved shortcut (it is a toolbar button).
- **Error states (explicit):** unsaved changes (indicator + guard), save in progress (disabled controls), successful save (transient success), failed save (error banner + retry, content preserved in memory), network interruption (banner + retry; no silent loss), repository access revoked (read-only banner; disable Save/Publish; content preserved), remote file changed (`409 SHA_CONFLICT` dialog: reload or keep-editing-with-warning — no automatic merge), Git blob SHA conflict (same dialog, wording per D-08), publication failure (status unchanged; error banner).
- **Classification — initial vs deferred (explicit):**
  | Feature | Status |
  |---|---|
  | Title, writing canvas, header (breadcrumbs, status pill, save-status, Preview, split Publish), tabbed inspector (Details), save/publish, unsaved-change protection, shortcuts, distraction-free mode, sanitized preview | **Initial** |
  | Formatting toolbar (Bold, Italic, Insert Link, Insert Image) | **Initial** (each command = pure Markdown insertion) |
  | Full toolbar (headings/code/lists), side-by-side split view, **background autosave**, SEO analysis, advanced publishing controls (scheduling, per-repo templates), drag-to-reorder, WYSIWYG engine | **Deferred** (no scope claim) |

### 5.5 Appearance settings (Appearance tab within the Settings hub)
The Appearance settings is the **Appearance tab** of a **Settings hub** — a **horizontal settings navigation bar** (General, Appearance, Publishing, GitHub, About) that retains the global sidebar. The **Appearance** tab is fully specced; the other tabs (General, Publishing, GitHub, About) are structural placeholders with deferred content. The Appearance tab matches the mockup's composition:
- **Theme picker:** a **three-card grid** (Light / Dark / **System**) each with a **line icon** (sun / moon / device) and a clear **selection ring** on the current mode; labeled (e.g., "Current").
- **Accent palette:** **circular color swatches** (Lavender, Sage, Ocean, Slate, Clay, Teal), each showing the accent fill; the active swatch has a **selection ring + its name** shown.
- **Immediate preview:** selecting a card/swatch applies the theme to the whole app instantly (the settings screen itself re-themes live).
- **Current selection indication:** visible text + ring, never ring-only.
- Persistence per D-02 (browser-local; site-level persistence, if later adopted, is a future backend dependency); graceful fallback when storage is unavailable; system-appearance changes propagate live in System mode and are ignored in explicit modes.
- Keyboard: every card/swatch is a real button; arrow/Tab navigation, Enter/Space to select, visible focus indicators.

## 6. Component inventory (reusable, state-bearing)

| Component | Required states |
|---|---|
| App sidebar / drawer / icon rail | desktop, tablet-rail, mobile-drawer; active-nav (accent indicator), hover, focus |
| Site/repository selector | closed, open, selected (with read-only badge), loading, error |
| Button (primary/secondary/ghost/danger) | default, hover, focus, active, disabled, loading |
| Icon button | default, hover, focus, disabled; always a text alternative (aria-label) |
| Nav link / list row | default, hover, active, focus, disabled |
| Search field | empty, populated, cleared; no-match result region |
| Filter tabs (segmented) + sort control | selected (accent), hover, focus; announced selection; sort options menu |
| Article row (icon, title, excerpt, status badge, date, ⋯ menu) | default, hover, focused, selected, read-only (actions disabled) |
| Status indicator (badge) | draft, published, saving, saved, error — text always present |
| Form input / textarea / label | default, hover, focus, error (message linked by aria-describedby), disabled |
| Dropdown menu | closed, open, focused item, keyboard-navigable, Escape closes |
| Card / panel | default, elevated (hover/raised), disabled |
| Dialog / confirmation prompt | open (focus trap, focus restore on close, Escape), light/dark surface |
| Notification / status banner | success, error, warning, info; dismissible where appropriate; `aria-live` |
| Loading indicator / skeleton | spinner (small) and skeleton rows/cards; reduced-motion static fallback |
| Empty state / error state | illustration-free, heading + explanation + single CTA |
| Responsive nav controls | menu button, drawer, app bar (mobile) |
| Breadcrumb (Articles / <Title>) | default, current-page emphasis |
| Split button (Publish + dropdown) | closed, open (keyboard-navigable), primary action, disabled |
| Tag pill (removable) | default, hover, focus, remove (×) |
| Featured-image preview (aspect-ratio-locked, floating edit/delete) | empty, filled, disabled (image API absent), loading |
| Settings nav tab bar (General/Appearance/Publishing/GitHub/About) | selected (accent), hover, focus |
| Theme picker card (line icon + selection ring) | selected, hover, focus |
| Accent circular swatch (selection ring + label) | active, hover, focus |
| Trust microcopy (lock icon) | static, light/dark |
| Nav counter badge | default, count, empty |
| Save-status indicator | unsaved, saving, saved, error |

All components consume tokens only; no component hardcodes colors. Focus is always a 2px accent ring (2px offset) in both modes.

## 7. Responsive behavior

| Screen | Desktop ≥1024 | Tablet 640–1023 | Mobile <640 |
|---|---|---|---|
| Shell | Sidebar 248px | Icon rail + drawer | Top bar + full drawer |
| Dashboard | List + right-aligned actions | List, actions wrap below | List, stacked; row actions in menu |
| Editor | Writing surface + collapsible sidebar | Sidebar → overlay panel; writing surface primary | Full-screen writing; metadata in overlay; top bar wraps (back, status, save) |
| Onboarding | Centered split-panel (stepper + card, max 720px) | Same, wider | Same; split stacks (stepper on top, single column) |
| Appearance (Settings hub) | Settings nav + 2-column content | 1 column; nav wraps | 1 column; nav wraps; swatch grid 2–3 per row |
| Image dialogs | Modal (max 560px) | Near-full modal | Full-screen sheet |

Rules: no horizontal overflow at any width (verified at 320/768/1024/1280); touch targets ≥24 px (primary actions 44 px on mobile); text reflows (no truncation of essential information); zoom to 200% does not lose functionality (WCAG 1.4.10).

## 8. Image upload and management UX (specification for future implementation)

**Storage principle:** images live in the user's authorized repository under the configured image directory — never an undocumented external host. **Functional uploads are deferred** until an authenticated image-management API exists; all image UI in the MVP is either (a) render-only (existing Markdown image syntax displays in preview) or (b) a **clearly disabled** control marked "unavailable" — never a control that implies success.

**Insert Image action** (editor toolbar button; no reserved keyboard shortcut — `Ctrl/Cmd+K` is reserved for Insert/Edit Link) opens a dialog with three tabs:
1. **Upload from device** — file picker; shows filename, size, and dimensions; upload progress; success (path + inserted Markdown); validation errors (unsupported type, over size limit); failure + retry; duplicate-filename handling (server-side decision, surfaced as a message); repository permission errors (`REPO_NOT_ALLOWED` message); cancellation where technically supported.
2. **From repository** — lightweight image browser over the configured image directory: thumbnail previews, filenames, selection, Insert; empty/loading/error/permission-denied states. No external DAM.
3. **From URL** — URL input, validation (http/https), preview-on-load, alt-text field.

Result is portable Markdown image syntax `![alt](path-or-url)` inserted **at the cursor position** when the editor supports it (initial: at end of document with a clear notification if mid-text insertion is not yet supported).

**Formats:** initial — JPEG, PNG, WebP, GIF. **SVG deferred** until a security/sanitization policy exists (SVG is an XSS surface). AVIF and transformations: later.

**Metadata & accessibility controls:** alternative text (encouraged for informative images; an explicit "decorative image" option produces empty alt and is distinguishable from an omitted one), optional caption, filename, dimensions, file size, preview, Insert button, optional featured-image designation.

**Storage requirements (per repository/site configuration):** safe relative paths (canonicalized; absolute, traversal, and null-byte rejected via shared validation); repository permission checks before any image operation; filename normalization (ASCII-safe, collision-safe); file-size limit and allowed content-type list (values finalized with the API, not invented here); duplicate detection; existing-file conflict handling (never silent overwrite — consistent with the content API's create-no-overwrite rule); safe Markdown URL generation (percent-encoded where needed, relative to the article); prevention of path traversal; correct image paths for the configured Eleventy site (per-site image directory + optional base prefix).

## 9. Accessibility and responsive acceptance criteria (WCAG 2.2 AA)

1. Full keyboard access: every action reachable and operable by keyboard alone (walkthrough required at acceptance).
2. Visible focus: 2px accent ring, 2px offset, ≥3:1 against adjacent colors, in both appearance modes.
3. All inputs have accessible labels (visible or `aria-label`); error messages linked via `aria-describedby`.
4. Text contrast: body text ≥4.5:1, large text ≥3:1 in every palette × mode combination (tokens in §3.1 are constructed to pass; acceptance runs the measured assertions).
5. Error messages are specific, visible, and actionable (no raw codes to the user).
6. Status changes (save progress, save success/failure, list loading, theme change) announced via `aria-live` regions (polite; assertive for errors).
7. Screen-reader compatibility: semantic landmarks (banner, nav, main, complementary), list semantics on the article list, dialog semantics with focus trap/restore, no reliance on icon-only affordances without labels.
8. Reduced motion: `prefers-reduced-motion: reduce` disables skeletons (static placeholder), transitions, and auto-scroll.
9. Touch: targets ≥24 px (primary ≥44 px on mobile); no hover-dependent functionality.
10. Zoom/text scaling: 200% zoom preserves layout and function; no horizontal scroll.
11. No information conveyed by color alone (status badges carry text; read-only states carry labels).

## 10. Dependencies and phased implementation map

- **Task 2.5 (foundation, minimal shell):** may adopt this change's tokens/accessibility baseline when implementing its "basic accessibility and usability" allowance, but stays minimal per its own text; no UI scope from this change is claimed inside 2.5.
- **Theming/appearance:** independent of backend — implementable as soon as `src/web/` exists (this change's Phase 1).
- **Shell/connect states:** need 2.5 + foundation 3.2 (`GET /api/session`).
- **Onboarding:** foundation 3.2 (auth start, repositories) and 3.4 (canRead/canWrite). **Site-configuration persistence** (onboarding step 3) is a **future backend/API dependency** — the UI is a placeholder until a config endpoint exists; do not assume the endpoint is implemented.
- **Dashboard read/list:** foundation 4.2 + a **safe front-matter parser** (prerequisite task — the shared `frontMatter.ts` serializes only; task 2.3 is the serializer, not a parser).
- **Dashboard write (New Article), editor save/publish, publish flow:** foundation 4.3/4.4 + CSRF (3.3).
- **Editor conflict/retry states:** foundation 4.5 error envelope + `currentSha`.
- **E2E verification:** foundation 5.2 Playwright suite is the vehicle for UI acceptance scenarios.
- **Image upload/library/featured image:** future image-management API change (this change specifies the UX only).
- **File deletion (per-article delete action):** future change (foundation has no delete endpoint).
- **Server-side article metadata/search:** future change if repository scale makes N+1 reads unacceptable (D-03).

## 11. Decisions and open items

**Resolved in this refinement (approved):**
- **Front-matter status field:** `draft: true/false` is the approved convention (absence = published). **Implementation note:** `src/shared/frontMatter.ts` currently serializes only (`buildFrontMatter`; no `draft` field, no parser, no preservation of other fields) — safe parsing, draft serialization, and metadata preservation are a **separate prerequisite task** (`tasks.md`), not yet implemented. **Compatibility caveat:** confirm against the user's Eleventy configuration (SecondBrain uses `draft` front matter in practice); reconcile in the front-matter module rather than the UI if conventions differ.
- **Site configuration persistence:** treated as a **future backend/API dependency** — onboarding step 3 and any site-config UI are placeholders until the endpoint exists.
- **Dashboard date:** uses **"Article date"** (front-matter `date`), not "Last updated". True relative/commit timestamps are deferred (the API exposes no commit metadata).
- **Preview external links:** `target="_blank"` + `rel="noopener noreferrer"`.
- **Insert/Edit Link shortcut:** `Ctrl/Cmd+K` (reserved for Insert/Edit Link; Insert Image has no reserved shortcut).
- **Initial toolbar:** Bold, Italic, Insert Link, Insert Image, Preview. The mockup's fuller toolbar (headings/code/lists) is deferred.
- **Image directory default:** repository-root `Images/`, configurable per site.
- **Mockup commit:** the approved mockup `docs/Design/GitDatNote 2.0 UI Showcase.png` **and its Gemini vision analysis `docs/Design/GitDatNote 2.0 Vision Analysis.txt` are committed to the development branch** (tracked in Git, committed with the design specifications). Neither is regenerated, edited, or moved by this correction.

**Still open (require user input):**
1. **Background autosave:** the mockup shows an "auto-save confirmation" in the editor header. The current decision is **manual save (no background autosave, no conflict merging)** — the header shows a save-status indicator regardless. Confirm whether to add background autosave (would require a conflict-safe `PUT` + merge/refresh strategy). Default: no background autosave.
2. **"Sites" navigation:** the mockup shows a "Sites" secondary nav item (multi-site management). The foundation models one content root per repository. Confirm the intended scope/behavior of "Sites" (deferred structural area vs. a defined feature).
3. **Inspector SEO / Options tabs:** present as structure in the mockup; their detailed content is deferred. Confirm the intended MVP scope (empty tabs vs. minimal content).

## 12. Threat model (UI-relevant)

- **Stored XSS via Markdown preview:** neutralized by the mandated marked+DOMPurify allowlist (D-05; foundation spec already requires XSS regression tests). The **sanitized output** may be rendered into a dedicated scoped element **or** via React `dangerouslySetInnerHTML` — but only the **sanitized string** may reach the DOM; the **raw Markdown / unsanitized HTML must never** be assigned to `innerHTML` or `dangerouslySetInnerHTML`.
- **Image path traversal / absolute paths:** client-side reuse of shared validation before any image operation; server re-validates (foundation path-validation requirement).
- **Credential exposure:** no tokens in the frontend bundle or browser storage (foundation constraint); CSRF header-only; appearance preferences stored are non-sensitive.
- **False success:** every async UI state must distinguish pending/success/failure; no control may display success before the API confirms it (applies doubly to image upload placeholders).
- **Denial of trust in repo list:** `canRead`/`canWrite` flags from the server are the sole permission source for enabling write UI; the client never assumes permission from repository visibility.

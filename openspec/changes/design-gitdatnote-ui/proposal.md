# Proposal: Design GitDatNote 2.0 UI/UX

## Why
The foundation change (`modernize-gitdatnote-foundation`) establishes the secure backend and a deliberately minimal React shell (task 2.5), and explicitly defers product visual design to a separate change: *"Make no visual design choices beyond basic accessibility and usability … no styling system, theme tokens, layout redesign, or visual polish — the product visual design will be specified in a separate change."*

The user has approved a visual direction — **Balanced C + D**: an efficient, structured, Linear-inspired publishing dashboard combined with a calm, spacious, distraction-free Markdown writing experience, distinctive GitDatNote branding, restrained lavender/purple accents, and soft neutral backgrounds. An approved visual mockup (primary visual authority) has been placed at `docs/Design/GitDatNote 2.0 UI Showcase.png` (repository-relative path; untracked in Git), with a supporting Gemini vision analysis at `docs/Design/GitDatNote 2.0 Vision Analysis.txt` — see "Impact".

This change creates the complete UI/UX specification: design system, screen and interaction specifications, image-management UX (for future implementation), responsive and accessibility requirements, and a phased, independently verifiable implementation plan. **It is specification-only: it creates no application code, adds no dependencies, and changes no existing files.**

## What Changes (in scope)
- **Design system:** typography, colors (six accent palettes with measured foreground/contrast values), spacing, borders, radii, shadows, reusable components, and interface states.
- **Appearance:** three appearance modes (Light, Dark, System) independent of six user-selectable accent palettes, browser-local persistence with graceful fallback.
- **Screen specifications:** article dashboard, Markdown article editor (primary experience), GitHub onboarding, appearance settings.
- **Image upload and management UX:** insertion (upload / repository library / URL), upload interaction spec, format policy, accessibility metadata, per-repository image directory requirements — functional uploads deferred until an authenticated image API exists.
- **Responsive design and accessibility:** desktop/tablet/mobile layouts and WCAG 2.2 AA acceptance criteria.
- **Implementation plan:** phased tasks mapped to foundation phases, each independently verifiable.

## Capabilities
### New Capabilities
- `application-shell`: branded shell with sidebar navigation, site/repository selector, and responsive navigation.
- `article-dashboard`: dashboard for browsing, filtering, searching, and managing articles in an authorized repository.
- `markdown-editor`: the primary writing experience — title, writing canvas, inspector (Details/SEO/Options), Preview, split Publish, the approved initial formatting toolbar (Bold/Italic/Insert Link/Insert Image), save/publish, and error states.
- `github-onboarding`: connect GitHub → choose repository → configure publishing site → confirm.
- `appearance-theming`: appearance mode + accent palette selection with persistence.
- `image-management`: UX for inserting and managing repository-stored images (functional uploads deferred).
- `responsive-accessibility`: responsive layout behavior and WCAG 2.2 AA acceptance criteria.

### Modified Capabilities
- None. This change complements `modernize-gitdatnote-foundation` and does not rewrite, modify, or archive it. Foundation tasks are not edited by this change.

## Out of scope (non-goals)
- Application code, dependencies, build or test-tooling changes (specification-only assignment).
- Functional image upload, image processing, image-management API, or any image backend work.
- Rich-text/WYSIWYG editing engine; Markdown remains the portable source of truth.
- Automatic conflict merging, backend autosave, SEO analysis, analytics, collaboration, batch operations.
- File deletion (the foundation content API deliberately has no delete; deletion is deferred to a later change).
- Backend search (client-side filtering over loaded articles only).
- GitHub Pages deployment, domain configuration, hosted SaaS, billing, AI writing.
- Expanded scope for foundation task 2.5 — it remains a minimal functional React migration unless the user separately approves.
- Broader GitHub permissions than the existing architecture requires (Contents read/write + Metadata read; no repository creation).
- Browser chrome, OS title bars, or decorative window frames in the design (GitDatNote is a web application).

## Relationship to existing OpenSpec work
| UI feature group | Depends on |
|---|---|
| Design tokens, appearance settings, theming store | Nothing backend (browser-local) — can be implemented as soon as `src/web/` exists (task 2.5) |
| App shell, connect/disconnect states | Task 2.5 shell; `GET /api/session` (foundation task 3.2) |
| Onboarding flow | `GET /api/auth/github/start` + `GET /api/repositories` (foundation tasks 3.2, 3.4) |
| Dashboard list/read | `GET /api/repos/{owner}/{repo}/content` (foundation task 4.2) + shared front-matter parsing (task 2.3) |
| New article / edit / publish | `POST`/`PUT` content endpoints (foundation tasks 4.3, 4.4) + CSRF header (task 3.3) |
| Per-article actions (edit) | Existing content API; **delete is unavailable** until a future change adds it |
| Error/retry states | Foundation error envelope (`code`, `message`, `retryable`, `currentSha`) — task 4.5 |
| Image insertion (URL only) | No API needed to *render* an image reference in Markdown; inserting local paths is deferred with the image API |
| Image upload / library / featured image | **Future image-management API change** (not this change) |

## Impact
- New files only: `openspec/changes/design-gitdatnote-ui/{proposal.md, design.md, tasks.md, specs/**}`.
- The approved mockup `docs/Design/GitDatNote 2.0 UI Showcase.png` (primary visual authority) and its Gemini vision analysis `docs/Design/GitDatNote 2.0 Vision Analysis.txt` are currently **untracked**; both are recorded here and may be committed with the design documentation after user review. Neither is renamed, regenerated, edited, or moved by this change.
- The `modernize-gitdatnote-foundation` change remains active and unarchived. No SecondBrain or production-repository content is touched.
- A previously observed local modification to `.hermes/skills/openspec-apply-change/SKILL.md` is preserved exactly; it is not restored, staged, or committed.

## Rollback
This change adds only specification files under `openspec/changes/design-gitdatnote-ui/`. Rollback is deletion of that directory; no source, lockfile, config, or existing spec is affected.

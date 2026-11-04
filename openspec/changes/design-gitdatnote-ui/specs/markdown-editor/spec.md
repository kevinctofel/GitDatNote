# Markdown editor — Delta specification

## ADDED Requirements

### Requirement: Writing surface priority
The editor MUST give the Markdown writing surface (the writing canvas) the greatest visual space on screen. The canvas MUST use a readable monospace typeface, a centered max-width (70ch), and generous padding, and remain predominantly neutral regardless of accent palette or appearance mode. The editor MUST present a header and a collapsible inspector (Details/SEO/Options).

#### Scenario: Dominant writing area
- **GIVEN** the editor is open on desktop
- **WHEN** the layout renders
- **THEN** the writing surface occupies the largest area on screen
- **AND** its background and text colors are neutral (not accent-driven)

#### Scenario: Editor header and inspector
- **GIVEN** the editor
- **WHEN** it renders
- **THEN** the header shows breadcrumbs, a Draft/Published status pill, a save-status indicator, a Preview toggle, and a split Publish control
- **AND** the inspector (Details/SEO/Options tabs) is present and collapsible

### Requirement: Title and status
The editor MUST show a prominent article title input and a clear Draft/Published status control. The status control MUST reflect and control the front-matter status field.

#### Scenario: Publish flips status
- **GIVEN** a draft article
- **WHEN** the user activates Publish
- **THEN** the status front-matter field is set to published
- **AND** the file is saved via the update endpoint
- **AND** a transient success indicator is announced

### Requirement: Sanitized preview
Markdown previews MUST be sanitized. The rendered output MUST NOT contain executable scripts, unsafe HTML, or untrusted event handlers. Rendering MUST go through the marked → DOMPurify allowlist pipeline; the sanitized output MAY be rendered into a scoped element or via React `dangerouslySetInnerHTML`, and raw/unsanitized Markdown MUST never be assigned to `innerHTML` or `dangerouslySetInnerHTML`.

#### Scenario: Script stripped in preview
- **GIVEN** a Markdown body containing `<script>` and an `onerror` handler
- **WHEN** the user switches to Preview
- **THEN** the script and handler are absent from the rendered DOM
- **AND** no code executes

#### Scenario: Safe Markdown renders
- **GIVEN** a body with headings, links, lists, code, and a relative-path image
- **WHEN** the user switches to Preview
- **THEN** all elements render correctly and the image loads from the repository path
- **AND** H1/H2 headings are styled in the accent color and external links open in a new tab with `rel="noopener noreferrer"`

### Requirement: Metadata sidebar
The editor MUST provide a collapsible inspector with a Details tab (description, article date, slug with generate-from-title, removable tag pills, and an aspect-ratio-locked featured-image control) plus SEO and Options tabs (structural in the MVP). The inspector MUST be collapsible on desktop and become an overlay panel on tablet and mobile.

#### Scenario: Collapse and overlay
- **GIVEN** the editor on desktop
- **WHEN** the user collapses the metadata sidebar
- **THEN** the writing surface expands and the collapse state is remembered
- **AND** on a tablet viewport the same sidebar opens as a full-height overlay with focus management

#### Scenario: Featured image deferred
- **GIVEN** the image-management API does not yet exist
- **WHEN** the featured-image control is shown
- **THEN** it is clearly disabled and labeled unavailable
- **AND** it never implies an image was attached

### Requirement: Save and publish flow
Save MUST keep the current status; Publish MUST set published and save. Both MUST use the create/update content endpoint with the CSRF header and shared front-matter generation, and MUST disable controls while in flight.

#### Scenario: Save success
- **GIVEN** an edited existing article with a known blob SHA
- **WHEN** the user saves
- **THEN** the PUT succeeds, a transient "Saved" indicator appears, and controls re-enable

#### Scenario: SHA conflict
- **GIVEN** the remote file changed since it was opened
- **WHEN** the user saves and receives `409 SHA_CONFLICT`
- **THEN** a conflict dialog appears with a reload action that adopts `currentSha`
- **AND** no automatic merge is performed
- **AND** the user's in-memory content is preserved

### Requirement: Unsaved-change protection
The editor MUST protect unsaved changes with an in-app navigation guard and a `beforeunload` guard, and MUST show an "Unsaved changes" indicator.

#### Scenario: Leave with unsaved changes
- **GIVEN** unsaved edits
- **WHEN** the user navigates to the dashboard
- **THEN** a confirmation dialog appears offering to stay or discard
- **AND** closing the tab triggers the browser's beforeunload prompt

### Requirement: Keyboard shortcuts and distraction-free mode
The editor MUST support `Ctrl/Cmd+S` (save), `Ctrl/Cmd+B`/`Ctrl/Cmd+I` (bold/italic), `Ctrl/Cmd+K` (insert/edit link — reserved for link, not Insert Image), `Ctrl/Cmd+P` (publish with confirmation), and a focus-free (distraction-free) mode toggle that removes chrome and restores it on exit.

#### Scenario: Distraction-free toggle
- **GIVEN** the editor open
- **WHEN** the user activates focus-free mode
- **THEN** sidebar, toolbar, and header chrome are removed leaving title, writing surface, and status
- **AND** re-activating restores the previous layout

### Requirement: Deferred features stay out
The approved initial formatting toolbar is Bold, Italic, Insert Link, and Insert Image (with a Preview toggle). Toolbar extensions beyond that initial set (headings, code blocks, lists), side-by-side split view, autosave, SEO analysis, advanced publishing controls, and any WYSIWYG engine MUST be treated as deferred and MUST NOT be presented as available in the MVP.

#### Scenario: No autosave claim
- **GIVEN** the editor open
- **WHEN** edits are made and time passes
- **THEN** no background save occurs and no "auto-saved" message is shown

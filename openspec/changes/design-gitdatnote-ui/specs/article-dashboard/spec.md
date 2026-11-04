# Article dashboard — Delta specification

## ADDED Requirements

### Requirement: Article list
The dashboard MUST list articles in the selected repository's configured content root, each row showing a small article icon, title, optional description or excerpt, a status badge (Published = success/green; Draft = neutral/gray; text always present, never color alone), and an "Article date" (front-matter date in the MVP; commit timestamps only if the API later provides them). A sort control MUST be present (default: newest article date).

#### Scenario: Listing articles
- **GIVEN** the content root contains five Markdown articles (three published, two draft)
- **WHEN** the dashboard loads
- **THEN** all five rows render with correct titles, excerpts, and status badges
- **AND** a loading skeleton is shown while fetching and replaced without layout shift

#### Scenario: Last-updated source
- **GIVEN** the content API returns no commit timestamps
- **WHEN** a row renders
- **THEN** the row shows the front-matter date as the updated indicator only when present
- **AND** no timestamp is fabricated

### Requirement: Filters and search
The dashboard MUST provide All/Drafts/Published filter tabs and a client-side search field over loaded articles. Filtering and search MUST NOT require a backend search API.

#### Scenario: Filter drafts
- **GIVEN** mixed draft/published articles
- **WHEN** the user selects the Drafts tab
- **THEN** only draft articles remain visible and the selection is announced to screen readers

#### Scenario: Search with no matches
- **GIVEN** loaded articles
- **WHEN** the user searches a term matching nothing
- **THEN** a no-match state is shown with the query and a clear-search action

### Requirement: New article action
The dashboard MUST offer a prominent New Article action that creates a new Markdown file in the content root via the content API with the CSRF header and shared front-matter generation.

#### Scenario: Create article
- **GIVEN** write access to the selected repository
- **WHEN** the user activates New Article
- **THEN** a new draft file is created and the editor opens on it

#### Scenario: Create conflict
- **GIVEN** a file with the generated name already exists
- **WHEN** creation is attempted
- **THEN** a `FILE_EXISTS` error message is shown at the action
- **AND** no duplicate file is written

### Requirement: Dashboard states
The dashboard MUST define distinct, honest states for: loading, empty repository, no repositories connected, search no-match, read-only repository, access revoked, and GitHub API unavailable.

#### Scenario: No repositories
- **GIVEN** the session is active but no repositories are connected
- **WHEN** the dashboard loads
- **THEN** an empty state with a single onboarding call-to-action is shown

#### Scenario: GitHub unavailable
- **GIVEN** the API returns `GITHUB_UNAVAILABLE` with `retryable: true`
- **WHEN** the dashboard renders the error
- **THEN** the safe envelope message is shown with a retry control
- **AND** no partial list is presented as complete

#### Scenario: Access revoked
- **GIVEN** the repository returns `REPO_NOT_ALLOWED` for reads
- **WHEN** the dashboard renders
- **THEN** a banner explains access was revoked and offers reconnect
- **AND** stale article rows are not shown as current

### Requirement: Keyboard navigation
The article list MUST be a semantic list of focusable rows (each row a real link/button); Tab MUST move between rows, Enter/Space MUST open the focused article, and the per-article action menu MUST be keyboard-reachable and navigable. Roving-tabindex complexity is deliberately avoided in favor of semantic controls.

#### Scenario: Keyboard-only browse
- **GIVEN** a populated list
- **WHEN** the user tabs into the list and uses arrow keys
- **THEN** row focus moves visibly without page scroll surprises
- **AND** Enter opens the focused article in the editor

### Requirement: Per-article actions
The per-article action menu MUST expose only actions backed by existing APIs. In the MVP, Edit is the sole wired action; delete MUST NOT be offered until a deletion API exists.

#### Scenario: Action menu contents
- **GIVEN** an article row
- **WHEN** the user opens its action menu
- **THEN** Edit is available and no delete control exists

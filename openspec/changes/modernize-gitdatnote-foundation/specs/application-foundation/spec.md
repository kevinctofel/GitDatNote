# application-foundation — Delta specification

## ADDED Requirements

### Requirement: Repeatable local development environment
The system SHALL provide documented commands to install dependencies, run the frontend and backend, check types, lint, and run automated tests. The documented environment SHALL require **Node.js 24 LTS** (not an end-of-life release) and a configured GitHub App (see `github-connection` spec).

#### Scenario: New contributor starts locally
- **GIVEN** a supported Node environment (24 LTS) and documented configuration including GitHub App credentials and session encryption key
- **WHEN** a contributor follows the setup instructions
- **THEN** the application starts without requiring the contributor to embed privileged secrets in browser code

#### Scenario: Frontend and backend run in development
- **GIVEN** dependencies installed and environment variables set
- **WHEN** the contributor runs the development command
- **THEN** the Vite dev server serves the frontend and the Node backend is reachable via the configured proxy

### Requirement: Single-package TypeScript project structure
The project SHALL use a single-package TypeScript architecture with `src/web` (React/Vite), `src/server` (Node backend), and `src/shared` (platform-agnostic types, validation, and error domain). Shared code MUST NOT depend on browser or Node-specific APIs.

#### Scenario: Shared code is platform-agnostic
- **GIVEN** a module in `src/shared/`
- **WHEN** the module is imported by both `src/web/` and `src/server/`
- **THEN** the module compiles and runs in both environments without platform-specific imports

### Requirement: Safe default application state
The UI SHALL show whether GitHub is connected and SHALL display understandable loading, empty, and error states without falsely claiming that remote changes succeeded.

#### Scenario: GitHub is not connected
- **GIVEN** no valid session
- **WHEN** the app loads
- **THEN** a clear Connect GitHub action is offered and privileged content actions are inaccessible

#### Scenario: Content operation fails
- **GIVEN** a connected user
- **WHEN** a create or update operation returns a non-retryable error (e.g., conflict, invalid path)
- **THEN** the UI displays the error message from the server response without implying the save succeeded

#### Scenario: Content operation fails with retryable error
- **GIVEN** a connected user
- **WHEN** a create or update operation returns a retryable error (rate limit, GitHub unavailable)
- **THEN** the UI reports the failure and offers a retry action with safe guidance

### Requirement: Safe Markdown rendering
The web layer SHALL render post Markdown for preview with HTML sanitization. Unsanitized rendered Markdown MUST NOT be assigned to `innerHTML`. The sanitizer allowlist MUST strip scripts, event handlers, `javascript:`/`data:` URIs, and embedded script/iframe/object tags. The server content service stores and returns raw Markdown and MUST NOT render it server-side.

#### Scenario: Sanitized preview
- **GIVEN** Markdown containing embedded HTML such as `<script>`, an `onerror=` attribute, a `javascript:` link, or a raw `<iframe>`
- **WHEN** the web layer renders the preview
- **THEN** the rendered output contains no active script, event handler, dangerous URI, or embedded frame (they are removed or inert)

#### Scenario: XSS regression tests exist
- **GIVEN** the web test suite
- **WHEN** the suite is run
- **THEN** cases asserting neutralization of `<script>`, `on*` attributes, `javascript:` links, and raw `<iframe>`/`<object>` are present and pass

### Requirement: Automated quality gates
The repository SHALL expose repeatable lint, type-check, build, and test commands that can run in continuous integration. Unit and mocked integration tests SHALL use Vitest. Browser end-to-end tests SHALL use Playwright.

#### Scenario: CI on a proposed change
- **GIVEN** a contributor opens a change request
- **WHEN** CI runs
- **THEN** failures in lint, type-check, build, unit tests, or mocked integration tests are visible and block treating the feature as verified

#### Scenario: Real GitHub integration tests are opt-in
- **GIVEN** a CI environment without the `GITHUB_INTEGRATION=true` flag
- **WHEN** CI runs
- **THEN** real GitHub integration tests are skipped and do not block the build

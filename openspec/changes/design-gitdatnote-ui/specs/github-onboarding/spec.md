# GitHub onboarding — Delta specification

## ADDED Requirements

### Requirement: Four-step flow
Onboarding MUST present a single-page, split-panel stepped flow: a left column with the four-step vertical stepper and a right elevated content card, in this order: (1) Connect GitHub, (2) Choose an authorized repository, (3) Configure the publishing site, (4) You're ready. A progress indicator MUST show the current step.

#### Scenario: Happy path (requires the site-config persistence endpoint)
- **GIVEN** the GitHub App is installed, the user has at least one writable repository, **and the site-config persistence endpoint exists**
- **WHEN** the user completes all four steps
- **THEN** the endpoint persists the site configuration and the dashboard opens with that repository selected
- **AND** the success shown reflects a real server-persisted configuration

#### Scenario: Connect card
- **GIVEN** step 1 (Connect GitHub)
- **WHEN** it renders
- **THEN** the card shows the GitHub logo and a full-width accent "Connect GitHub" CTA with an external-link icon
- **AND** trust microcopy with a lock icon appears beneath the CTA

#### Scenario: Stepper visual states
- **GIVEN** the onboarding flow
- **WHEN** a step is active
- **THEN** the active step is highlighted in solid accent and the right card shows that step's content

#### Scenario: Placeholder state when the persistence endpoint is absent
- **GIVEN** the onboarding flow, and the site-config persistence endpoint does not yet exist
- **WHEN** the user completes all four steps
- **THEN** steps 3/4 render as a visual placeholder (selection summary) and the dashboard opens with the repository selected
- **AND** no persistent site configuration is claimed as saved
- **AND** no success message implies persistence occurred (no false success, no invented persistence)

### Requirement: Connect step permissions
The Connect step MUST explain that GitDatNote requests Contents read/write and Metadata read, only for repositories the user selects, and MUST NOT request or imply repository-creation permission.

#### Scenario: Permissions disclosed
- **GIVEN** the onboarding Connect step
- **WHEN** it renders
- **THEN** the required scopes are shown in plain language
- **AND** no repository-creation permission is mentioned or requested

### Requirement: Repository choice
The repository step MUST list repositories from `GET /api/repositories` with `owner/name` and read-only indicators, allow selecting a read-only repository with a visible warning, and handle the no-eligible-repositories case.

#### Scenario: Read-only selected
- **GIVEN** a repository with `canWrite: false`
- **WHEN** the user selects it
- **THEN** a visible "read-only" warning is shown
- **AND** downstream write capabilities are expected to be disabled

#### Scenario: No eligible repositories
- **GIVEN** the user has no accessible repositories
- **WHEN** the repository step renders
- **THEN** an explanation and guidance are shown (check App installation / repository access)
- **AND** the flow does not proceed to configuration

### Requirement: Site configuration
The Configure step MUST capture the content root, explain exactly where Markdown files will be stored, and include the image-directory setting (default `Images/` at the repository root, configurable per site). It MUST validate the content root client-side using shared path rules and MUST act as a visual placeholder until a site-config persistence endpoint exists (a future backend/API dependency).

#### Scenario: Invalid content root
- **GIVEN** a content-root value like `../../etc` or an absolute path
- **WHEN** the user tries to proceed
- **THEN** a field-level validation error is shown and the step does not advance

#### Scenario: Ownership stated
- **GIVEN** the Configure step
- **WHEN** it renders
- **THEN** a plain statement confirms the user keeps ownership of all content in their repository

### Requirement: Onboarding error states
Onboarding MUST handle, without claiming false success: authorization canceled, missing GitHub App installation, no eligible repositories, read-only access, invalid content root, GitHub API failures, returning users, previously configured sites, and revoked permissions.

#### Scenario: Authorization canceled
- **GIVEN** the user cancels GitHub authorization
- **WHEN** control returns
- **THEN** a safe message and retry are shown
- **AND** no session or connected state is implied

#### Scenario: Returning user
- **GIVEN** a user with previously configured sites
- **WHEN** they reach onboarding
- **THEN** the flow is skipped or prefilled to let them re-select or edit an existing site
- **AND** they land on the dashboard without redundant steps

#### Scenario: Revoked permissions
- **GIVEN** previously revoked repository access
- **WHEN** the user attempts to continue
- **THEN** a reconnect prompt is shown
- **AND** no save/publish success is displayed

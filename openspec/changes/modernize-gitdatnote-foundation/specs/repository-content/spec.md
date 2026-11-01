# repository-content — Delta specification

## ADDED Requirements

### Requirement: List and read approved repository content
The system SHALL read files only from permitted repositories and configured content roots, and SHALL return explicit errors for missing or inaccessible content.

#### Scenario: Read permitted Markdown file
- **GIVEN** an authorized repository and a valid relative Markdown path under an approved root
- **WHEN** the user requests the file
- **THEN** the service returns content and version information without modifying the repository

#### Scenario: Reject invalid traversal path
- **GIVEN** an authenticated user
- **WHEN** the request includes an absolute or traversal path outside permitted roots
- **THEN** the service rejects the request without contacting an unauthorized file

### Requirement: Create without overwriting
The system SHALL create a new Markdown file in an approved directory and SHALL reject a conflicting pre-existing target.

#### Scenario: Duplicate file
- **GIVEN** a file already exists at the selected path
- **WHEN** a create operation targets that path
- **THEN** the service returns a conflict, preserving the existing file

### Requirement: Update with version conflict detection
The system SHALL require an expected file SHA/version for an update and SHALL not silently overwrite a concurrent change.

#### Scenario: Stale version on update
- **GIVEN** an article changed in GitHub since the user loaded it
- **WHEN** the user submits an update using the original SHA
- **THEN** the service rejects the update with a conflict and preserves the newer repository content

### Requirement: Reliable operation status
The system SHALL distinguish successful repository writes from permission, validation, rate-limit, and connectivity failures.

#### Scenario: GitHub API is temporarily unavailable
- **GIVEN** a valid request
- **WHEN** GitHub responds with a transient error or rate limit
- **THEN** the UI reports that the save did not succeed and provides safe next steps

# application-foundation — Delta specification

## ADDED Requirements

### Requirement: Repeatable local development environment
The system SHALL provide documented commands to install dependencies, run the frontend and backend, check types, lint, and run automated tests.

#### Scenario: New contributor starts locally
- **GIVEN** a supported Node environment and documented configuration
- **WHEN** a contributor follows the setup instructions
- **THEN** the application starts without requiring the contributor to embed privileged secrets in browser code

### Requirement: Safe default application state
The UI SHALL show whether GitHub is connected and SHALL display understandable loading, empty, and error states without falsely claiming that remote changes succeeded.

#### Scenario: GitHub is not connected
- **GIVEN** no valid session
- **WHEN** the app loads
- **THEN** a clear Connect GitHub action is offered and privileged content actions are inaccessible

### Requirement: Automated quality gates
The repository SHALL expose repeatable lint, type-check, build, and test commands that can run in continuous integration.

#### Scenario: CI on a proposed change
- **GIVEN** a contributor opens a change request
- **WHEN** CI runs
- **THEN** failures in those checks are visible and block treating the feature as verified

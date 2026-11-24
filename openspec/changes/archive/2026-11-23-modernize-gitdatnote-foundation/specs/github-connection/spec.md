# github-connection — Delta specification

## ADDED Requirements

### Requirement: Secure GitHub authorization
The system SHALL allow a user to connect GitHub through a GitHub App authorization flow with fine-grained repository permissions (`Contents: read/write`, `Metadata: read`) and server-side credential handling. It MUST NOT expose privileged credentials in frontend bundles, browser storage, or logs. The App MUST NOT have repository-creation permission.

The web authorization flow MUST use the App's **client ID** and **client secret**. The App's **private key** and **App ID** are used only for App-level JWT / installation-token authentication and MUST NOT be used for the user web flow. The authorization request MUST request the `offline_access` scope so GitHub returns an expiring user access token and a refresh token.

#### Scenario: Successful authorization
- **GIVEN** a user begins authorization
- **WHEN** the GitHub flow completes with validated state and appropriate permissions
- **THEN** the user has an authenticated server-managed session and sees the connected account

#### Scenario: Authorization is denied or state is invalid
- **GIVEN** a user starts authorization
- **WHEN** consent is denied or callback state does not validate
- **THEN** no authenticated session is created and the user sees a safe recovery message with a retry option

#### Scenario: Token is revoked or installation removed
- **GIVEN** a previously connected user whose GitHub App installation has been revoked
- **WHEN** they attempt a privileged action
- **THEN** the server detects the invalid token, invalidates the session, and the UI offers reconnection without reporting success

### Requirement: Token expiration and refresh
The system SHALL model GitHub App user access tokens as short-lived. It SHALL persist the user access token, the refresh token, and both expiration timestamps (encrypted), and SHALL not assume that a token never expires.

#### Scenario: Access token expires, refresh succeeds
- **GIVEN** a session whose user access token has expired but whose refresh token is still valid
- **WHEN** the user performs a privileged action
- **THEN** the server refreshes the token using the stored refresh token, stores the new access token and new refresh token (rotating both), and completes the action using the new token

#### Scenario: Refresh token has expired
- **GIVEN** a session whose refresh token is expired or invalid (GitHub returns `bad_refresh_token`)
- **WHEN** the user performs a privileged action
- **THEN** the server cannot recover the token, invalidates the session, and prompts the user to reconnect by re-running the web authorization flow

#### Scenario: Refresh token is used once
- **GIVEN** a session with a stored refresh token
- **WHEN** the server refreshes using that token
- **THEN** the previous refresh token is invalidated and can never be used again (rotation is enforced)

### Requirement: CSRF protection
The system SHALL protect **all state-changing API requests (POST, PUT, DELETE) — including `POST /api/auth/logout`** — with a per-session CSRF token carried in the `X-CSRF-Token` header. The token SHALL be generated server-side, stored in the session database, and returned to the client via the session endpoint. The header is the single accepted location for the token; it is never read from the request body, a cookie, or the query string.

#### Scenario: Valid CSRF token
- **GIVEN** an authenticated user with a valid CSRF token
- **WHEN** they submit a POST or PUT request with the correct `X-CSRF-Token` header
- **THEN** the request is processed

#### Scenario: Missing or invalid CSRF token
- **GIVEN** an authenticated user
- **WHEN** they submit any state-changing request (POST, PUT, DELETE, including logout) without a CSRF token or with an invalid token
- **THEN** the server rejects the request with `403 CSRF_INVALID` and no state change occurs

### Requirement: Secure session cookies
Session cookies SHALL be set with `HttpOnly`, `SameSite=Lax`, and `Secure` (in production) attributes. Sessions SHALL survive ordinary server restarts.

#### Scenario: Session survives restart
- **GIVEN** an active session
- **WHEN** the server restarts
- **THEN** the session is still valid and the user does not need to re-authenticate

#### Scenario: Cookie is not accessible to scripts
- **GIVEN** an active session cookie
- **WHEN** client-side JavaScript attempts to read the cookie
- **THEN** the cookie value is not accessible (HttpOnly)

### Requirement: Repository-scoped authorization
The system SHALL restrict repository operations to repositories authorized for the operation, where authorization requires **both** the connected user's permission **and** the GitHub App's installation access on the repository (scoped to the required `read`/`write` permission). The `GET /api/repositories` endpoint SHALL return each accessible repository with `canRead` and `canWrite` flags and its configured content root. A repository that is visible but not writable MUST be treated as read-only for that session.

#### Scenario: Attempted access to an unauthorized repository
- **GIVEN** a connected user without permission for a repository, or an App that is not installed on it
- **WHEN** the browser submits an API request referencing that repository
- **THEN** the backend denies the operation with `403 REPO_NOT_ALLOWED` without leaking private content

#### Scenario: Write to a visible but not writable repository
- **GIVEN** a repository the user can read but the App is installed read-only (or the user has no write permission)
- **WHEN** the user submits a create or update operation on that repository
- **THEN** the backend denies the operation with `403 REPO_NOT_ALLOWED` and the UI disables write actions for that repository

#### Scenario: Repository list is scoped to the user
- **GIVEN** a connected user
- **WHEN** they request the repository list
- **THEN** only repositories accessible through their GitHub account are returned, each with `canRead` and `canWrite` reflecting the effective permission

### Requirement: Session lifecycle
The system SHALL support logout and gracefully handle expired or revoked authorization.

#### Scenario: Session expires
- **GIVEN** a previously connected user whose session has exceeded the maximum age
- **WHEN** they attempt a privileged action
- **THEN** the action fails with `401 UNAUTHORIZED` and the UI offers reconnection without reporting success

#### Scenario: Disconnect account
- **GIVEN** an active session
- **WHEN** the user disconnects
- **THEN** the local session is invalidated, the session cookie is cleared, and privileged UI actions are unavailable

#### Scenario: Logout invalidates CSRF token
- **GIVEN** an active session with a CSRF token
- **WHEN** the user logs out
- **THEN** the CSRF token is invalidated and cannot be used for further requests

### Requirement: No credentials in browser or logs
The system MUST NOT expose OAuth tokens, GitHub App private keys, session encryption keys, or file content in browser bundles, browser storage, or server logs.

#### Scenario: Browser bundle inspection
- **GIVEN** a production frontend build
- **WHEN** the bundle is inspected for secrets
- **THEN** no OAuth tokens, private keys, or encryption keys are present

#### Scenario: Server log inspection
- **GIVEN** a server processing create/update operations
- **WHEN** the logs are inspected
- **THEN** no tokens, session IDs, CSRF tokens, or file content appear in log lines

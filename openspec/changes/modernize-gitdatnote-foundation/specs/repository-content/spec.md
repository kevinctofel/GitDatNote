# repository-content — Delta specification

## ADDED Requirements

### Requirement: List directory contents
The system SHALL list the contents of a directory within the configured content root of an authorized repository. The response SHALL include each child's name, type (file or directory), blob SHA, and size.

#### Scenario: List content root directory
- **GIVEN** an authorized repository and an empty or root path
- **WHEN** the user requests the directory listing
- **THEN** the service returns a list of children (name, type, sha, size) without modifying the repository

#### Scenario: List nested directory
- **GIVEN** an authorized repository with a content root of `Journal` and a subdirectory `2024/December/`
- **WHEN** the user requests the listing for path `2024/December`
- **THEN** the service returns the children of that nested directory

### Requirement: Read approved repository file
The system SHALL read files only from permitted repositories and within the configured content root. The response SHALL include the file content (UTF-8 decoded), the git blob SHA (version identifier), and the file size.

#### Scenario: Read permitted Markdown file
- **GIVEN** an authorized repository and a valid relative Markdown path under the content root
- **WHEN** the user requests the file
- **THEN** the service returns content and the blob SHA without modifying the repository

#### Scenario: Read non-existent file
- **GIVEN** an authorized repository and a path that does not exist
- **WHEN** the user requests the file
- **THEN** the service returns `404 FILE_NOT_FOUND`

### Requirement: Path validation
The system SHALL validate all file paths against the configured content root. Paths MUST be canonicalized, and requests containing absolute paths, traversal sequences that escape the content root, or null bytes MUST be rejected without contacting the GitHub API.

#### Scenario: Reject absolute path
- **GIVEN** an authenticated user
- **WHEN** the request includes an absolute path (starting with `/`)
- **THEN** the service rejects the request with `422 PATH_INVALID` without contacting GitHub

#### Scenario: Reject traversal path
- **GIVEN** an authenticated user with content root `Journal`
- **WHEN** the request includes a path like `../../etc/passwd` or `../config.yaml` that escapes the content root after canonicalization
- **THEN** the service rejects the request with `422 PATH_INVALID` without contacting GitHub

#### Scenario: Reject null byte in path
- **GIVEN** an authenticated user
- **WHEN** the request includes a path containing a null byte
- **THEN** the service rejects the request with `422 PATH_INVALID`

#### Scenario: Allow legitimate nested paths
- **GIVEN** an authenticated user with content root `Journal`
- **WHEN** the request includes a path like `2024/December/my-post.md`
- **THEN** the path is accepted and resolved to `Journal/2024/December/my-post.md`

### Requirement: Create without overwriting
The system SHALL create a new file in an approved directory within the content root and SHALL reject a conflicting pre-existing target. The foundation content API exposes only list, read, create, and update; **file deletion is not part of this API** (deferred to the article editor change).

#### Scenario: Create new file
- **GIVEN** an authorized repository and a path that does not exist
- **WHEN** the user requests a file creation with valid content
- **THEN** the file is created, a commit is made with an operation-derived message, and the response returns the new blob SHA

#### Scenario: Duplicate file
- **GIVEN** a file already exists at the selected path
- **WHEN** a create operation targets that path
- **THEN** the service returns `409 FILE_EXISTS`, preserving the existing file

#### Scenario: Content too large
- **GIVEN** an authorized repository
- **WHEN** a create operation includes content exceeding 1 MB
- **THEN** the service returns `422 CONTENT_TOO_LARGE` without contacting GitHub

### Requirement: Update with version conflict detection
The system SHALL require an expected file blob SHA for an update and SHALL not silently overwrite a concurrent change.

#### Scenario: Successful update
- **GIVEN** a file with known blob SHA
- **WHEN** the user submits an update with the correct expected SHA
- **THEN** the file is updated, a commit is made, and the response returns the new blob SHA

#### Scenario: Stale version on update
- **GIVEN** a file changed in GitHub since the user loaded it
- **WHEN** the user submits an update using the original SHA
- **THEN** the service rejects the update with `409 SHA_CONFLICT`, preserves the newer repository content, and includes the current SHA in the response

#### Scenario: Update non-existent file
- **GIVEN** a path that does not exist
- **WHEN** the user submits an update
- **THEN** the service returns `404 FILE_NOT_FOUND`

### Requirement: UTF-8 encoding
All file content SHALL be encoded as UTF-8 in API requests and responses. Non-ASCII content (accented characters, CJK, emoji) MUST round-trip correctly.

#### Scenario: Non-ASCII content round-trip
- **GIVEN** an authorized repository
- **WHEN** a file containing accented characters, CJK text, and emoji is created
- **THEN** reading the file back returns the exact original content

### Requirement: Commit metadata
Commit messages SHALL be derived from the operation type and file path. Committer identity SHALL NOT be invented, hardcoded, or fabricated, and the authenticated user's profile name or email MUST NOT be embedded as the committer (a profile email can be missing or private). The application SHALL rely on GitHub's commit attribution (omitting the committer field, or setting only the user's public login and, when publicly visible, their email) and MUST NOT embed a personal email address.

#### Scenario: Default commit message
- **GIVEN** a create operation for path `2024/December/my-post.md`
- **WHEN** no custom message is provided
- **THEN** the commit message is `Create 2024/December/my-post.md`

#### Scenario: Committer identity uses GitHub attribution
- **GIVEN** an authenticated GitHub user whose profile email is private or absent
- **WHEN** a file operation is committed
- **THEN** the application does not fabricate or embed an email; it omits the committer email and lets GitHub attribute the commit to the authenticated user (the author name may be set to the public login only)

#### Scenario: No hardcoded identity
- **GIVEN** any create or update operation
- **WHEN** the commit is made
- **THEN** no personal name, email address, or repository identifier is hardcoded in source code or the commit

### Requirement: Reliable operation status
The system SHALL distinguish successful repository writes from permission, validation, rate-limit, and connectivity failures. All errors SHALL use the standard error response format with a machine-readable code, human-readable message, and retryable flag.

#### Scenario: GitHub API is temporarily unavailable
- **GIVEN** a valid request
- **WHEN** GitHub responds with a transient error or rate limit
- **THEN** the UI reports that the save did not succeed and provides safe next steps with a retry option

#### Scenario: Rate limit
- **GIVEN** a valid request
- **WHEN** GitHub responds with HTTP 429
- **THEN** the server returns `429 RATE_LIMITED` with a retryable flag and the `Retry-After` value (if available)

#### Scenario: Permission denied
- **GIVEN** a valid request
- **WHEN** GitHub responds with HTTP 403
- **THEN** the server returns `403 REPO_NOT_ALLOWED` with a non-retryable flag

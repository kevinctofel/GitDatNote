# Image management — Delta specification

## ADDED Requirements

### Requirement: Repository-stored images
Image files MUST be stored in the user's authorized GitHub repository under a per-repository/site configured image directory (default `Images/` at the repository root, configurable per site). **The configured image directory MAY be located outside the Markdown content root.** Images MUST NOT be sent to an undocumented external hosting service.

#### Scenario: No external host
- **GIVEN** an image-insertion flow
- **WHEN** an image is inserted or uploaded
- **THEN** the resulting reference points to a path in the repository's configured image directory
- **AND** no external URL is introduced unless the user explicitly provided one

### Requirement: Insert Image action
The editor MUST offer an Insert Image action supporting three sources: upload from device, select from the repository library, and insert an existing URL. The result MUST use portable Markdown image syntax inserted at the intended cursor position when supported.

#### Scenario: Insert from URL
- **GIVEN** the Insert Image dialog, From URL tab
- **WHEN** the user enters a valid http/https URL and alt text
- **THEN** `![alt](url)` is inserted at the cursor (or end of document with a clear notice if mid-text insertion is unsupported)
- **AND** the preview renders it

#### Scenario: Upload deferred
- **GIVEN** the image-management upload API does not yet exist
- **WHEN** the Upload and From-repository tabs are shown
- **THEN** they are clearly disabled and labeled unavailable
- **AND** no control implies a successful upload occurred

### Requirement: Upload interaction (future)
When the upload API exists, the upload interaction MUST support: file picker, filename display, file size, image dimensions, upload progress, success, validation errors, failure with retry, duplicate-filename handling, repository permission errors, and cancellation where technically supported.

#### Scenario: Upload success
- **GIVEN** the upload API available and a valid image under the size limit
- **WHEN** the user uploads
- **THEN** progress is shown, then a success with the inserted Markdown path
- **AND** the file exists in the repository image directory

#### Scenario: Upload permission error
- **GIVEN** a repository without write permission
- **WHEN** the user uploads
- **THEN** a `REPO_NOT_ALLOWED` message is shown
- **AND** no partial file or success is claimed

### Requirement: Supported formats
The initial supported formats MUST be JPEG, PNG, WebP, and GIF. SVG MUST be deferred until a security and sanitization policy exists. AVIF and image transformations are deferred.

#### Scenario: SVG rejected initially
- **GIVEN** an SVG file
- **WHEN** it is offered for upload
- **THEN** it is rejected as an unsupported format in the initial version

#### Scenario: GIF accepted
- **GIVEN** a GIF file
- **WHEN** it is offered for upload
- **THEN** it is accepted as a supported format

### Requirement: Image metadata and accessibility
The image controls MUST provide alternative text, an optional caption, filename, dimensions, file size, preview, and insertion into an article. Meaningful alt text MUST be encouraged; decorative images MUST be distinguishable from informative images.

#### Scenario: Decorative image
- **GIVEN** the user marks an image as decorative
- **WHEN** it is inserted
- **THEN** the Markdown uses an empty alt (`alt=""`)
- **AND** this is distinguishable from an omitted alt in the control

#### Scenario: Informative image
- **GIVEN** the user provides alt text
- **WHEN** the image is inserted
- **THEN** the Markdown includes the provided alt text

### Requirement: Repository image library
A lightweight image browser MUST support images within the selected repository's configured image directory, with thumbnail previews, filenames, selection, an Insert action, and distinct empty/loading/error/permission-denied states. No external digital-asset-management service MUST be assumed.

#### Scenario: Empty library
- **GIVEN** the configured image directory has no images
- **WHEN** the library opens
- **THEN** an empty state is shown with guidance
- **AND** no images are fabricated

#### Scenario: Permission denied
- **GIVEN** no read permission for the image directory
- **WHEN** the library opens
- **THEN** a permission-denied state is shown
- **AND** no thumbnails are claimed as loaded

### Requirement: Safe path and storage configuration
Image paths MUST use safe relative paths, reusing shared path validation (reject absolute, traversal-escaping, and null-byte paths). Image path validation and authorization are separate from content-root validation, and image writes MUST require repository write authorization. Safe Markdown URL generation MUST derive from the actual article path and image location.

#### Scenario: Traversal rejected
- **GIVEN** an image path attempt like `../../outside.png`
- **WHEN** the path is validated
- **THEN** it is rejected
- **AND** no file is written or referenced outside the repository image directory

#### Scenario: No silent overwrite
- **GIVEN** a file with the same name already exists in the image directory
- **WHEN** an upload or insertion targets that name
- **THEN** a conflict is surfaced for resolution
- **AND** the existing file is not silently overwritten

#### Scenario: Storage configuration defines required items
- **GIVEN** the storage configuration for a site
- **WHEN** image operations are performed
- **THEN** the configuration defines safe relative paths, repository permission checks, filename normalization, file-size limits, allowed content types, duplicate detection, existing-file conflict handling (never silent overwrite), safe Markdown URL generation, prevention of path traversal, and correct image paths for the configured Eleventy site

#### Scenario: Article-relative URL from actual paths
- **GIVEN** an article at `<contentRoot>/journal/2026/11-02-2026.md` and an image at `<repoRoot>/Images/photo.webp`
- **WHEN** the image reference is generated
- **THEN** the Markdown URL is computed from the article's actual path to the image's actual location (here `../../../Images/photo.webp`)
- **AND** no fixed `../Images/` example is assumed universal

#### Scenario: Image write requires write authorization and stays in the image directory
- **GIVEN** a repository without write authorization, or a target path outside the configured image directory
- **WHEN** an image operation is attempted
- **THEN** the operation is rejected (no write authorization, or the path escapes the image directory)
- **AND** no file is written and no success is claimed

### Requirement: Implementation boundaries
Functional image upload, image processing, and repository image management MUST be deferred until the appropriate authenticated GitHub repository image APIs exist. The MVP MUST NOT implement these. Never create image controls that imply a successful upload when none occurred.

#### Scenario: No fake upload success
- **GIVEN** the MVP without an image API
- **WHEN** the image UI is rendered
- **THEN** no upload appears to have succeeded
- **AND** no file is written to the repository

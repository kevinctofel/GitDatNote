/**
 * Shared domain types for GitDatNote repository content operations.
 *
 * Platform-independent: no Octokit response types, no DOM types, no Node
 * types. These mirror the API contract in design.md (A-05) and the
 * `repository-content` specification.
 */

/** A repository the connected user can operate on (API `GET /api/repositories`). */
export interface Repository {
  /** Repository owner (GitHub user or organization login). */
  owner: string;
  /** Repository name. */
  name: string;
  /**
   * Content root within the repository, relative to the repository root,
   * forward slashes (e.g. `Journal`, `src/posts`).
   */
  contentRoot: string;
  /** Whether the current user may write to the repository. */
  canWrite: boolean;
  /**
   * Whether the repository is private. Field name matches the API wire
   * format (`"private"`).
   */
  private: boolean;
}

/** File content within the content root (API 200 file response). */
export interface FileContent {
  type: 'file';
  /** Path relative to the content root, forward slashes. */
  path: string;
  /** File content, UTF-8 decoded. */
  content: string;
  /** Git blob SHA as reported by the GitHub Contents API. */
  sha: string;
  /** File size in bytes. */
  size: number;
}

/** A single entry in a directory listing. */
export interface DirectoryChild {
  /** Entry name (file or directory name, not a path). */
  name: string;
  type: 'file' | 'dir';
  /** Git SHA of the entry. */
  sha: string;
  /** Entry size in bytes. */
  size: number;
}

/** A directory within the content root (API 200 directory response). */
export interface DirectoryListing {
  type: 'directory';
  /** Path relative to the content root; empty string for the root itself. */
  path: string;
  /** Immediate children of the directory. */
  children: DirectoryChild[];
}

/** Result of a content read: a file, or a directory listing. */
export type ContentResult = FileContent | DirectoryListing;

/** Machine-readable error codes (API contract, design.md A-05). */
export type ErrorDomain =
  | 'UNAUTHORIZED'
  | 'REPO_NOT_ALLOWED'
  | 'CSRF_INVALID'
  | 'PATH_INVALID'
  | 'FILE_NOT_FOUND'
  | 'FILE_EXISTS'
  | 'SHA_CONFLICT'
  | 'CONTENT_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'GITHUB_UNAVAILABLE'
  | 'INTERNAL_ERROR';

/** HTTP status values used by the standard API error format. */
export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502;

/** The `error` object of the standard API error response. */
export interface ErrorDetail {
  code: ErrorDomain;
  /** Human-readable, client-safe message. Never contains stack traces, tokens, or request content. */
  message: string;
  /** Whether the client should offer a retry (UI retry button). */
  retryable: boolean;
  status: ErrorStatus;
}

/** The standard API error response body. */
export interface ErrorResponse {
  error: ErrorDetail;
}

/**
 * Path naming convention (design.md A-02/A-05):
 * - `RelativePath`   — path relative to the content root (what the API uses).
 * - `RepositoryPath` — the same path resolved against the content root
 *   (what the GitHub Contents API addresses, relative to the repository root).
 */
export type RelativePath = string;
export type RepositoryPath = string;

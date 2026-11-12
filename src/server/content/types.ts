/**
 * Task 4.1 — GitHub repository content adapter: public types and the
 * dependency boundary.
 *
 * The content adapter is a server-only service that performs GitHub
 * Contents API operations (list, read, create, update) behind a narrow,
 * typed interface. It is deliberately transport-agnostic: it talks to a
 * small structural client view (`ContentClient`) that the real Octokit
 * satisfies, so the service is fully testable without contacting GitHub.
 *
 * CREDENTIAL HANDLING
 *
 * The adapter performs operations with the currently authenticated user's
 * GitHub App user access token — but it never obtains, stores, refreshes,
 * or manages credentials itself:
 *
 * - The caller constructs an authenticated client (see
 *   `createAuthenticatedContentClient` in `index.ts`) from the currently
 *   valid, refreshed user access token produced by the existing
 *   authenticated HTTP boundary (the Task 3.5 refresh service) and injects
 *   it at construction.
 * - The adapter holds no token fields, no session lookups, no refresh
 *   logic, and no additional session storage. The injected client is the
 *   only credential carrier and is created per operation context; it is
 *   never shared between requests or users.
 * - No browser state, personal access tokens, or application-wide
 *   privileged tokens are involved, and the adapter never performs
 *   browser-side GitHub API requests.
 *
 * AUTHORIZATION BOUNDARY
 *
 * Task 4.1 does not bypass or substitute for repository authorization.
 * Callers MUST enforce the established user-plus-App repository permission
 * checks (Task 3.4 `authorizeRepository` / the Task 3.4
 * `enforceContentBoundary` pattern: session gate, fresh per-repository
 * authorization, fail-closed mapping) BEFORE invoking any adapter
 * operation. The adapter performs no authorization of its own.
 *
 * CONTENT ROOT
 *
 * The configured content root is resolved server-side (repository
 * discovery; the `src/posts` default today) and injected at construction.
 * Browser-provided content roots are never trusted. Every operation
 * validates its path against that root with the shared
 * `validateContentPath` before any GitHub request is sent.
 *
 * ERROR CONTRACT
 *
 * Failures surface as `ContentAdapterError` whose `detail` is the shared,
 * safe `ErrorDetail` vocabulary (task 3.1 `ErrorDomain`), so future HTTP
 * handlers can map to the standard error envelope with a single
 * `errorDetail(detail)` passthrough. Messages never contain credentials,
 * tokens, Authorization headers, upstream error text, or file content:
 *
 * - A definitive GitHub 401 surfaces as `detail.code === 'UNAUTHORIZED'`
 *   and MUST remain distinguishable so the future HTTP integration can run
 *   the existing session-invalidation behavior.
 * - Rate limiting (429, or 403 with an exhausted rate-limit window)
 *   surfaces as `RATE_LIMITED` and stays distinct from an ordinary 403
 *   permission denial (`REPO_NOT_ALLOWED`).
 * - `SHA_CONFLICT` details carry the file's current blob SHA
 *   (`ShaConflictErrorDetail`) for the future `currentSha` HTTP field.
 *
 * NO ROUTES
 *
 * Task 4.1 registers no HTTP routes and changes no existing endpoints.
 */

import type {
  DirectoryListing,
  ErrorDetail,
  FileContent,
} from '../../shared/types.js';

/**
 * The minimal structural view of the GitHub client the adapter needs.
 * The installed Octokit (`octokit@3.x`, rest endpoint methods) satisfies
 * this interface directly; tests supply mocks.
 *
 * - `getContent` — `GET /repos/{owner}/{repo}/contents/{path}` (directory
 *   listing or single file object).
 * - `createOrUpdateFileContents` — `PUT /repos/{owner}/{repo}/contents/{path}`
 *   (create without `sha`, SHA-protected update with `sha`).
 */
export interface ContentReposApi {
  getContent(params: {
    readonly owner: string;
    readonly repo: string;
    readonly path: string;
  }): Promise<{ readonly data: unknown }>;
  createOrUpdateFileContents(params: {
    readonly owner: string;
    readonly repo: string;
    readonly path: string;
    readonly message: string;
    /** Base64-encoded UTF-8 file content. */
    readonly content: string;
    /** Expected blob SHA for SHA-protected updates; omitted for creates. */
    readonly sha?: string;
  }): Promise<{ readonly data: unknown }>;
}

/** A GitHub client (real Octokit or test mock) carrying the user's token. */
export interface ContentClient {
  readonly rest: { readonly repos: ContentReposApi };
}

/**
 * The content operations exposed by the adapter. Parameters follow Task
 * 4.1 exactly: repository reference plus the path relative to the
 * configured content root (and, for writes, UTF-8 content plus an optional
 * commit message / expected SHA).
 */
export interface ContentAdapter {
  /** The server-resolved content root for the target repository. */
  readonly contentRoot: string;

  /**
   * List the immediate children of a directory inside the content root.
   * `path` is relative to the content root; the empty path lists the
   * content root itself. Never recurses and never reaches outside the root.
   */
  listContent(
    owner: string,
    repo: string,
    path: string,
  ): Promise<DirectoryListing>;

  /**
   * Read a UTF-8 file inside the content root, returned exactly as stored
   * (no Markdown rendering, sanitization, or rewriting — that is the web
   * preview layer's responsibility).
   */
  readContent(
    owner: string,
    repo: string,
    path: string,
  ): Promise<FileContent>;

  /**
   * Create a new file. Fails with `FILE_EXISTS` when anything already
   * exists at the path (checked before the write; the write is never
   * silently overwritten). The commit is attributed by GitHub through the
   * authenticated token (no fabricated committer metadata).
   */
  createContent(
    owner: string,
    repo: string,
    path: string,
    content: string,
    message?: string,
  ): Promise<WriteResult>;

  /**
   * Update an existing file with SHA-based conflict detection. Fails with
   * `FILE_NOT_FOUND` when the file does not exist, and with
   * `SHA_CONFLICT` (carrying the current blob SHA) when the expected SHA
   * does not match — a newer version is never silently overwritten.
   */
  updateContent(
    owner: string,
    repo: string,
    path: string,
    content: string,
    expectedSha: string,
    message?: string,
  ): Promise<WriteResult>;
}

/**
 * Typed result of a successful write: the path relative to the content
 * root and the new blob SHA (mirrors the future `{ path, sha }` HTTP
 * responses of Tasks 4.3/4.4).
 */
export interface WriteResult {
  readonly path: string;
  readonly sha: string;
}

/**
 * Narrow service-level error for the content adapter. `detail` uses the
 * shared safe error vocabulary; `message` is the safe display message.
 * Future HTTP handlers translate it into the standard error envelope
 * without re-deriving anything (and keep a definitive `UNAUTHORIZED`
 * distinguishable for session invalidation).
 */
export class ContentAdapterError extends Error {
  constructor(
    public readonly detail: ErrorDetail,
  ) {
    super(detail.message);
    this.name = 'ContentAdapterError';
  }
}

/**
 * Dependencies injected at construction (the narrowly scoped boundary).
 *
 * - `client`: an authenticated client built from the currently valid,
 *   refreshed GitHub App user access token of the authenticated user.
 * - `contentRoot`: the content root resolved server-side for the target
 *   repository (never browser-supplied).
 */
export interface ContentAdapterDeps {
  readonly client: ContentClient;
  readonly contentRoot: string;
}

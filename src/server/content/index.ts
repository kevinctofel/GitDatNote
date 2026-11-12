/**
 * Task 4.1 — GitHub repository content adapter (Octokit).
 *
 * Concrete implementation of the `ContentAdapter` interface. This module
 * is server-only: it uses Node's `Buffer` for the UTF-8 ⇄ base64 encoding
 * required by the GitHub Contents API and the `octokit` SDK for upstream
 * calls.
 *
 * Design summary (see `types.ts` for the full boundary documentation):
 *
 * - **Credential injection.** `createAuthenticatedContentClient(accessToken)`
 *   builds the Octokit client from the currently valid, refreshed GitHub
 *   App user access token supplied by the caller (the authenticated HTTP
 *   boundary / Task 3.5 refresh service). The adapter stores no
 *   credentials of its own and performs no session or refresh logic.
 *   Retry and throttling plugins are disabled so upstream failures surface
 *   immediately through the shared error contract — writes are never
 *   automatically retried and rate limits are never client-side queued.
 * - **Authorization.** The adapter performs none; callers must have
 *   enforced the established user-plus-App repository permission checks
 *   (Task 3.4) before invoking any operation.
 * - **Path validation.** Every operation validates the repository
 *   reference (`validateRepositoryRef`) and the relative path
 *   (`validateContentPath`, kind `file` or `directory`) before any GitHub
 *   request. Invalid input never reaches Octokit.
 * - **Content validation.** Writes validate UTF-8 size with
 *   `validateMarkdownContent` before any GitHub request.
 * - **SHA handling.** Updates send the caller's expected blob SHA to
 *   GitHub (`sha` on `createOrUpdateFileContents`) and pre-check the
 *   current SHA so conflicts are detected deterministically (with the
 *   current SHA reported); a 409 during the write (a concurrent update
 *   landed between check and write) triggers one read-only refetch for
 *   the current SHA and never a write retry. Creates pre-check existence
 *   so an existing file is never silently overwritten.
 * - **Commit metadata.** No `author`/`committer` fields are ever sent:
 *   GitHub attributes the commit to the authenticated token (design
 *   decision A-05 — no invented identities, no fabricated emails).
 *   Commit messages default to `Create {relativePath}` /
 *   `Update {relativePath}`; custom messages are sanitized (newlines
 *   stripped, max 200 characters).
 * - **Errors.** Failures are `ContentAdapterError` with the shared safe
 *   `ErrorDetail`. A definitive 401 → `UNAUTHORIZED` (distinguishable for
 *   session invalidation); 429 or an exhausted 403 rate-limit window →
 *   `RATE_LIMITED`; ordinary 403 → `REPO_NOT_ALLOWED`; 404 →
 *   `FILE_NOT_FOUND`; 5xx/network → `GITHUB_UNAVAILABLE`; unexpected
 *   shapes → `INTERNAL_ERROR`. Raw Octokit messages, headers, tokens, and
 *   file content never propagate into errors or logs (this module performs
 *   no logging of its own).
 * - **Markdown.** File content is returned and stored exactly as stored
 *   (UTF-8). No rendering, sanitization, or rewriting happens here;
 *   sanitization is the web preview layer's responsibility.
 */

import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { Octokit } from 'octokit';

import {
  errorDetail,
  mapGithubHttpError,
  mapGithubNetworkError,
  shaConflictDetail,
} from '../../shared/errors.js';
import type {
  DirectoryChild,
  DirectoryListing,
  FileContent,
} from '../../shared/types.js';
import {
  validateContentPath,
  validateMarkdownContent,
} from '../../shared/validate.js';
import { validateRepositoryRef } from '../auth/permissions.js';
import {
  ContentAdapterError,
  type ContentAdapter,
  type ContentAdapterDeps,
  type ContentClient,
  type WriteResult,
} from './types.js';

/** GitHub blob SHA: 40 lowercase-hex characters (case-insensitive match). */
const BLOB_SHA_PATTERN = /^[0-9a-f]{40}$/i;

/** Maximum commit message length (design decision A-05). */
const MAX_COMMIT_MESSAGE_LENGTH = 200;

function unexpected(): ContentAdapterError {
  return new ContentAdapterError(errorDetail('INTERNAL_ERROR'));
}

function isBlobSha(value: unknown): value is string {
  return typeof value === 'string' && BLOB_SHA_PATTERN.test(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Read the HTTP status from an upstream (Octokit) error, if present. */
function readStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null || !('status' in err)) {
    return null;
  }
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 600) {
    return status;
  }
  return null;
}

/**
 * Read upstream response headers from an error object, lower-cased.
 * Octokit exposes them on `err.headers` and/or `err.response.headers`;
 * anything malformed normalizes to an empty object (conservative mapping).
 */
function readHeaders(err: unknown): Record<string, string | undefined> {
  if (typeof err !== 'object' || err === null) {
    return {};
  }
  const e = err as { headers?: unknown; response?: { headers?: unknown } };
  const source = e.response?.headers ?? e.headers;
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    return {};
  }
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (typeof value === 'string') {
      headers[key.toLowerCase()] = value;
    }
  }
  return headers;
}

function isHttpError(err: unknown, status: number): boolean {
  return readStatus(err) === status;
}

/**
 * Map an upstream failure to the shared safe error vocabulary.
 *
 * - 429, or 403 with `x-ratelimit-remaining: 0` / a rate-limit reason →
 *   `RATE_LIMITED` (distinct from ordinary 403 permission denial).
 * - 401 → `UNAUTHORIZED` (the future HTTP layer invalidates the session).
 * - 404 → `FILE_NOT_FOUND`, 409 → `SHA_CONFLICT`, 5xx →
 *   `GITHUB_UNAVAILABLE`, anything else → conservative mapping.
 * - No status (network failure) → `GITHUB_UNAVAILABLE`.
 *
 * Raw upstream messages/headers/tokens never reach the resulting error.
 */
function upstreamError(err: unknown): ContentAdapterError {
  if (err instanceof ContentAdapterError) {
    return err;
  }
  const status = readStatus(err);
  if (status === null) {
    return new ContentAdapterError(mapGithubNetworkError());
  }
  const headers = readHeaders(err);
  const rateLimited =
    status === 429 ||
    (status === 403 &&
      (headers['x-ratelimit-remaining'] === '0' ||
        headers['x-ratelimit-reason'] !== undefined));
  let retryAfterSeconds: number | undefined;
  if (rateLimited) {
    const retryAfter = headers['retry-after'];
    if (typeof retryAfter === 'string' && /^\d+$/.test(retryAfter)) {
      retryAfterSeconds = Number.parseInt(retryAfter, 10);
    }
  }
  return new ContentAdapterError(
    mapGithubHttpError(status, { rateLimited, retryAfterSeconds }),
  );
}

/** Encode UTF-8 content as base64 for the GitHub Contents API. */
function encodeContent(content: string): string {
  return Buffer.from(content, 'utf8').toString('base64');
}

/**
 * Strict base64 shape: groups of four alphabet characters, with padding
 * (`=` / `==`) only on the final group.
 */
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/;

/**
 * Strictly decode a GitHub base64 file payload into raw bytes.
 *
 * Node's built-in base64 decoder is permissive (it silently skips
 * off-alphabet characters and tolerates truncation), which would let a
 * malformed GitHub payload silently become altered Markdown. Validate the
 * string first, then round-trip: the decoded bytes must re-encode to exactly
 * the same compact string. Empty input is a valid zero-byte file. GitHub's
 * Contents API returns single-line base64; CR/LF line breaks are stripped
 * defensively, any other stray character is rejected.
 */
function decodeStrictBase64(encoded: string): Buffer | null {
  const compact = encoded.replace(/[\r\n]+/g, '');
  if (compact.length === 0) {
    return Buffer.alloc(0);
  }
  if (compact.length % 4 !== 0 || !BASE64_PATTERN.test(compact)) {
    return null;
  }
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.toString('base64') !== compact) {
    return null;
  }
  return bytes;
}

/**
 * Strictly decode GitHub's base64 file content back to UTF-8.
 *
 * Malformed or truncated base64 and byte sequences that are not valid UTF-8
 * fail with the safe `INTERNAL_ERROR` contract — never a permissive fallback
 * that would rewrite the stored Markdown. Valid Unicode content is preserved
 * exactly. Raw payloads never appear in errors or logs.
 */
function decodeContent(encoded: string): string {
  const bytes = decodeStrictBase64(encoded);
  if (bytes === null) {
    throw unexpected();
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw unexpected();
  }
}

/**
 * Sanitize a commit message (design decision A-05): strip newlines,
 * collapse the result, and limit length to 200 characters. No other
 * transformation is applied; the message never carries credentials or
 * untrusted file content (it is derived from a validated path or a
 * caller-supplied short string).
 */
function normalizeCommitMessage(message: string): string {
  return message.replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_COMMIT_MESSAGE_LENGTH);
}

/** Parse one directory entry from a GitHub Contents listing. */
function parseDirectoryEntry(entry: unknown): DirectoryChild {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw unexpected();
  }
  const e = entry as Record<string, unknown>;
  const name = e.name;
  const type = e.type;
  const sha = e.sha;
  const size = e.size;
  // Only plain files and directories are exposed; anything else (e.g.
  // symlinks, missing fields) is an unexpected upstream shape and fails
  // safely rather than returning fabricated data.
  if (typeof name !== 'string' || name.length === 0 || name.includes('/')) {
    throw unexpected();
  }
  if (type !== 'file' && type !== 'dir') {
    throw unexpected();
  }
  if (!isBlobSha(sha)) {
    throw unexpected();
  }
  if (!isNonNegativeNumber(size)) {
    throw unexpected();
  }
  return { name, type, sha, size };
}

/** The state of an existing path discovered by the write pre-checks. */
type ExistingEntry =
  | 'not_found'
  | { readonly type: 'file'; readonly sha: string }
  | { readonly type: 'dir' | 'symlink' };

/**
 * Read-only existence pre-check used by create/update. Returns the current
 * file SHA (or the path's nature) without sending any write. A 404 from
 * the Contents endpoint maps to `not_found`; authorization has already
 * been enforced by the caller, so a 404 here means "path does not exist".
 */
async function fetchExistingEntry(
  client: ContentClient,
  owner: string,
  repo: string,
  repositoryPath: string,
): Promise<ExistingEntry> {
  let response;
  try {
    response = await client.rest.repos.getContent({ owner, repo, path: repositoryPath });
  } catch (err) {
    const mapped = upstreamError(err);
    if (mapped.detail.code === 'FILE_NOT_FOUND') {
      return 'not_found';
    }
    throw mapped;
  }
  const data = response.data;
  if (Array.isArray(data)) {
    return { type: 'dir' };
  }
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    if (d.type === 'file' && isBlobSha(d.sha)) {
      return { type: 'file', sha: d.sha };
    }
    if (d.type === 'symlink') {
      return { type: 'symlink' };
    }
  }
  throw unexpected();
}

/**
 * Extract the new blob SHA from a successful Contents write response.
 * Returns `null` for any unexpected shape (the caller fails safely).
 */
function readWriteResultSha(response: { data: unknown }): string | null {
  const data = response.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null;
  }
  const content = (data as Record<string, unknown>).content;
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    return null;
  }
  const sha = (content as Record<string, unknown>).sha;
  return isBlobSha(sha) ? sha : null;
}

/**
 * Build the authenticated content client for a currently valid, refreshed
 * GitHub App user access token. Construct one per operation context (the
 * caller refreshes via the existing token-refresh service); never share a
 * client between requests or users, and never store it in long-lived
 * server state.
 *
 * `retry: false` and `throttling: false` keep the error contract exact:
 * failed requests surface immediately as the shared `ErrorDetail`
 * vocabulary (no automatic write retries, no client-side rate-limit
 * queuing — a 429 maps straight to `RATE_LIMITED`).
 */
export function createAuthenticatedContentClient(accessToken: string): ContentClient {
  return new Octokit({
    auth: accessToken,
    retry: false,
    throttling: false,
  });
}

/**
 * Construct the content adapter for one operation context: an
 * authenticated client (caller-built from the refreshed user token) and
 * the server-resolved content root for the target repository.
 *
 * See `types.ts` for the full credential/authorization documentation.
 * All operation failures are `ContentAdapterError`.
 */
export function createContentAdapter(deps: ContentAdapterDeps): ContentAdapter {
  const { client, contentRoot } = deps;

  // The resolved content root is server configuration, never browser
  // input; validate it once so a malformed root can never be used.
  const rootValidation = validateContentPath(contentRoot, '', 'directory');
  if (!rootValidation.ok) {
    throw new ContentAdapterError(rootValidation.error);
  }

  const validateRepoRef = (owner: string, repo: string): ContentAdapterError | null => {
    if (!validateRepositoryRef(owner, repo)) {
      return new ContentAdapterError(
        errorDetail('PATH_INVALID', 'The repository reference is invalid.'),
      );
    }
    return null;
  };

  const listContent = async (
    owner: string,
    repo: string,
    path: string,
  ): Promise<DirectoryListing> => {
    const refError = validateRepoRef(owner, repo);
    if (refError !== null) {
      throw refError;
    }
    const validation = validateContentPath(contentRoot, path, 'directory');
    if (!validation.ok) {
      throw new ContentAdapterError(validation.error);
    }

    let response;
    try {
      response = await client.rest.repos.getContent({
        owner,
        repo,
        path: validation.repositoryPath,
      });
    } catch (err) {
      throw upstreamError(err);
    }

    const data = response.data;
    if (!Array.isArray(data)) {
      // A single-object response means the path is a file (or an
      // unexpected object), not a directory: it is not a listing.
      throw new ContentAdapterError(errorDetail('FILE_NOT_FOUND'));
    }
    const children: DirectoryChild[] = [];
    for (const entry of data) {
      children.push(parseDirectoryEntry(entry));
    }
    return {
      type: 'directory',
      path: validation.relativePath,
      children,
    };
  };

  const readContent = async (
    owner: string,
    repo: string,
    path: string,
  ): Promise<FileContent> => {
    const refError = validateRepoRef(owner, repo);
    if (refError !== null) {
      throw refError;
    }
    const validation = validateContentPath(contentRoot, path, 'file');
    if (!validation.ok) {
      throw new ContentAdapterError(validation.error);
    }

    let response;
    try {
      response = await client.rest.repos.getContent({
        owner,
        repo,
        path: validation.repositoryPath,
      });
    } catch (err) {
      throw upstreamError(err);
    }

    const data = response.data;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw unexpected();
    }
    const file = data as Record<string, unknown>;
    // A directory or unsupported Contents API object type (e.g. symlink)
    // is unexpected for a file read. Never assume a base64 `content`
    // field exists: require it explicitly.
    if (file.type !== 'file' || !isBlobSha(file.sha) || !isNonNegativeNumber(file.size)) {
      throw unexpected();
    }
    if (file.encoding !== 'base64' || typeof file.content !== 'string') {
      throw unexpected();
    }
    // Content is returned exactly as stored — no Markdown rendering,
    // sanitization, or rewriting (web preview layer's responsibility).
    return {
      type: 'file',
      path: validation.relativePath,
      content: decodeContent(file.content),
      sha: file.sha,
      size: file.size,
    };
  };

  const createContent = async (
    owner: string,
    repo: string,
    path: string,
    content: string,
    message?: string,
  ): Promise<WriteResult> => {
    const refError = validateRepoRef(owner, repo);
    if (refError !== null) {
      throw refError;
    }
    const validation = validateContentPath(contentRoot, path, 'file');
    if (!validation.ok) {
      throw new ContentAdapterError(validation.error);
    }
    const contentValidation = validateMarkdownContent(content);
    if (!contentValidation.ok) {
      throw new ContentAdapterError(contentValidation.error);
    }

    // Existence pre-check: never silently overwrite an existing file.
    const existing = await fetchExistingEntry(
      client,
      owner,
      repo,
      validation.repositoryPath,
    );
    if (existing !== 'not_found') {
      throw new ContentAdapterError(errorDetail('FILE_EXISTS'));
    }

    const commitMessage = normalizeCommitMessage(
      message ?? `Create ${validation.relativePath}`,
    );

    let response;
    try {
      response = await client.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: validation.repositoryPath,
        message: commitMessage,
        content: encodeContent(content),
        // No `sha`: this is a create (existence was verified above).
        // No `author`/`committer`: GitHub attributes the commit to the
        // authenticated token (design decision A-05).
      });
    } catch (err) {
      // A 409 here means the path was created concurrently in the check
      // window: fail as a file-exists conflict. Never retry the write.
      if (isHttpError(err, 409)) {
        throw new ContentAdapterError(errorDetail('FILE_EXISTS'));
      }
      throw upstreamError(err);
    }

    const sha = readWriteResultSha(response);
    if (sha === null) {
      throw unexpected();
    }
    return { path: validation.relativePath, sha };
  };

  const updateContent = async (
    owner: string,
    repo: string,
    path: string,
    content: string,
    expectedSha: string,
    message?: string,
  ): Promise<WriteResult> => {
    const refError = validateRepoRef(owner, repo);
    if (refError !== null) {
      throw refError;
    }
    const validation = validateContentPath(contentRoot, path, 'file');
    if (!validation.ok) {
      throw new ContentAdapterError(validation.error);
    }
    const contentValidation = validateMarkdownContent(content);
    if (!contentValidation.ok) {
      throw new ContentAdapterError(contentValidation.error);
    }
    if (!isBlobSha(expectedSha)) {
      // A missing/malformed expected SHA is client input validation:
      // reject locally (422) before any GitHub request.
      throw new ContentAdapterError(
        errorDetail('PATH_INVALID', 'A valid expected blob SHA is required.'),
      );
    }

    const existing = await fetchExistingEntry(
      client,
      owner,
      repo,
      validation.repositoryPath,
    );
    if (existing === 'not_found' || existing.type !== 'file') {
      throw new ContentAdapterError(errorDetail('FILE_NOT_FOUND'));
    }
    if (existing.sha.toLowerCase() !== expectedSha.toLowerCase()) {
      // Deterministic conflict: report the file's current SHA so the
      // future HTTP layer can return it as `currentSha`. No write is sent.
      throw new ContentAdapterError(shaConflictDetail(existing.sha));
    }

    const commitMessage = normalizeCommitMessage(
      message ?? `Update ${validation.relativePath}`,
    );

    let response;
    try {
      response = await client.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: validation.repositoryPath,
        message: commitMessage,
        content: encodeContent(content),
        // SHA-protected update: GitHub rejects (409) if the file no
        // longer matches this SHA, so a newer version is never silently
        // overwritten. No `author`/`committer` (design decision A-05).
        sha: expectedSha.toLowerCase(),
      });
    } catch (err) {
      if (isHttpError(err, 409)) {
        // A concurrent update landed between the check and this write.
        // One read-only refetch (never a write retry) to report the
        // current SHA; if the refetch fails, the conflict is still
        // reported, just without `currentSha`.
        let currentSha: string | undefined;
        try {
          const refetched = await fetchExistingEntry(
            client,
            owner,
            repo,
            validation.repositoryPath,
          );
          if (refetched !== 'not_found' && refetched.type === 'file') {
            currentSha = refetched.sha;
          }
        } catch {
          currentSha = undefined;
        }
        throw currentSha === undefined
          ? new ContentAdapterError(errorDetail('SHA_CONFLICT'))
          : new ContentAdapterError(shaConflictDetail(currentSha));
      }
      throw upstreamError(err);
    }

    const sha = readWriteResultSha(response);
    if (sha === null) {
      throw unexpected();
    }
    return { path: validation.relativePath, sha };
  };

  return { contentRoot, listContent, readContent, createContent, updateContent };
}

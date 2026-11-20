/**
 * Task 5.3 — cleanup for a single live integration run.
 *
 * Corrected (source review):
 * - Ownership is established from the run-specific marker embedded in the
 *   artifact's CONTENT, not from the file name or the test's own memory.
 *   A remote write can succeed even when the client receives an error or a
 *   malformed response, so a "rejected" create call is NEVER assumed to mean
 *   the file does not exist.
 * - `performRunCleanup` is called exactly once for every attempted create
 *   (the live test passes `attemptedFileName` + `marker`). If the file
 *   exists, ownership is verified by exact path + marker before any delete;
 *   if ownership cannot be established the file is left untouched and the
 *   cleanup fails with sanitized manual-inspection guidance.
 * - A 404 on the run-directory listing (empty directories do not exist in a
 *   git tree) is confirmed: the attempted artifact path must also 404
 *   directly. A 404 on a recorded artifact therefore can never conceal an
 *   unverified deletion, and a non-404 listing failure still fails closed.
 * - Only direct file deletion via the GitHub Contents API is used, with the
 *   SHA taken from the SAME ownership-verified Contents API response (no
 *   separate unverified SHA fetch). No retries on conflict — a SHA conflict
 *   after verification means the file changed and the newer content is
 *   never deleted. No recursive deletion.
 * - Diagnostics carry fixed status-based text only; no raw upstream bodies,
 *   and no credential material.
 */
import {
  isContentRootSafe,
  isRunDirectory,
  validateRunCleanupPath,
} from './safety.js';

export interface CleanupClient {
  rest: {
    repos: {
      getContent(params: {
        owner: string;
        repo: string;
        path: string;
      }): Promise<{
        data:
          | Array<
              {
                type: string;
                name: string;
                path: string;
                sha: string;
                size: number;
              }
            >
          | {
              type: string;
              name: string;
              path: string;
              sha: string;
              size: number;
              content?: string;
              encoding?: string;
            };
      }>;
      deleteFile(params: {
        owner: string;
        repo: string;
        path: string;
        sha: string;
        message: string;
      }): Promise<unknown>;
    };
  };
}

export interface CleanupArgs {
  client: CleanupClient;
  owner: string;
  repo: string;
  contentRoot: string;
  runDirectory: string;
  /** File names confirmed created in this run (successful adapter returns). */
  ownedFileNames: readonly string[];
  /**
   * The exact file name the run attempted to create. Recorded BEFORE the
   * create attempt; cleanup must verify the artifact (read-only) even when
   * the create call failed or returned a malformed response.
   */
  attemptedFileName: string | null;
  /** The run-specific marker embedded in the artifact content. */
  marker: string;
}

export interface CleanupOutcome {
  ok: boolean;
  /** Repository paths actually deleted (each confirmed by a successful API delete). */
  deleted: string[];
  /** File names found in the run directory that were not owned by this run. */
  unexpected: string[];
  errors: string[];
  directoryGone: boolean;
  /** Attempted artifact paths confirmed absent via a direct read (404). */
  confirmedAbsent: string[];
}

/** Fixed commit message for artifact deletion. */
export function artifactDeleteMessage(fileName: string): string {
  return `Remove task 5.3 integration test artifact: ${fileName}`;
}

function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) ? status : null;
}

/**
 * Maps any upstream error to fixed, credential-free diagnostic text.
 * Raw upstream message bodies are never echoed (they may contain tokens or
 * request details).
 */
export function sanitizeUpstreamError(error: unknown): string {
  const status = statusOf(error);
  if (status === null) {
    return 'network or client error (no upstream status)';
  }
  if (status >= 500) {
    return 'GitHub server error (5xx)';
  }
  switch (status) {
    case 401:
      return 'authentication rejected (401)';
    case 403:
      return 'access forbidden (403) — the integration token does not cover this repository';
    case 404:
      return 'resource not found (404)';
    case 409:
      return 'upstream conflict (409) — current SHA changed; not retried';
    case 429:
      return 'rate limit exceeded (429)';
    default:
      return `upstream failure (${status})`;
  }
}

/**
 * Outcome of the single read-only ownership verification of one artifact.
 * On success, `sha` is the blob SHA taken from the SAME Contents API
 * response whose file type, exact path, content, and run-specific marker
 * were verified. Deletion must use exactly that SHA — there is no second,
 * unverified SHA fetch: if the file changes after this read, GitHub's
 * conditional (by-SHA) delete fails (409) instead of deleting newer
 * content, and cleanup never retries with a newer SHA.
 */
type ArtifactOwnership =
  | { ok: true; sha: string }
  | { ok: false; message: string };

/** A well-formed GitHub blob SHA: exactly 40 lowercase hex characters. */
const BLOB_SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Strict COMPACT base64 (after removing the line wrapping GitHub applies):
 * standard alphabet, padding only at the very end (0-2 characters).
 */
const BASE64_COMPACT_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Establishes that the file at `<runDirPath>/<fileName>` belongs to THIS
 * run and returns the verified deletion SHA from the same response.
 *
 * A single read-only Contents API call verifies, in order:
 *  - the response is a single file (not a directory listing);
 *  - the returned path is exactly the validated repository path;
 *  - the content field is present, is valid base64 (GitHub wraps the output
 *    at 64 columns with CR/LF breaks — only CR/LF are removed), decodes in
 *    canonical form (re-encoding the bytes reproduces the compact base64),
 *    and the decoded bytes are strict UTF-8 (the decoded text must
 *    round-trip to the exact same bytes);
 *  - the decoded content carries the exact run-specific marker;
 *  - the returned blob SHA is well formed (40 lowercase hex characters).
 *
 * A file that cannot be read, fails any validation, or lacks the marker is
 * NOT owned by this run and must never be deleted.
 */
async function verifyArtifactOwnership(
  client: CleanupClient,
  owner: string,
  repo: string,
  runDirPath: string,
  fileName: string,
  marker: string,
): Promise<ArtifactOwnership> {
  const filePath = `${runDirPath}/${fileName}`;
  let response: Awaited<ReturnType<CleanupClient['rest']['repos']['getContent']>>;
  try {
    response = await client.rest.repos.getContent({ owner, repo, path: filePath });
  } catch (error) {
    const status = statusOf(error);
    if (status === 404) {
      return {
        ok: false,
        message: `ownership check for ${fileName} failed: the file cannot be read (resource not found (404))`,
      };
    }
    return {
      ok: false,
      message: `ownership check for ${fileName} failed: the file cannot be read (${sanitizeUpstreamError(error)})`,
    };
  }
  const data = response.data;
  if (Array.isArray(data) || data.type !== 'file') {
    return {
      ok: false,
      message: `ownership could not be established for ${fileName}: the path does not resolve to a single file in this run; it was not deleted`,
    };
  }
  if (data.path !== filePath) {
    return {
      ok: false,
      message: `ownership could not be established for ${fileName}: the returned path does not match the exact validated artifact path; it was not deleted`,
    };
  }
  const rawBase64 = data.content;
  if (typeof rawBase64 !== 'string' || rawBase64.length === 0) {
    return {
      ok: false,
      message: `ownership could not be established for ${fileName}: the file content is missing or unreadable; it was not deleted`,
    };
  }
  // GitHub's Contents API wraps base64 output at 64 columns with CR/LF line
  // breaks. Only CR and LF are removed; every other character is invalid.
  const compactBase64 = rawBase64.replace(/[\r\n]/g, '');
  if (
    compactBase64.length === 0 ||
    compactBase64.length % 4 !== 0 ||
    !BASE64_COMPACT_PATTERN.test(compactBase64)
  ) {
    return {
      ok: false,
      message: `ownership could not be established for ${fileName}: the file content is not valid base64; it was not deleted`,
    };
  }
  const rawBytes = Buffer.from(compactBase64, 'base64');
  // Canonical form: re-encoding the decoded bytes must reproduce the compact
  // base64 exactly (rejects dropped bits and noncanonical padding).
  if (rawBytes.toString('base64') !== compactBase64) {
    return {
      ok: false,
      message: `ownership could not be established for ${fileName}: the file content is not valid base64; it was not deleted`,
    };
  }
  const content = rawBytes.toString('utf8');
  // Strict UTF-8: the decoded text must round-trip to the exact same bytes.
  if (!Buffer.from(content, 'utf8').equals(rawBytes)) {
    return {
      ok: false,
      message: `ownership could not be established for ${fileName}: the file content is not valid UTF-8; it was not deleted`,
    };
  }
  if (!content.includes(marker)) {
    return {
      ok: false,
      message: `ownership could not be established for ${fileName}: the content does not carry this run's marker (it may belong to another run or be pre-existing); it was not deleted`,
    };
  }
  if (!BLOB_SHA_PATTERN.test(data.sha)) {
    return {
      ok: false,
      message: `ownership could not be established for ${fileName}: the returned blob SHA is malformed; it was not deleted`,
    };
  }
  return { ok: true, sha: data.sha };
}

function manualInspectionGuidance(owner: string, repo: string, runDirPath: string): string {
  return `Manual inspection required: inspect https://github.com/${owner}/${repo}/tree/HEAD/${runDirPath} and delete any remaining test files by hand; automated deletion was refused`;
}

export async function performRunCleanup(args: CleanupArgs): Promise<CleanupOutcome> {
  const { client, owner, repo, contentRoot, runDirectory } = args;
  const deleted: string[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  const confirmedAbsent: string[] = [];
  let directoryGone = false;

  const finish = (ok: boolean, dirGone: boolean): CleanupOutcome => ({
    ok,
    deleted,
    unexpected,
    errors,
    directoryGone: dirGone,
    confirmedAbsent,
  });

  const runDirPath =
    contentRoot.length === 0 ? runDirectory : `${contentRoot}/${runDirectory}`;

  // Fail closed before any network access.
  if (!isContentRootSafe(contentRoot) || !isRunDirectory(runDirectory)) {
    errors.push('cleanup aborted: the run scope is invalid');
    return finish(false, false);
  }

  // The allowlist is EXACTLY: confirmed owned names + the attempted name.
  const allowedNames = new Set<string>(args.ownedFileNames);
  let attemptedPath: string | null = null;
  if (args.attemptedFileName !== null) {
    const fileName = args.attemptedFileName;
    if (!validateRunCleanupPath(contentRoot, runDirectory, [fileName], `${runDirPath}/${fileName}`).ok) {
      errors.push('cleanup aborted: the attempted artifact path is not valid for this run');
      return finish(false, false);
    }
    allowedNames.add(fileName);
    attemptedPath = `${runDirPath}/${fileName}`;
  }
  if (allowedNames.size === 0) {
    // Nothing was created and no create was attempted: there is no artifact
    // that could exist, so no verification is possible or needed.
    return finish(true, true);
  }
  if (args.marker.length === 0 || !/^[a-zA-Z0-9 ._-]+$/.test(args.marker)) {
    errors.push('cleanup aborted: the run marker is missing or malformed');
    return finish(false, false);
  }

  // Read-only listing of the run directory. Empty directories 404 on
  // GitHub; a non-404 failure fails closed.
  let listing: Array<{ type: string; name: string; path: string; sha: string; size: number }>;
  try {
    const response = await client.rest.repos.getContent({ owner, repo, path: runDirPath });
    if (Array.isArray(response.data)) {
      listing = response.data;
    } else {
      errors.push('run-directory listing returned an unexpected response');
      return finish(false, false);
    }
  } catch (error) {
    if (statusOf(error) === 404) {
      // Directory does not exist. If a create was attempted, confirm the
      // exact artifact path is also absent — a 404 here must never conceal
      // an unverified deletion.
      if (attemptedPath !== null) {
        let absent = false;
        try {
          await client.rest.repos.getContent({ owner, repo, path: attemptedPath });
        } catch (probeError) {
          absent = statusOf(probeError) === 404;
        }
        if (!absent) {
          errors.push(
            `cleanup failed: the run directory does not exist but the attempted artifact ${attemptedPath} could not be confirmed absent; it was not deleted`,
          );
          return finish(false, false);
        }
        confirmedAbsent.push(attemptedPath);
      }
      return finish(true, true);
    }
    errors.push(`listing the run directory failed (${sanitizeUpstreamError(error)})`);
    return finish(false, false);
  }

  for (const item of listing) {
    // Every listed entry must validate against the exact run scope and the
    // allowlist. Anything else is unexpected and is never touched.
    if (!validateRunCleanupPath(contentRoot, runDirectory, [...allowedNames], item.path).ok) {
      unexpected.push(item.name);
      continue;
    }
    // The listing entry must exactly match the validated layout.
    if (item.path !== `${runDirPath}/${item.name}`) {
      unexpected.push(item.name);
      continue;
    }
    // Ownership: exact path + strict content decoding + run-specific
    // content marker, read-only. The verified deletion SHA comes from this
    // same response — no second, unverified SHA fetch.
    const ownership = await verifyArtifactOwnership(
      client,
      owner,
      repo,
      runDirPath,
      item.name,
      args.marker,
    );
    if (!ownership.ok) {
      unexpected.push(item.name);
      errors.push(ownership.message);
      errors.push(manualInspectionGuidance(owner, repo, runDirPath));
      continue;
    }
    try {
      await client.rest.repos.deleteFile({
        owner,
        repo,
        path: item.path,
        // The SHA verified by the ownership-verification read above.
        sha: ownership.sha,
        message: artifactDeleteMessage(item.name),
      });
      deleted.push(item.path);
    } catch (error) {
      // A SHA conflict (409) means the file changed after verification:
      // report the sanitized failure — never retry with a newer SHA.
      errors.push(`deletion of ${item.path} failed (${sanitizeUpstreamError(error)})`);
    }
  }

  // Final read-only verification: the run directory must be 404, and any
  // remaining entries are reported as unexpected (never deleted here).
  try {
    const finalResponse = await client.rest.repos.getContent({ owner, repo, path: runDirPath });
    if (Array.isArray(finalResponse.data) && finalResponse.data.length > 0) {
      for (const item of finalResponse.data) {
        if (!unexpected.includes(item.name)) {
          unexpected.push(item.name);
        }
      }
      errors.push('final check: the run directory still exists');
      return finish(false, false);
    }
    directoryGone = true;
  } catch (error) {
    if (statusOf(error) === 404) {
      directoryGone = true;
    } else {
      errors.push(`final check failed (${sanitizeUpstreamError(error)})`);
      return finish(false, false);
    }
  }

  return finish(errors.length === 0 && unexpected.length === 0, directoryGone);
}

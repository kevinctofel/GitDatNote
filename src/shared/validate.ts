/**
 * Validation and normalization helpers for repository content operations
 * (design.md A-02, and the `repository-content` spec: Path validation,
 * UTF-8 encoding).
 *
 * Pure, platform-independent: no filesystem, DOM, or Node APIs. UTF-8 byte
 * length uses `TextEncoder`, which is a Web platform global available in
 * both browsers and Node (no `Buffer`).
 */

import { defaultDetail } from './errors.js';
import type { ErrorDetail, RepositoryPath, RelativePath } from './types.js';

/** Maximum supported Markdown file size: 1 MB in UTF-8 bytes. */
export const MAX_MARKDOWN_BYTES = 1024 * 1024;

const encoder = new TextEncoder();

/**
 * UTF-8 byte length of a string. Uses the encoded byte count, not
 * `string.length` (code unit count), so multi-byte characters count
 * correctly.
 */
export function utf8ByteLength(value: string): number {
  return encoder.encode(value).length;
}

/** Operation kind, used to decide whether an empty path is allowed. */
export type PathKind = 'file' | 'directory';

/** Result of path validation: a canonical path pair, or a `PATH_INVALID` error. */
export type PathValidationResult =
  | { ok: true; relativePath: RelativePath; repositoryPath: RepositoryPath }
  | { ok: false; error: ErrorDetail };

/**
 * Validate and canonicalize a content-root-relative path.
 *
 * Rules (design.md A-02 + spec):
 * - Forward-slash semantics; backslashes are rejected (on Windows a
 *   backslash is a legal filename character, so treating it as a
 *   separator would silently change the destination).
 * - Reject null bytes and other C0 control characters.
 * - Reject absolute paths.
 * - Lexically canonicalize: `.` segments and empty segments are dropped,
 *   `..` segments are collapsed against preceding segments.
 * - If `..` would leave the content root, reject with `PATH_INVALID`
 *   (never clamp or silently transform to a different destination).
 * - An empty relative path is allowed only for `kind: 'directory'`
 *   (listing the configured content root); file operations require a
 *   non-empty path.
 *
 * `contentRoot` comes from server-side configuration (trusted), but is
 * still checked for `..`/control characters defensively.
 */
export function validateContentPath(
  contentRoot: string,
  relativePath: string,
  kind: PathKind,
): PathValidationResult {
  const invalid = (): PathValidationResult => ({
    ok: false,
    error: defaultDetail('PATH_INVALID'),
  });

  if (hasControlCharacters(contentRoot) || canonicalSegments(contentRoot).escaped) {
    return invalid();
  }
  if (hasControlCharacters(relativePath)) return invalid();
  if (relativePath.includes('\\')) return invalid();
  if (relativePath.startsWith('/')) return invalid();
  const relativeSegments = canonicalSegments(relativePath);
  // A `..` that cannot be collapsed means the path escapes the root.
  if (relativeSegments.escaped) return invalid();
  // File operations require a non-empty canonicalized path; an empty path
  // (including inputs like "." or "a/..") is allowed only when listing the
  // configured content root.
  if (kind === 'file' && relativeSegments.segments.length === 0) return invalid();

  const rootSegments = canonicalSegments(contentRoot);
  const relativePathOut = relativeSegments.segments.join('/');
  let repositoryPath: RepositoryPath;
  if (rootSegments.segments.length === 0) {
    repositoryPath = relativePathOut;
  } else if (relativePathOut === '') {
    repositoryPath = rootSegments.segments.join('/');
  } else {
    repositoryPath = `${rootSegments.segments.join('/')}/${relativePathOut}`;
  }

  return { ok: true, relativePath: relativePathOut, repositoryPath };
}

/**
 * Validate Markdown content size using its UTF-8 byte length.
 * Unicode content is preserved as-is; only the size is checked.
 */
export type ContentValidationResult =
  | { ok: true; byteLength: number }
  | { ok: false; error: ErrorDetail };

export function validateMarkdownContent(content: string): ContentValidationResult {
  const byteLength = utf8ByteLength(content);
  if (byteLength > MAX_MARKDOWN_BYTES) {
    return { ok: false, error: defaultDetail('CONTENT_TOO_LARGE') };
  }
  return { ok: true, byteLength };
}

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

function canonicalSegments(value: string): { segments: string[]; escaped: boolean } {
  const segments: string[] = [];
  let escaped = false;
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) {
        escaped = true;
        break;
      }
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return { segments, escaped };
}

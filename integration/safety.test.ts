/**
 * Task 5.3 — deterministic OFFLINE regression tests for the blocking source
 * review corrections. No credentials, no network access, no GitHub contact:
 * the GitHub client is always a fake, and the configuration resolution
 * functions are pure (they cannot open connections).
 *
 * Coverage (per the review):
 *  1. Valid configuration resolution returns the correct owner/repo and
 *     never exposes the token.
 *  2. Invalid configuration fails before any network access (opt-in gate
 *     first, fail-closed, no inference).
 *  3. Production and reserved repositories remain blocked.
 *  4. An accepted remote write followed by a lost response triggers
 *     read-only ownership verification and safe cleanup.
 *  5. A malformed create response after a simulated successful write
 *     triggers the same protection.
 *  6. An existing file with a different run marker is never deleted.
 *  7. An unidentifiable or unreadable file is never deleted.
 *  8. Cleanup verification failures produce a failing result.
 *  9. No credential appears in diagnostics.
 * 10. The pure preflight identity/policy check (checkPreflightPolicy):
 *     the dedicated test repository under kevinctofel passes; the exact
 *     application source pair, reserved, placeholder, and malformed
 *     targets remain rejected.
 * 11. Deletion uses the SHA from the exact response that passed marker
 *     verification; a simulated post-verification replacement makes the
 *     SHA-protected deletion fail (no retry, replacement intact); invalid
 *     base64, invalid UTF-8, or a malformed SHA prevents deletion.
 * 12. GitHub's 64-column CR/LF base64 line wrapping is accepted (the
 *     observed live-run cleanup failure): LF- and CRLF-wrapped 219-byte
 *     Markdown payloads with the correct marker verify and delete;
 *     malformed base64 characters, noncanonical padding, invalid UTF-8,
 *     and wrong markers still fail closed without deletion.
 *
 * Plus regression coverage of the run-directory, artifact-path,
 * cleanup-path, identity, and error-sanitization helpers.
 */

import { describe, expect, test } from 'vitest';

import {
  OPT_IN_VAR,
  REPO_VAR,
  TOKEN_VAR,
  type IntegrationEnv,
} from './config.js';
import {
  artifactDeleteMessage,
  performRunCleanup,
  sanitizeUpstreamError,
  type CleanupClient,
} from './cleanup.js';
import {
  buildRunArtifactPath,
  checkPreflightPolicy,
  defaultRunSuffix,
  generateRunDirectory,
  isRunDirectory,
  repositoryIdentityMatches,
  resolveLiveIntegrationConfig,
  validateRunCleanupPath,
  RUN_FILE_NAME,
} from './safety.js';

/** A fixed, well-formed run directory (deterministic clock + suffix). */
const RUN_DIRECTORY = generateRunDirectory(new Date('2026-01-02T03:04:05.678Z'), () => 'abc123');

/** Run-specific ownership marker (marker contract: [A-Za-z0-9 ._-]+ only). */
const MARKER = `gitdatnote-run-${RUN_DIRECTORY}`;

/** Content this run would write: carries the marker verbatim. */
const RUN_CONTENT = `Marker: ${MARKER}\nUTF-8 sample: ünïcødé ✓\n`;

const SHA_40 = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

/** A distinct well-formed 40-hex blob SHA (simulated replacement file). */
const SHA_40_REPLACEMENT = '0123456789abcdef0123456789abcdef01234567';

/** The fixed raw 409 message used by the fake's conditional-delete model. */
const RAW_409_MESSAGE = 'sha does not match current blob sha';

interface FakeFile {
  path: string;
  content: string;
  sha: string;
  /**
   * Optional raw `content` override as served by the fake Contents API
   * (used to simulate invalid base64 / invalid UTF-8 payloads; when
   * absent, `content` is encoded as GitHub would deliver it).
   */
  rawContent?: string;
  deleted?: boolean;
}

interface FakeClientOptions {
  failDeleteWith?: { status: number; message?: string };
  /**
   * Invoked immediately before a deletion is processed (and before the
   * conditional SHA check), to simulate a concurrent modification between
   * ownership verification and the delete call.
   */
  beforeDelete?: (params: { path: string; sha: string }) => void;
}

interface FakeGitHubClient {
  client: CleanupClient;
  calls: { getContent: number; deleteFile: number; deleteShas: string[] };
}

/** Content as GitHub's Contents API delivers it: base64, with file metadata. */
function fileEntry(file: FakeFile) {
  return {
    type: 'file',
    name: file.path.slice(file.path.lastIndexOf('/') + 1),
    path: file.path,
    sha: file.sha,
    size: Buffer.byteLength(file.content),
    content: file.rawContent ?? Buffer.from(file.content, 'utf8').toString('base64'),
  };
}

/**
 * Fake GitHub Contents client. `goneDirectories` are directory paths that
 * 404 (and so do all their descendants — empty directories do not exist in
 * a git tree). Every tracked, not-yet-deleted file keeps its own path alive;
 * the parent directory of a tracked file is implicitly alive (listing the
 * parent returns that file).
 */
function makeFakeClient(
  files: Record<string, FakeFile> = {},
  goneDirectories: string[] = [],
  options: FakeClientOptions = {},
): FakeGitHubClient {
  const calls = { getContent: 0, deleteFile: 0, deleteShas: [] as string[] };
  const notFoundDirs = new Set<string>(goneDirectories);
  for (const file of Object.values(files)) {
    if (file.deleted) continue;
    const idx = file.path.lastIndexOf('/');
    if (idx > 0) notFoundDirs.delete(file.path.slice(0, idx));
  }
  const isPathGone = (path: string): boolean => {
    let p = path;
    for (;;) {
      if (notFoundDirs.has(p)) return true;
      const idx = p.lastIndexOf('/');
      if (idx <= 0) break;
      p = p.slice(0, idx);
    }
    return false;
  };
  const client: CleanupClient = {
    rest: {
      repos: {
        async getContent(params) {
          calls.getContent += 1;
          const file = files[params.path];
          if (file && !file.deleted) return { data: fileEntry(file) };
          if (isPathGone(params.path)) throw { status: 404, message: 'Not Found' };
          // Otherwise: a (possibly empty) directory listing.
          const prefix = `${params.path}/`;
          const entries = Object.values(files)
            .filter(
              (f) =>
                !f.deleted &&
                f.path.startsWith(prefix) &&
                !f.path.slice(prefix.length).includes('/'),
            )
            .map(fileEntry);
          return { data: entries };
        },
        async deleteFile(params) {
          calls.deleteFile += 1;
          calls.deleteShas.push(params.sha);
          if (options.failDeleteWith) {
            throw {
              status: options.failDeleteWith.status,
              message: options.failDeleteWith.message ?? 'error',
            };
          }
          // Simulate a concurrent modification between ownership
          // verification and the delete call.
          options.beforeDelete?.({ path: params.path, sha: params.sha });
          const file = files[params.path];
          if (!file || file.deleted) throw { status: 404, message: 'Not Found' };
          // Model GitHub's conditional delete: the supplied SHA must match
          // the CURRENT blob SHA, or the request is rejected (409) and
          // nothing is deleted — a newer file is never removed by an older
          // SHA (this is not a mock that deletes regardless of the SHA).
          if (file.sha !== params.sha) {
            throw { status: 409, message: RAW_409_MESSAGE };
          }
          file.deleted = true;
          return { content: { sha: params.sha } };
        },
      },
    },
  };
  return { client, calls };
}

// ---------------------------------------------------------------------------
// Live configuration resolution (review fix 1)
// ---------------------------------------------------------------------------

describe('resolveLiveIntegrationConfig (offline, fail-closed)', () => {
  const repoValue = 'test-owner/gitdatnote-integration-test';
  const tokenValue = 'ghs_secret_value_123';

  test('valid configuration resolves owner/repo and never exposes the token', () => {
    const env: IntegrationEnv = {
      [OPT_IN_VAR]: 'true',
      [REPO_VAR]: repoValue,
      [TOKEN_VAR]: tokenValue,
    };
    const result = resolveLiveIntegrationConfig(env);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected configuration to resolve');
    expect(result.owner).toBe('test-owner');
    expect(result.repo).toBe('gitdatnote-integration-test');
    // The resolved value carries no credential of any kind.
    expect('token' in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain(tokenValue);
  });

  test('unset or ambiguous opt-in fails before anything else (no network possible)', () => {
    for (const value of [undefined, '1', 'TRUE', 'yes']) {
      const env: IntegrationEnv = {
        [REPO_VAR]: repoValue,
        [TOKEN_VAR]: tokenValue,
      };
      if (value !== undefined) env[OPT_IN_VAR] = value;
      const result = resolveLiveIntegrationConfig(env);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected configuration to fail');
      expect(result.errors).toEqual(['the integration opt-in flag is not enabled']);
    }
  });

  test('missing repository value fails closed with a fixed, credential-free message', () => {
    const env: IntegrationEnv = {
      [OPT_IN_VAR]: 'true',
      [TOKEN_VAR]: tokenValue,
    };
    const result = resolveLiveIntegrationConfig(env);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected configuration to fail');
    expect(result.errors.some((e) => e.startsWith('GITHUB_INTEGRATION_REPO is missing'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(tokenValue);
  });

  test('malformed repository value fails closed', () => {
    const env: IntegrationEnv = {
      [OPT_IN_VAR]: 'true',
      [REPO_VAR]: 'not-a-repo',
      [TOKEN_VAR]: tokenValue,
    };
    const result = resolveLiveIntegrationConfig(env);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected configuration to fail');
    expect(result.errors.some((e) => e.startsWith('GITHUB_INTEGRATION_REPO must be exactly'))).toBe(
      true,
    );
  });

  test('the GitDatNote application source repository remains blocked', () => {
    const env: IntegrationEnv = {
      [OPT_IN_VAR]: 'true',
      [REPO_VAR]: 'kevinctofel/gitdatnote',
      [TOKEN_VAR]: tokenValue,
    };
    const result = resolveLiveIntegrationConfig(env);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected configuration to fail');
    expect(
      result.errors.some((e) => e.includes('GitDatNote application source repository')),
    ).toBe(true);
  });

  test('the reserved SecondBrain vault remains blocked (case-insensitive)', () => {
    const env: IntegrationEnv = {
      [OPT_IN_VAR]: 'true',
      [REPO_VAR]: 'someone/secondbrain',
      [TOKEN_VAR]: tokenValue,
    };
    const result = resolveLiveIntegrationConfig(env);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected configuration to fail');
    expect(result.errors.some((e) => e.includes('reserved (live production vault)'))).toBe(true);
  });

  test('a repository not following the exact dedicated naming pattern is rejected', () => {
    // A broad "gitdatnote-integration" prefix alone is NOT enough: the exact
    // DEDICATED_REPO_PATTERN from config.js must hold.
    const env: IntegrationEnv = {
      [OPT_IN_VAR]: 'true',
      [REPO_VAR]: 'someone/gitdatnote-integration',
      [TOKEN_VAR]: tokenValue,
    };
    const result = resolveLiveIntegrationConfig(env);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected configuration to fail');
    expect(
      result.errors.some((e) => e.includes('must name a dedicated integration-test repository')),
    ).toBe(true);
  });

  test('missing or malformed token fails closed without echoing the value', () => {
    const envMissing: IntegrationEnv = {
      [OPT_IN_VAR]: 'true',
      [REPO_VAR]: repoValue,
    };
    const missing = resolveLiveIntegrationConfig(envMissing);
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('expected configuration to fail');
    expect(
      missing.errors.some((e) => e.startsWith('GITHUB_INTEGRATION_TOKEN is missing')),
    ).toBe(true);

    const envWhitespace: IntegrationEnv = {
      [OPT_IN_VAR]: 'true',
      [REPO_VAR]: repoValue,
      [TOKEN_VAR]: `${tokenValue} `,
    };
    const whitespace = resolveLiveIntegrationConfig(envWhitespace);
    expect(whitespace.ok).toBe(false);
    if (whitespace.ok) throw new Error('expected configuration to fail');
    expect(
      whitespace.errors.some((e) => e.startsWith('GITHUB_INTEGRATION_TOKEN appears malformed')),
    ).toBe(true);
    expect(JSON.stringify(whitespace)).not.toContain(tokenValue);
  });
});

// ---------------------------------------------------------------------------
// Run directory and artifact path helpers
// ---------------------------------------------------------------------------

describe('generateRunDirectory / isRunDirectory', () => {
  test('generates a well-formed, filename-safe directory for a fixed clock', () => {
    const dir = generateRunDirectory(new Date('2026-01-02T03:04:05.678Z'), () => 'abc123');
    expect(dir).toBe('__gitdatnote-integration-2026-01-02T03-04-05-678Z-abc123');
    expect(isRunDirectory(dir)).toBe(true);
  });

  test('rejects malformed run directory names', () => {
    expect(isRunDirectory('not-a-run-directory')).toBe(false);
    // Structurally plausible but an impossible date: fails the round-trip.
    expect(isRunDirectory('__gitdatnote-integration-2026-13-40T99-99-99-999Z-abc123')).toBe(false);
    // A repository name is not a run directory.
    expect(isRunDirectory('gitdatnote-integration-test')).toBe(false);
    // Wrong prefix (single underscore).
    expect(isRunDirectory('gitdatnote-integration-2026-01-02T03-04-05-678Z-abc123')).toBe(false);
  });

  test('defaultRunSuffix is 6 lowercase hex chars and varies', () => {
    const a = defaultRunSuffix();
    const b = defaultRunSuffix();
    expect(a).toMatch(/^[0-9a-f]{6}$/);
    expect(b).toMatch(/^[0-9a-f]{6}$/);
    expect(a).not.toBe(b);
  });
});

describe('buildRunArtifactPath', () => {
  test('builds the exact relative and repository paths inside the content root', () => {
    const result = buildRunArtifactPath('src/posts', RUN_DIRECTORY, RUN_FILE_NAME);
    expect(result).toEqual({
      ok: true,
      relativePath: `${RUN_DIRECTORY}/${RUN_FILE_NAME}`,
      repositoryPath: `src/posts/${RUN_DIRECTORY}/${RUN_FILE_NAME}`,
    });
  });

  test('an empty content root means the repository root', () => {
    const result = buildRunArtifactPath('', RUN_DIRECTORY, RUN_FILE_NAME);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a valid path');
    expect(result.repositoryPath).toBe(result.relativePath);
  });

  test('rejects unsafe content roots', () => {
    for (const bad of ['../etc/passwd', '/abs', 'a\\b', 'a//b', 'a/./b']) {
      const result = buildRunArtifactPath(bad, RUN_DIRECTORY, RUN_FILE_NAME);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('content root is not a safe repository-relative path');
      }
    }
  });

  test('rejects an invalid run directory and unsafe file names', () => {
    const badDir = buildRunArtifactPath('src/posts', 'nope', RUN_FILE_NAME);
    expect(badDir.ok).toBe(false);
    if (!badDir.ok) {
      expect(badDir.reason).toBe('run directory is not a well-formed integration run directory');
    }
    for (const bad of ['nested/file.md', '.hidden', 'a\\b']) {
      const result = buildRunArtifactPath('src/posts', RUN_DIRECTORY, bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('file name is not a safe single path segment');
      }
    }
  });
});

describe('validateRunCleanupPath', () => {
  test('accepts exactly the owned artifact path', () => {
    const result = validateRunCleanupPath(
      'src/posts',
      RUN_DIRECTORY,
      [RUN_FILE_NAME],
      `src/posts/${RUN_DIRECTORY}/${RUN_FILE_NAME}`,
    );
    expect(result).toEqual({ ok: true });
  });

  test('rejects everything else', () => {
    const owned = [RUN_FILE_NAME];
    const cases: Array<[string, RegExp]> = [
      // A different run directory is outside this run's isolation.
      [
        `src/posts/${RUN_DIRECTORY.replace('abc123', 'def456')}/${RUN_FILE_NAME}`,
        /outside this run's isolated directory/,
      ],
      // Traversal inside the run directory is not an immediate file.
      [
        `src/posts/${RUN_DIRECTORY}/../sibling.md`,
        /not an immediate file inside the run directory/,
      ],
      // A sibling of the run directory.
      ['src/posts/README.md', /outside this run's isolated directory/],
      // Absolute paths.
      ['/etc/passwd', /cleanup path is absolute/],
      // An immediate file that this run did not create.
      [`src/posts/${RUN_DIRECTORY}/other.md`, /not a file created by this run/],
      // Empty path.
      ['', /cleanup path is empty/],
    ];
    for (const [path, reason] of cases) {
      const result = validateRunCleanupPath('src/posts', RUN_DIRECTORY, owned, path);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(reason);
    }
  });

  test('rejects an unsafe owned file name', () => {
    const result = validateRunCleanupPath(
      'src/posts',
      RUN_DIRECTORY,
      ['a/b'],
      `src/posts/${RUN_DIRECTORY}/a`,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('owned file list contains an unsafe file name');
    }
  });
});

// ---------------------------------------------------------------------------
// Repository identity (review fix 2: preflight must verify identity)
// ---------------------------------------------------------------------------

describe('repositoryIdentityMatches', () => {
  test('matches the configured target case-insensitively', () => {
    expect(
      repositoryIdentityMatches(
        'kevinctofel/gitdatnote-integration-test',
        'Kevinctofel/GitDatNote-Integration-Test',
      ),
    ).toBe(true);
  });

  test('rejects a different repository or an empty reported identity', () => {
    expect(
      repositoryIdentityMatches(
        'kevinctofel/gitdatnote-integration-test',
        'kevinctofel/gitdatnote-integration-test-other',
      ),
    ).toBe(false);
    expect(repositoryIdentityMatches('kevinctofel/gitdatnote-integration-test', '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pure preflight identity/policy check (final review fix 1: the production
// exclusion is the EXACT owner/repository pair, not the owner alone)
// ---------------------------------------------------------------------------

describe('checkPreflightPolicy (pure, offline)', () => {
  test('the dedicated test repository under kevinctofel passes — the owner alone does not block it', () => {
    // Regression: the previous preflight rejected any repository whose
    // owner matched kevinctofel, incorrectly blocking the intended target.
    const result = checkPreflightPolicy({
      configuredOwner: 'kevinctofel',
      configuredRepo: 'gitdatnote-integration-test',
      reportedOwnerLogin: 'Kevinctofel',
      reportedRepoName: 'GitDatNote-Integration-Test',
    });
    expect(result).toEqual({ ok: true });
  });

  test('a dedicated test repository with one extra suffix passes (exact pattern, case-insensitive)', () => {
    const result = checkPreflightPolicy({
      configuredOwner: 'someone',
      configuredRepo: 'gitdatnote-integration-test-ci',
      reportedOwnerLogin: 'someone',
      reportedRepoName: 'GitDatNote-Integration-Test-ci',
    });
    expect(result).toEqual({ ok: true });
  });

  test('the exact application source pair is rejected, case-insensitively', () => {
    const result = checkPreflightPolicy({
      configuredOwner: 'kevinctofel',
      configuredRepo: 'gitdatnote',
      reportedOwnerLogin: 'kevinctofel',
      reportedRepoName: 'GitDatNote',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the application source repository to be rejected');
    expect(result.failure).toBe('production-source-repository');
  });

  test('a different owner with a repository called GitDatNote is NOT classified as the application source repository', () => {
    // It is still rejected — the bare "gitdatnote" name is also an obvious
    // placeholder value, rejected by the (earlier) placeholder policy — but
    // it is never classified as the application source repository, which is
    // the specific regression the exact-pair exclusion must avoid.
    const result = checkPreflightPolicy({
      configuredOwner: 'someone-else',
      configuredRepo: 'gitdatnote',
      reportedOwnerLogin: 'someone-else',
      reportedRepoName: 'GitDatNote',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the repository to be rejected');
    expect(result.failure).not.toBe('production-source-repository');
  });

  test('the reserved SecondBrain target remains rejected', () => {
    for (const reported of ['secondbrain', 'SecondBrain', 'SECONDbrain']) {
      const result = checkPreflightPolicy({
        configuredOwner: 'someone',
        configuredRepo: reported,
        reportedOwnerLogin: 'someone',
        reportedRepoName: reported,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`expected ${reported} to be rejected`);
      expect(result.failure).toBe('reserved-target');
    }
  });

  test('placeholder owner or repository values remain rejected', () => {
    for (const [owner, repo] of [
      ['your-owner', 'gitdatnote-integration-test'],
      ['someone', 'repo'],
    ] as const) {
      const result = checkPreflightPolicy({
        configuredOwner: owner,
        configuredRepo: repo,
        reportedOwnerLogin: owner,
        reportedRepoName: repo,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`expected ${owner}/${repo} to be rejected`);
      expect(result.failure).toBe('placeholder-value');
    }
  });

  test('a broad gitdatnote-integration prefix without the -test suffix is rejected (exact pattern)', () => {
    const result = checkPreflightPolicy({
      configuredOwner: 'someone',
      configuredRepo: 'gitdatnote-integration',
      reportedOwnerLogin: 'someone',
      reportedRepoName: 'gitdatnote-integration',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the repository to be rejected');
    expect(result.failure).toBe('naming-convention');
  });

  test('a reported identity that does not match the configured target is rejected', () => {
    const result = checkPreflightPolicy({
      configuredOwner: 'someone',
      configuredRepo: 'gitdatnote-integration-test',
      reportedOwnerLogin: 'someone',
      reportedRepoName: 'some-other-repository',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the identity mismatch to be rejected');
    expect(result.failure).toBe('identity-mismatch');
  });
});

// ---------------------------------------------------------------------------
// Error sanitization (review fixes 1 and 9: credentials never in diagnostics)
// ---------------------------------------------------------------------------

describe('sanitizeUpstreamError', () => {
  test('maps statuses to fixed, credential-free strings', () => {
    expect(sanitizeUpstreamError({ status: 401, message: 'bad credentials' })).toBe(
      'authentication rejected (401)',
    );
    expect(sanitizeUpstreamError({ status: 403, message: 'forbidden' })).toBe(
      'access forbidden (403) — the integration token does not cover this repository',
    );
    expect(sanitizeUpstreamError({ status: 404, message: 'Not Found' })).toBe(
      'resource not found (404)',
    );
    expect(sanitizeUpstreamError({ status: 409, message: 'conflict' })).toBe(
      'upstream conflict (409) — current SHA changed; not retried',
    );
    expect(sanitizeUpstreamError({ status: 429, message: 'rate limit' })).toBe(
      'rate limit exceeded (429)',
    );
    expect(sanitizeUpstreamError({ status: 500, message: 'boom' })).toBe(
      'GitHub server error (5xx)',
    );
    // Other non-special statuses map to the generic fixed form.
    expect(sanitizeUpstreamError({ status: 418, message: 'teapot' })).toBe('upstream failure (418)');
    // Only a direct numeric status is read — no raw body, no inference.
    expect(sanitizeUpstreamError({ response: { status: 404 }, message: 'not found' })).toBe(
      'network or client error (no upstream status)',
    );
  });

  test('never includes the raw upstream message or non-error values', () => {
    const secretish = 'token=ghs_abcdef';
    expect(sanitizeUpstreamError({ status: 401, message: secretish })).not.toContain(secretish);
    expect(sanitizeUpstreamError(new Error(`network ${secretish}`))).not.toContain(secretish);
    expect(sanitizeUpstreamError(null)).toBe('network or client error (no upstream status)');
    expect(sanitizeUpstreamError('boom')).toBe('network or client error (no upstream status)');
  });
});

test('artifactDeleteMessage names only the file, never repository or credential details', () => {
  expect(artifactDeleteMessage('integration-article.md')).toBe(
    'Remove task 5.3 integration test artifact: integration-article.md',
  );
});

// ---------------------------------------------------------------------------
// performRunCleanup with a fake GitHub client (review fix 3: ownership
// tracking and partial-write cleanup)
// ---------------------------------------------------------------------------

describe('performRunCleanup with a fake GitHub client (no network)', () => {
  test('no owned files and no attempted file: succeeds without any network call', async () => {
    const { client, calls } = makeFakeClient();
    const result = await performRunCleanup({
      client,
      owner: 'owner-a',
      repo: 'test-repo',
      contentRoot: '',
      runDirectory: RUN_DIRECTORY,
      ownedFileNames: [],
      attemptedFileName: null,
      marker: MARKER,
    });
    expect(result.ok).toBe(true);
    expect(result.directoryGone).toBe(true);
    expect(result.deleted).toEqual([]);
    expect(result.unexpected).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(calls.getContent).toBe(0);
    expect(calls.deleteFile).toBe(0);
  });

  test('invalid run scope aborts before any network call', async () => {
    const { client, calls } = makeFakeClient();
    const result = await performRunCleanup({
      client,
      owner: 'owner-a',
      repo: 'test-repo',
      contentRoot: '',
      runDirectory: 'not-a-run-directory',
      ownedFileNames: [RUN_FILE_NAME],
      attemptedFileName: RUN_FILE_NAME,
      marker: MARKER,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['cleanup aborted: the run scope is invalid']);
    expect(calls.getContent).toBe(0);
    expect(calls.deleteFile).toBe(0);
  });

  test('accepted remote write followed by a lost response: direct 404 probe confirms absence, no deletion', async () => {
    const { client, calls } = makeFakeClient({}, [RUN_DIRECTORY]);
    const result = await performRunCleanup({
      client,
      owner: 'owner-a',
      repo: 'test-repo',
      contentRoot: '',
      runDirectory: RUN_DIRECTORY,
      ownedFileNames: [],
      attemptedFileName: RUN_FILE_NAME,
      marker: MARKER,
    });
    expect(result.ok).toBe(true);
    expect(result.deleted).toEqual([]);
    expect(result.errors).toEqual([]);
    // The recorded artifact was confirmed absent by a direct read-only probe.
    expect(result.confirmedAbsent).toEqual([`${RUN_DIRECTORY}/${RUN_FILE_NAME}`]);
    expect(calls.getContent).toBe(2); // directory listing + direct 404 confirmation
    expect(calls.deleteFile).toBe(0);
  });

  test('malformed create response after a write that landed: ownership verified, then deleted', async () => {
    const path = `${RUN_DIRECTORY}/${RUN_FILE_NAME}`;
    const { client, calls } = makeFakeClient({
      [path]: { path, content: RUN_CONTENT, sha: SHA_40 },
    });
    const result = await performRunCleanup({
      client,
      owner: 'owner-a',
      repo: 'test-repo',
      contentRoot: '',
      runDirectory: RUN_DIRECTORY,
      ownedFileNames: [], // the client never learned the write succeeded
      attemptedFileName: RUN_FILE_NAME,
      marker: MARKER,
    });
    expect(result.ok).toBe(true);
    expect(result.deleted).toEqual([path]);
    expect(result.unexpected).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(calls.deleteFile).toBe(1);
  });

  test('an existing file with a different run marker is never deleted', async () => {
    const path = `${RUN_DIRECTORY}/${RUN_FILE_NAME}`;
    const { client, calls } = makeFakeClient({
      [path]: { path, content: 'Marker: gitdatnote-run-999', sha: SHA_40 },
    });
    const result = await performRunCleanup({
      client,
      owner: 'owner-a',
      repo: 'test-repo',
      contentRoot: '',
      runDirectory: RUN_DIRECTORY,
      ownedFileNames: [RUN_FILE_NAME],
      attemptedFileName: RUN_FILE_NAME,
      marker: MARKER,
    });
    expect(result.ok).toBe(false);
    expect(result.deleted).toEqual([]);
    expect(result.unexpected).toContain(RUN_FILE_NAME);
    expect(result.errors.some((e) => e.includes("does not carry this run's marker"))).toBe(true);
    // Sanitized manual-inspection guidance is provided.
    expect(
      result.errors.some((e) =>
        e.startsWith(
          `Manual inspection required: inspect https://github.com/owner-a/test-repo/tree/HEAD/${RUN_DIRECTORY}`,
        ),
      ),
    ).toBe(true);
    expect(calls.deleteFile).toBe(0);
  });

  test('an unidentifiable or unreadable file is never deleted', async () => {
    const path = `${RUN_DIRECTORY}/${RUN_FILE_NAME}`;
    const { client, calls } = makeFakeClient({
      [path]: { path, content: 'unidentifiable content', sha: SHA_40 },
    });
    const result = await performRunCleanup({
      client,
      owner: 'owner-a',
      repo: 'test-repo',
      contentRoot: '',
      runDirectory: RUN_DIRECTORY,
      ownedFileNames: [RUN_FILE_NAME],
      attemptedFileName: RUN_FILE_NAME,
      marker: MARKER,
    });
    expect(result.ok).toBe(false);
    expect(result.deleted).toEqual([]);
    expect(result.unexpected).toContain(RUN_FILE_NAME);
    expect(
      result.errors.some((e) => e.startsWith('ownership could not be established')),
    ).toBe(true);
    expect(calls.deleteFile).toBe(0);
  });

  test('a failed deletion produces a failing result (no silent success)', async () => {
    const path = `${RUN_DIRECTORY}/${RUN_FILE_NAME}`;
    const { client, calls } = makeFakeClient(
      { [path]: { path, content: RUN_CONTENT, sha: SHA_40 } },
      [],
      { failDeleteWith: { status: 500, message: 'internal error' } },
    );
    const result = await performRunCleanup({
      client,
      owner: 'owner-a',
      repo: 'test-repo',
      contentRoot: '',
      runDirectory: RUN_DIRECTORY,
      ownedFileNames: [RUN_FILE_NAME],
      attemptedFileName: RUN_FILE_NAME,
      marker: MARKER,
    });
    expect(result.ok).toBe(false);
    expect(result.deleted).toEqual([]);
    expect(result.unexpected).toContain(RUN_FILE_NAME);
    expect(result.errors.some((e) => e.includes('deletion of') && e.includes('5xx'))).toBe(true);
    // The final read-only check confirms the directory still exists.
    expect(
      result.errors.some((e) => e.includes('final check: the run directory still exists')),
    ).toBe(true);
    expect(calls.deleteFile).toBe(1);
  });

  test('a surviving unexpected file makes the final check fail', async () => {
    const path = `${RUN_DIRECTORY}/${RUN_FILE_NAME}`;
    const strayPath = `${RUN_DIRECTORY}/stray.txt`;
    const { client, calls } = makeFakeClient({
      [path]: { path, content: RUN_CONTENT, sha: SHA_40 },
      [strayPath]: { path: strayPath, content: 'stray', sha: SHA_40 },
    });
    const result = await performRunCleanup({
      client,
      owner: 'owner-a',
      repo: 'test-repo',
      contentRoot: '',
      runDirectory: RUN_DIRECTORY,
      ownedFileNames: [RUN_FILE_NAME],
      attemptedFileName: null,
      marker: MARKER,
    });
    expect(result.ok).toBe(false);
    // The owned artifact was deleted; the stray file was reported, not deleted.
    expect(result.deleted).toEqual([path]);
    expect(result.unexpected).toContain('stray.txt');
    expect(
      result.errors.some((e) => e.includes('final check: the run directory still exists')),
    ).toBe(true);
    expect(calls.deleteFile).toBe(1);
  });

  test('no credential appears in cleanup diagnostics', async () => {
    const fakeToken = 'ghs_leak_test_token';
    const path = `${RUN_DIRECTORY}/${RUN_FILE_NAME}`;
    const { client } = makeFakeClient(
      { [path]: { path, content: `${RUN_CONTENT}token=${fakeToken}\n`, sha: SHA_40 } },
      [],
      { failDeleteWith: { status: 500, message: `boom ${fakeToken}` } },
    );
    const result = await performRunCleanup({
      client,
      owner: 'owner-a',
      repo: 'test-repo',
      contentRoot: '',
      runDirectory: RUN_DIRECTORY,
      ownedFileNames: [RUN_FILE_NAME],
      attemptedFileName: RUN_FILE_NAME,
      marker: MARKER,
    });
    expect(result.ok).toBe(false);
    const diagnostics = result.errors.join(' ');
    expect(diagnostics).not.toContain(fakeToken);
  });

  test('a malformed run marker fails closed before any network call', async () => {
    const { client, calls } = makeFakeClient({}, [RUN_DIRECTORY]);
    const result = await performRunCleanup({
      client,
      owner: 'owner-a',
      repo: 'test-repo',
      contentRoot: '',
      runDirectory: RUN_DIRECTORY,
      ownedFileNames: [],
      attemptedFileName: RUN_FILE_NAME,
      // Contains characters outside the ownership-marker contract.
      marker: 'bad marker!!',
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['cleanup aborted: the run marker is missing or malformed']);
    expect(calls.getContent).toBe(0);
    expect(calls.deleteFile).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Deletion SHA binding (final review fix 2: the deletion SHA must come from
// the SAME ownership-verified Contents API response — no second, unverified
// SHA fetch)
// ---------------------------------------------------------------------------

describe('Deletion SHA binding (offline, fake client only)', () => {
  test('deletion uses the SHA from the exact response that passed marker verification (no second SHA fetch)', async () => {
    const path = `${RUN_DIRECTORY}/${RUN_FILE_NAME}`;
    const { client, calls } = makeFakeClient({
      [path]: { path, content: RUN_CONTENT, sha: SHA_40 },
    });
    const result = await performRunCleanup({
      client,
      owner: 'owner-a',
      repo: 'test-repo',
      contentRoot: '',
      runDirectory: RUN_DIRECTORY,
      ownedFileNames: [RUN_FILE_NAME],
      attemptedFileName: RUN_FILE_NAME,
      marker: MARKER,
    });
    expect(result.ok).toBe(true);
    expect(result.deleted).toEqual([path]);
    expect(result.unexpected).toEqual([]);
    // Directory listing + ownership verification read + final check read:
    // exactly THREE reads, and NO separate unverified SHA fetch.
    expect(calls.getContent).toBe(3);
    expect(calls.deleteFile).toBe(1);
    expect(calls.deleteShas).toEqual([SHA_40]);
  });

  test('a simulated replacement after marker verification: the SHA-protected delete fails, no retry, replacement intact', async () => {
    const path = `${RUN_DIRECTORY}/${RUN_FILE_NAME}`;
    const replacementContent = `Replaced by another run at ${new Date().toISOString()}`;
    const artifact: FakeFile = { path, content: RUN_CONTENT, sha: SHA_40, deleted: false };
    const { client, calls } = makeFakeClient(
      { [path]: artifact },
      [],
      {
        // Simulate a concurrent replacement landing between the ownership
        // verification and the deletion call.
        beforeDelete: () => {
          artifact.content = replacementContent;
          artifact.sha = SHA_40_REPLACEMENT;
        },
      },
    );
    const result = await performRunCleanup({
      client,
      owner: 'owner-a',
      repo: 'test-repo',
      contentRoot: '',
      runDirectory: RUN_DIRECTORY,
      ownedFileNames: [RUN_FILE_NAME],
      attemptedFileName: RUN_FILE_NAME,
      marker: MARKER,
    });
    expect(result.ok).toBe(false);
    expect(result.deleted).toEqual([]);
    expect(result.unexpected).toContain(RUN_FILE_NAME);
    // Exactly ONE deletion attempt, made with the originally VERIFIED SHA —
    // never with the replacement file's SHA (no retry with a newer SHA).
    expect(calls.deleteFile).toBe(1);
    expect(calls.deleteShas).toEqual([SHA_40]);
    // The failure is the sanitized conflict text; the raw upstream message
    // and the replacement SHA never enter diagnostics.
    const diagnostics = result.errors.join(' ');
    expect(diagnostics).toMatch(/upstream conflict \(409\)/);
    expect(diagnostics).not.toContain(RAW_409_MESSAGE);
    expect(diagnostics).not.toContain(SHA_40_REPLACEMENT);
    // The replacement file remains intact — only the old SHA was used.
    expect(artifact.deleted).toBe(false);
    expect(artifact.content).toBe(replacementContent);
    expect(artifact.sha).toBe(SHA_40_REPLACEMENT);
    // The final check still reports the run directory exists.
    expect(result.directoryGone).toBe(false);
    expect(
      result.errors.some((e) => e.includes('final check: the run directory still exists')),
    ).toBe(true);
  });

  test.each([
    [
      'invalid base64 content',
      (validBase64: string) => validBase64.slice(0, 4) + '$' + validBase64.slice(5),
    ],
    ['invalid UTF-8 content', () => Buffer.from('fffeff', 'hex').toString('base64')],
  ])('prevents deletion for %s', async (_label, rawContentOverride) => {
    const path = `${RUN_DIRECTORY}/${RUN_FILE_NAME}`;
    const artifact: FakeFile = {
      path,
      content: RUN_CONTENT,
      sha: SHA_40,
      rawContent: rawContentOverride(Buffer.from(RUN_CONTENT, 'utf8').toString('base64')),
      deleted: false,
    };
    const { client, calls } = makeFakeClient({ [path]: artifact });
    const result = await performRunCleanup({
      client,
      owner: 'owner-a',
      repo: 'test-repo',
      contentRoot: '',
      runDirectory: RUN_DIRECTORY,
      ownedFileNames: [RUN_FILE_NAME],
      attemptedFileName: RUN_FILE_NAME,
      marker: MARKER,
    });
    expect(result.ok).toBe(false);
    expect(result.deleted).toEqual([]);
    expect(result.unexpected).toContain(RUN_FILE_NAME);
    expect(calls.deleteFile).toBe(0);
    expect(result.errors.join(' ')).toMatch(/ownership could not be established/);
    expect(artifact.deleted).toBe(false);
  });

  test('prevents deletion when the returned blob SHA is malformed', async () => {
    const path = `${RUN_DIRECTORY}/${RUN_FILE_NAME}`;
    const artifact: FakeFile = { path, content: RUN_CONTENT, sha: 'xyz-not-a-sha', deleted: false };
    const { client, calls } = makeFakeClient({ [path]: artifact });
    const result = await performRunCleanup({
      client,
      owner: 'owner-a',
      repo: 'test-repo',
      contentRoot: '',
      runDirectory: RUN_DIRECTORY,
      ownedFileNames: [RUN_FILE_NAME],
      attemptedFileName: RUN_FILE_NAME,
      marker: MARKER,
    });
    expect(result.ok).toBe(false);
    expect(result.deleted).toEqual([]);
    expect(calls.deleteFile).toBe(0);
    expect(result.errors.join(' ')).toMatch(/blob SHA is malformed/);
    expect(artifact.deleted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GitHub base64 line-wrap tolerance (live-run cleanup failure regression)
// ---------------------------------------------------------------------------
//
// The first authorized live run failed during cleanup because GitHub's
// Contents API delivers base64 wrapped at 64 columns with CR/LF line
// breaks, and the decoder rejected the line breaks before the ownership
// marker could be verified. These deterministic fake-client tests pin the
// corrected decoder: wrapping is accepted, but every other strictness rule
// still fails closed (no deletion without a verified marker + canonical
// decode + verified SHA).

/** Deterministic 219-byte Markdown payload carrying the given marker. */
function payload219(marker: string): string {
  const head =
    '# Integration Test Article\n\n' +
    'This article was created by the GitDatNote integration test.\n\n' +
    'Unicode sample: ☃ — em dash test.\n\n' +
    `<!-- ${marker} -->\n`;
  const baseBytes = Buffer.byteLength(head, 'utf8');
  if (baseBytes < 1 || baseBytes > 219) {
    throw new Error(`test payload base is ${baseBytes} bytes (must fit in 219)`);
  }
  // Deterministic padding to exactly 219 bytes (UTF-8 'x' characters).
  return head + 'x'.repeat(219 - baseBytes);
}

/** Wrap compact base64 the way GitHub's Contents API does (64-column lines). */
function wrapBase64(compact: string, eol: string): string {
  const lines: string[] = [];
  for (let i = 0; i < compact.length; i += 64) {
    lines.push(compact.slice(i, i + 64));
  }
  return lines.join(eol);
}

describe('GitHub base64 line-wrap tolerance (offline, fake client only)', () => {
  const path = `${RUN_DIRECTORY}/${RUN_FILE_NAME}`;

  function cleanupArgs(client: CleanupClient, marker: string = MARKER) {
    return {
      client,
      owner: 'owner-a',
      repo: 'test-repo',
      contentRoot: '',
      runDirectory: RUN_DIRECTORY,
      ownedFileNames: [RUN_FILE_NAME],
      attemptedFileName: RUN_FILE_NAME,
      marker,
    };
  }

  test('accepts the 219-byte Markdown payload with LF-wrapped base64 (the observed live-run failure)', async () => {
    const payload = payload219(MARKER);
    expect(Buffer.byteLength(payload, 'utf8')).toBe(219);
    const compact = Buffer.from(payload, 'utf8').toString('base64');
    const wrapped = wrapBase64(compact, '\n');
    expect(wrapped).not.toBe(compact); // sanity: wrapping inserted line breaks
    const { client, calls } = makeFakeClient({
      [path]: { path, content: payload, sha: SHA_40, rawContent: wrapped },
    });
    const result = await performRunCleanup(cleanupArgs(client));
    expect(result.ok).toBe(true);
    expect(result.deleted).toEqual([path]);
    expect(result.unexpected).toEqual([]);
    expect(result.directoryGone).toBe(true);
    expect(calls.deleteFile).toBe(1);
    // The SHA from the same ownership-verified (wrapped) response, unchanged.
    expect(calls.deleteShas).toEqual([SHA_40]);
  });

  test('accepts the same payload with CRLF-wrapped base64', async () => {
    const payload = payload219(MARKER);
    const wrapped = wrapBase64(Buffer.from(payload, 'utf8').toString('base64'), '\r\n');
    const { client, calls } = makeFakeClient({
      [path]: { path, content: payload, sha: SHA_40, rawContent: wrapped },
    });
    const result = await performRunCleanup(cleanupArgs(client));
    expect(result.ok).toBe(true);
    expect(result.deleted).toEqual([path]);
    expect(result.directoryGone).toBe(true);
    expect(calls.deleteFile).toBe(1);
    expect(calls.deleteShas).toEqual([SHA_40]);
  });

  test('still rejects a malformed base64 character inside wrapped content', async () => {
    const payload = payload219(MARKER);
    const compact = Buffer.from(payload, 'utf8').toString('base64');
    const idx = compact.search(/[A-Za-z0-9+/]/);
    const corrupted = wrapBase64(compact.slice(0, idx) + '$' + compact.slice(idx + 1), '\n');
    const artifact: FakeFile = { path, content: payload, sha: SHA_40, rawContent: corrupted, deleted: false };
    const { client, calls } = makeFakeClient({ [path]: artifact });
    const result = await performRunCleanup(cleanupArgs(client));
    expect(result.ok).toBe(false);
    expect(result.deleted).toEqual([]);
    expect(result.unexpected).toContain(RUN_FILE_NAME);
    expect(calls.deleteFile).toBe(0);
    expect(result.errors.join(' ')).toMatch(/not valid base64/);
    expect(artifact.deleted).toBe(false);
  });

  test('still rejects noncanonical base64 (non-zero trailing bits)', async () => {
    // 'QR==' carries non-zero trailing bits in the final group that a
    // permissive decoder silently drops; the canonical round-trip check
    // (decode, then re-encode) must reject the noncanonical form.
    const artifact: FakeFile = { path, content: RUN_CONTENT, sha: SHA_40, rawContent: 'QR==', deleted: false };
    const { client, calls } = makeFakeClient({ [path]: artifact });
    const result = await performRunCleanup(cleanupArgs(client));
    expect(result.ok).toBe(false);
    expect(calls.deleteFile).toBe(0);
    expect(result.errors.join(' ')).toMatch(/not valid base64/);
    expect(artifact.deleted).toBe(false);
  });

  test('still rejects invalid padding (no base64 data)', async () => {
    const artifact: FakeFile = { path, content: RUN_CONTENT, sha: SHA_40, rawContent: '====', deleted: false };
    const { client, calls } = makeFakeClient({ [path]: artifact });
    const result = await performRunCleanup(cleanupArgs(client));
    expect(result.ok).toBe(false);
    expect(calls.deleteFile).toBe(0);
    expect(result.errors.join(' ')).toMatch(/not valid base64/);
    expect(artifact.deleted).toBe(false);
  });

  test('still rejects invalid UTF-8 bytes (wrapped)', async () => {
    const invalidBytes = Buffer.from('fffeff', 'hex');
    const artifact: FakeFile = {
      path,
      content: RUN_CONTENT,
      sha: SHA_40,
      rawContent: wrapBase64(invalidBytes.toString('base64'), '\n'),
      deleted: false,
    };
    const { client, calls } = makeFakeClient({ [path]: artifact });
    const result = await performRunCleanup(cleanupArgs(client));
    expect(result.ok).toBe(false);
    expect(calls.deleteFile).toBe(0);
    expect(result.errors.join(' ')).toMatch(/not valid UTF-8/);
    expect(artifact.deleted).toBe(false);
  });

  test('still requires the exact run marker (wrapped content, wrong marker)', async () => {
    const payload = payload219('a-different-run-marker');
    const wrapped = wrapBase64(Buffer.from(payload, 'utf8').toString('base64'), '\n');
    const artifact: FakeFile = { path, content: payload, sha: SHA_40, rawContent: wrapped, deleted: false };
    const { client, calls } = makeFakeClient({ [path]: artifact });
    const result = await performRunCleanup(cleanupArgs(client));
    expect(result.ok).toBe(false);
    expect(calls.deleteFile).toBe(0);
    expect(result.errors.join(' ')).toMatch(/does not carry this run's marker/);
    expect(artifact.deleted).toBe(false);
  });

  test('a concurrent replacement after wrapped-base64 verification still fails without retry', async () => {
    const payload = payload219(MARKER);
    const wrapped = wrapBase64(Buffer.from(payload, 'utf8').toString('base64'), '\n');
    const artifact: FakeFile = { path, content: payload, sha: SHA_40, rawContent: wrapped, deleted: false };
    const replacedContent = 'Replaced content after verification.\n';
    const { client, calls } = makeFakeClient(
      { [path]: artifact },
      [],
      {
        beforeDelete: () => {
          artifact.content = replacedContent;
          artifact.sha = SHA_40_REPLACEMENT;
        },
      },
    );
    const result = await performRunCleanup(cleanupArgs(client));
    expect(result.ok).toBe(false);
    expect(result.deleted).toEqual([]);
    expect(result.unexpected).toContain(RUN_FILE_NAME);
    // One deletion attempt with the verified SHA; no retry with the newer one.
    expect(calls.deleteFile).toBe(1);
    expect(calls.deleteShas).toEqual([SHA_40]);
    expect(result.errors.join(' ')).toMatch(/conflict/);
    // The replacement file is untouched.
    expect(artifact.deleted).toBe(false);
    expect(artifact.content).toBe(replacedContent);
    expect(artifact.sha).toBe(SHA_40_REPLACEMENT);
  });
});

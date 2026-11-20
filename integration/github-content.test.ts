/**
 * Task 5.3 — real GitHub content lifecycle through the production content
 * adapter, with strict isolation and guaranteed cleanup.
 *
 * OPT-IN ONLY. This file is discovered exclusively by
 * `integration/vitest.config.ts`, which is selected only by
 * `npm run test:integration` (integration/run.mjs) after the opt-in flag
 * and a fail-closed configuration check pass. It never runs from
 * `npm run test` or `npm run test:e2e`, and it never runs in normal CI.
 *
 * One coherent lifecycle (explicitly ordered, stateful):
 *
 *   read-only preflight -> create -> read back -> update (correct SHA)
 *   -> stale-SHA conflict (409) -> directory listing
 *
 * Corrected (source review):
 * - Configuration: `process.env` is validated fail-closed against the
 *   accepted contract (integration/config.js) BEFORE any network access.
 *   The token is read from GITHUB_INTEGRATION_TOKEN only after successful
 *   validation and is never printed or included in errors. Nothing is
 *   inferred from other sources.
 * - Preflight: the repository identity reported by GitHub must match the
 *   configured target and pass the pure preflight policy check
 *   (checkPreflightPolicy in safety.ts, rules from config.js): exact
 *   dedicated integration-test naming pattern (DEDICATED_REPO_PATTERN),
 *   no reserved production targets, and no EXACT match of the GitDatNote
 *   application source owner/repository pair (case-insensitive — the
 *   owner alone never blocks a dedicated test repository).
 * - Ownership: the exact intended artifact path and the run-specific
 *   marker are recorded BEFORE the create attempt. On EVERY attempted
 *   create, finalization uses read-only checks to determine whether the
 *   artifact exists and belongs to this run (exact path + marker in the
 *   file's content) before any deletion. A rejected or malformed create
 *   response is never assumed to mean the file does not exist, and a
 *   cleanup 404 for a recorded artifact is confirmed by a direct read.
 * - Cleanup: direct GitHub Contents API deletes using the SHA from the
 *   SAME ownership-verified Contents API response (no second, unverified
 *   SHA fetch); exact run-directory and file-name allowlists; no
 *   recursive deletion, no retries — a SHA conflict after verification is
 *   a reported failure, never a retry with a newer SHA; no reported
 *   success without confirmation.
 *
 * Requires: GITHUB_INTEGRATION=true, GITHUB_INTEGRATION_REPO, and
 * GITHUB_INTEGRATION_TOKEN (see integration/config.js).
 *
 * Real, non-mocked behavior: the production adapter
 * (`createContentAdapter` from `src/server/content/index.ts`) is driven by
 * a real authenticated Octokit Contents API client built from
 * `GITHUB_INTEGRATION_TOKEN`. No in-memory mocks, no fake API responses.
 */

import { Buffer } from 'node:buffer';
import { Octokit } from 'octokit';
import { expect, test } from 'vitest';

import {
  createContentAdapter,
} from '../src/server/content/index.js';
import { ContentAdapterError } from '../src/server/content/types.js';
import {
  DEFAULT_CONTENT_ROOT,
  type ShaConflictErrorDetail,
} from '../src/shared/types.js';

import {
  TOKEN_VAR,
} from './config.js';
import {
  performRunCleanup,
  sanitizeUpstreamError,
  type CleanupOutcome,
} from './cleanup.js';
import {
  buildRunArtifactPath,
  checkPreflightPolicy,
  defaultRunSuffix,
  generateRunDirectory,
  isRunDirectory,
  resolveLiveIntegrationConfig,
  RUN_FILE_NAME,
} from './safety.js';

/** GitHub's authenticated API endpoint (the only endpoint this suite uses). */
const GITHUB_API_BASE = 'https://api.github.com/';

/** Read an HTTP status off an unknown upstream (Octokit) error, if any. */
function readStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) {
    return null;
  }
  const direct = (err as { status?: unknown }).status;
  if (typeof direct === 'number' && Number.isInteger(direct)) {
    return direct;
  }
  const response = (err as { response?: { status?: unknown } }).response;
  if (
    typeof response === 'object' &&
    response !== null &&
    typeof response.status === 'number' &&
    Number.isInteger(response.status)
  ) {
    return response.status;
  }
  return null;
}

/**
 * Read-only preflight before the first mutation (task 5.3 requirement).
 * All checks fail closed; failures produce fixed descriptions — no raw
 * API response bodies, network exception text, tokens, or Authorization
 * headers are ever printed.
 */
async function preflight(owner: string, repo: string, octokit: Octokit): Promise<void> {
  // 1. The client targets GitHub's authenticated API endpoint.
  // `request.endpoint()` is the v3 Octokit endpoint resolver; it returns
  // the fully resolved URL for a request without sending it.
  let resolvedUrl: string;
  try {
    resolvedUrl = (octokit.request as unknown as {
      endpoint: (options: { method: string; url: string }) => { url: string };
    }).endpoint({ method: 'GET', url: '/repos/owner/repo' }).url;
  } catch {
    throw new Error(
      'preflight failed: the content client does not target GitHub\'s authenticated API endpoint',
    );
  }
  // Exact origin match (a prefix check would also accept lookalike
  // hosts such as api.github.com.evil.com).
  let origin: string;
  try {
    origin = new URL(resolvedUrl).origin;
  } catch {
    origin = '';
  }
  if (origin !== new URL(GITHUB_API_BASE).origin) {
    throw new Error(
      'preflight failed: the content client does not target GitHub\'s authenticated API endpoint',
    );
  }

  // 2. The repository exists and is accessible with the dedicated token.
  // (Reachability does NOT itself establish Contents write permission;
  // that is exercised — and honestly reported — by the lifecycle below.)
  let repoInfo;
  try {
    repoInfo = await octokit.rest.repos.get({ owner, repo });
  } catch (err) {
    throw new Error(
      `preflight failed: repository metadata could not be retrieved (${sanitizeUpstreamError(err)})`,
    );
  }

  // 3. Pure preflight identity/policy check against the identity GitHub
  // actually reported: the reported `owner/name` must match the configured
  // target, and the target must pass the repository policy — reserved
  // names (SecondBrain), the EXACT GitDatNote application source pair
  // (owner AND name, case-insensitive — the owner alone never blocks a
  // properly named dedicated test repository), placeholder values, and the
  // exact dedicated integration-test naming convention. The rules are
  // reused from integration/config.js via checkPreflightPolicy; the
  // repository metadata request above remains read-only.
  const policy = checkPreflightPolicy({
    configuredOwner: owner,
    configuredRepo: repo,
    reportedOwnerLogin: repoInfo.data.owner.login,
    reportedRepoName: repoInfo.data.name,
  });
  if (!policy.ok) {
    throw new Error(`preflight failed: ${policy.message}`);
  }
}

test(
  'real GitHub content lifecycle with an isolated run directory and guaranteed cleanup',
  async () => {
    // --- Fail-closed configuration resolution (no network access) --------
    // process.env is validated against the accepted configuration contract
    // (integration/config.js) before anything else happens; on failure the
    // run stops with fixed, credential-free diagnostics.
    const resolvedConfig = resolveLiveIntegrationConfig(process.env);
    if (!resolvedConfig.ok) {
      throw new Error(
        `live integration configuration is invalid (fail closed): ${resolvedConfig.errors.join(' | ')}`,
      );
    }
    const { owner, repo } = resolvedConfig;
    // The token is obtained only AFTER successful validation and is never
    // printed or included in errors.
    const token = process.env[TOKEN_VAR];
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error(
        'live integration configuration is invalid (fail closed): the integration token is missing',
      );
    }
    // The content root comes from the existing adapter contract (the same
    // root the production server resolves), never an arbitrary assumption.
    const contentRoot = DEFAULT_CONTENT_ROOT;

    const octokit = new Octokit({ auth: token, baseUrl: 'https://api.github.com' });

    await preflight(owner, repo, octokit);

    // Unique, filename-safe isolation namespace for THIS run only.
    const runDirectory = generateRunDirectory(new Date(), defaultRunSuffix);
    expect(isRunDirectory(runDirectory)).toBe(true);

    const artifact = buildRunArtifactPath(contentRoot, runDirectory, RUN_FILE_NAME);
    expect(artifact.ok).toBe(true);
    const relativePath = artifact.ok ? artifact.relativePath : '';
    const repositoryPath = artifact.ok ? artifact.repositoryPath : '';

    // Ownership record, made BEFORE the create attempt: the exact intended
    // artifact path and the run-specific marker that identifies this run's
    // content. The marker must satisfy the ownership-marker contract
    // enforced by performRunCleanup (alphanumerics plus space . _ @ -; it
    // is embedded in the file content and matched verbatim there). A
    // remote write can succeed even when the client receives an error or a
    // malformed response, so these are the basis of the read-only ownership
    // verification in finalization.
    const marker = `gitdatnote-run-${runDirectory}`;

    // The path must not already exist: create fails rather than overwrites.
    let pathExists = true;
    try {
      await octokit.rest.repos.getContent({
        owner,
        repo,
        path: repositoryPath,
      });
    } catch (err) {
      if (readStatus(err) === 404) {
        pathExists = false;
      } else {
        throw new Error(
          `pre-create existence check failed: ${sanitizeUpstreamError(err)}`,
        );
      }
    }
    expect(pathExists).toBe(false);

    const adapter = createContentAdapter({ client: octokit, contentRoot });

    // Deterministic content with a run-specific marker for readback
    // comparison.
    const originalContent = [
      '# GitDatNote Integration Article',
      '',
      'This article was written by the GitDatNote real GitHub integration test.',
      '',
      'UTF-8 sample: ünïcødé — «guillemets» — 日本語テキスト — ✓ emoji',
      '',
      `Marker: ${marker}`,
      '',
    ].join('\n');
    const updatedContent = [
      '# GitDatNote Integration Article (updated)',
      '',
      'This is the updated version written by the GitDatNote real GitHub integration test.',
      '',
      `Marker: ${marker} (updated)`,
      '',
    ].join('\n');
    const originalSize = Buffer.byteLength(originalContent, 'utf8');
    const updatedSize = Buffer.byteLength(updatedContent, 'utf8');

    let lifecycleError: unknown;
    // File names confirmed created by a successful adapter return. The
    // cleanup allowlist is this list PLUS the attempted file name, so a
    // write that landed despite a lost/malformed response is still found
    // and verified (never assumed absent).
    const ownedFileNames: string[] = [];

    try {
      // --- Stage 1: create -------------------------------------------------
      const created = await adapter.createContent(owner, repo, relativePath, originalContent);
      expect(created.path).toBe(relativePath);
      expect(created.sha).toMatch(/^[0-9a-f]{40}$/);
      ownedFileNames.push(RUN_FILE_NAME);
      const originalSha = created.sha;

      // --- Stage 2: read back ----------------------------------------------
      const readBack = await adapter.readContent(owner, repo, relativePath);
      expect(readBack.type).toBe('file');
      expect(readBack.path).toBe(relativePath);
      expect(readBack.content).toBe(originalContent);
      expect(readBack.sha).toBe(originalSha);
      expect(readBack.size).toBe(originalSize);

      // --- Stage 3: update with the correct SHA ----------------------------
      const updated = await adapter.updateContent(owner, repo, relativePath, updatedContent, readBack.sha);
      expect(updated.path).toBe(relativePath);
      expect(updated.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(updated.sha).not.toBe(originalSha);

      const updatedReadBack = await adapter.readContent(owner, repo, relativePath);
      expect(updatedReadBack.content).toBe(updatedContent);
      expect(updatedReadBack.sha).toBe(updated.sha);
      expect(updatedReadBack.size).toBe(updatedSize);

      // --- Stage 4: stale-SHA conflict (mapped 409 contract) ---------------
      let conflict: unknown;
      try {
        await adapter.updateContent(owner, repo, relativePath, updatedContent, originalSha);
      } catch (err) {
        conflict = err;
      }
      expect(conflict).toBeInstanceOf(ContentAdapterError);
      const detail = (conflict as ContentAdapterError).detail;
      expect(detail.code).toBe('SHA_CONFLICT');
      // The adapter maps the conflict to its 409 error contract.
      expect(detail.status).toBe(409);
      // The mapped 409 contract MUST carry the current blob SHA; a missing
      // field is a contract violation, not an optional pass.
      if (!('currentSha' in detail)) {
        throw new Error('the SHA_CONFLICT 409 contract must carry the current blob SHA');
      }
      expect((detail as ShaConflictErrorDetail).currentSha).toBe(updated.sha);

      // The stale update must not have overwritten anything.
      const afterConflict = await adapter.readContent(owner, repo, relativePath);
      expect(afterConflict.content).toBe(updatedContent);
      expect(afterConflict.sha).toBe(updated.sha);

      // --- Stage 5: directory listing (scoped to the run directory) --------
      const listing = await adapter.listContent(owner, repo, runDirectory);
      expect(listing.type).toBe('directory');
      expect(listing.path).toBe(runDirectory);
      // The freshly created directory holds exactly the one artifact this
      // run wrote — nothing else.
      expect(listing.children.length).toBe(1);
      expect(listing.children[0]).toEqual({
        name: RUN_FILE_NAME,
        type: 'file',
        sha: updated.sha,
        size: updatedSize,
      });
    } catch (err) {
      lifecycleError = err;
    } finally {
      // --- Guaranteed finalization ------------------------------------------
      // Runs unconditionally for every attempted create: the remote write
      // may have landed even if the client saw an error or a malformed
      // response, so performRunCleanup verifies read-only whether the
      // artifact exists and belongs to THIS run (exact path + marker in
      // content) before any deletion. A 404 for a recorded artifact is
      // confirmed by a direct read, and success is reported only with
      // confirmation.
      let cleanupOutcome: CleanupOutcome;
      try {
        cleanupOutcome = await performRunCleanup({
          client: octokit,
          owner,
          repo,
          contentRoot,
          runDirectory,
          ownedFileNames,
          attemptedFileName: RUN_FILE_NAME,
          marker,
        });
      } catch (cleanupErr) {
        // Defensive: performRunCleanup reports structured failures; a
        // thrown error still fails closed with sanitized text only.
        cleanupOutcome = {
          ok: false,
          deleted: [],
          unexpected: [],
          errors: [`cleanup itself failed (${sanitizeUpstreamError(cleanupErr)})`],
          directoryGone: false,
          confirmedAbsent: [],
        };
      }

      if (!cleanupOutcome.ok) {
        // A cleanup failure is NEVER a passing test.
        const issues = [
          ...cleanupOutcome.errors,
          ...cleanupOutcome.unexpected.map((name) => `unexpected file present: ${name}`),
        ].join('; ');
        // Intentional: the spec requires a failed cleanup to fail the test.
        // eslint-disable-next-line no-unsafe-finally
        throw new Error(
          `Cleanup failed: test content may remain in ${owner}/${repo} ` +
            `at ${contentRoot}/${runDirectory}. ${issues}`,
        );
      }

      if (lifecycleError !== undefined) {
        // Re-throw the original failure only after cleanup has succeeded;
        // a cleanup failure above already takes precedence.
        // eslint-disable-next-line no-unsafe-finally
        throw lifecycleError;
      }
    }
  },
  120_000, // real GitHub latency budget for the full lifecycle + cleanup
);

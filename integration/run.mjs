/**
 * Opt-in integration-test runner (OpenSpec task 5.1).
 *
 * Invoked as:  npm run test:integration
 *
 * Behavior:
 * - GITHUB_INTEGRATION not exactly "true":
 *   prints an explicit "integration tests disabled" notice and exits 0.
 *   No GitHub contact, no credentials loaded, no tests executed. This is
 *   NOT a pass for real-GitHub integration coverage.
 * - GITHUB_INTEGRATION=true with invalid configuration:
 *   fails closed (exit 1) with secret-free errors BEFORE any test runs.
 * - GITHUB_INTEGRATION=true with valid configuration:
 *   runs ONLY the dedicated integration suite via the separate
 *   integration/vitest.config.ts (the normal unit/web/e2e suites are never
 *   executed as a side effect).
 *
 * At this milestone the integration suite is non-mutating and offline:
 * it verifies the harness configuration and the runner's disabled/
 * fail-closed behavior. Real-GitHub create/read/update/conflict/list
 * coverage arrives in task 5.3 and must not be claimed before then.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isIntegrationEnabled,
  REPO_VAR,
  validateIntegrationConfig,
} from './config.js';

/** Exact notice printed (and exit-0) when the suite is disabled. */
export const DISABLED_MESSAGE = [
  'Integration tests are DISABLED.',
  `${'GITHUB_INTEGRATION'} is not set to exactly "true".`,
  '- No GitHub contact was made.',
  '- No credentials were loaded.',
  '- No integration tests were executed.',
  'This is not a pass for real-GitHub integration testing.',
  'See integration/README.md to create the dedicated test repository and',
  'enable the suite (GITHUB_INTEGRATION=true, GITHUB_INTEGRATION_REPO,',
  'GITHUB_INTEGRATION_TOKEN).',
].join('\n');

/**
 * Pure decision function for the runner (offline, no I/O):
 *   { status: 'disabled' }            — opt-in not enabled
 *   { status: 'invalid', errors: [] } — enabled but configuration failed
 *   { status: 'ready' }               — enabled and configuration valid
 */
export function evaluateIntegrationEnv(env = {}) {
  if (!isIntegrationEnabled(env)) return { status: 'disabled' };
  const { ok, errors } = validateIntegrationConfig(env);
  return ok ? { status: 'ready' } : { status: 'invalid', errors };
}

function runIntegrationSuite() {
  const vitestEntry = path.join(
    process.cwd(),
    'node_modules',
    'vitest',
    'vitest.mjs'
  );
  if (!existsSync(vitestEntry)) {
    console.error('vitest is not installed. Run `npm ci` first.');
    return 1;
  }
  console.log(
    `Configuration valid; running the dedicated integration suite for ` +
      `${process.env[REPO_VAR].trim()} (offline harness at this milestone).`
  );
  const args = [
    vitestEntry,
    'run',
    '--config',
    path.join('integration', 'vitest.config.ts'),
  ];
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      { cwd: process.cwd(), env: process.env },
      (error, stdout, stderr) => {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        resolve(error ? (Number.isInteger(error.code) ? error.code : 1) : 0);
      }
    );
  });
}

async function main() {
  const evaluation = evaluateIntegrationEnv(process.env);
  if (evaluation.status === 'disabled') {
    console.log(DISABLED_MESSAGE);
    return 0;
  }
  if (evaluation.status === 'invalid') {
    console.error(
      'Integration tests are ENABLED but the configuration is invalid (fail-closed).'
    );
    for (const error of evaluation.errors) console.error(`  - ${error}`);
    console.error(
      'No integration tests were executed and no GitHub contact was made.'
    );
    return 1;
  }
  return await runIntegrationSuite();
}

// Run main() only when executed directly (`node integration/run.mjs`),
// not when imported by tests.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().then((code) => process.exit(code));
}

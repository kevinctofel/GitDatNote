import { defineConfig } from "vitest/config";

/**
 * Dedicated Vitest configuration for the opt-in GitHub integration suite
 * (OpenSpec tasks 5.1 and 5.3).
 *
 * Isolation guarantees:
 * - The default `vitest.config.ts` include set (characterization / unit /
 *   web) does NOT cover `integration/**`, so `npm run test` never runs
 *   integration tests.
 * - Only `npm run test:integration` (integration/run.mjs) selects this
 *   configuration, and it does so only after GITHUB_INTEGRATION=true and a
 *   valid, fail-closed configuration check.
 *
 * Suite contents:
 * - `harness.test.ts` — offline harness/configuration safety (task 5.1);
 * - `github-content.test.ts` — real-GitHub content lifecycle through the
 *   production content adapter, with guaranteed Contents-API cleanup
 *   (task 5.3). The live suite only runs against the operator-configured
 *   dedicated test repository and makes real network calls by design.
 *
 * Timeouts are generous for real GitHub latency.
 */
export default defineConfig({
  test: {
    include: ["integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});

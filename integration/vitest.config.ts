import { defineConfig } from "vitest/config";

/**
 * Dedicated Vitest configuration for the opt-in GitHub integration suite
 * (OpenSpec task 5.1).
 *
 * Isolation guarantees:
 * - The default `vitest.config.ts` include set (characterization / unit /
 *   web) does NOT cover `integration/**`, so `npm run test` never runs
 *   integration tests.
 * - Only `npm run test:integration` (integration/run.mjs) selects this
 *   configuration, and it does so only after GITHUB_INTEGRATION=true and a
 *   valid, fail-closed configuration check.
 *
 * At this milestone the suite under this config is non-mutating and
 * offline (harness configuration + runner safety). Real-GitHub coverage
 * (task 5.3) will add live tests here against the dedicated test
 * repository; until then, a green run under this config is NOT evidence of
 * real-GitHub content integration coverage.
 */
export default defineConfig({
  test: {
    include: ["integration/**/*.test.ts"],
    environment: "node",
    // Live GitHub tests (task 5.3) will need generous timeouts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

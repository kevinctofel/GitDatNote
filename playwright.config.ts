import { defineConfig } from "@playwright/test";

/**
 * Playwright configuration for the foundation task 2.7 browser XSS
 * regression tests.
 *
 * - Tests the real running Vite dev server (Playwright starts and stops it).
 * - Headless Chromium; Playwright gives every test an isolated browser
 *   context (no shared storage or state between tests).
 * - Deterministic local fixtures only. No GitHub credentials, no live
 *   SecondBrain repository, no production-only routes.
 * - Kept separate from the Vitest unit tests (separate config file, separate
 *   `tests/e2e` directory that Vitest's `include` does not cover).
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  // One worker: the tests share the single dev server and must stay
  // deterministic, so run them sequentially.
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    headless: true,
    baseURL: "http://localhost:5173",
    // Each test gets a fresh, isolated browser context (Playwright default);
    // no storageState is shared, so contexts never leak state to each other.
  },
  webServer: {
    command: "npm run dev -- --port 5173 --strictPort",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});

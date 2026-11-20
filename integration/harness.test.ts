/**
 * Integration harness suite (OpenSpec task 5.1) — opt-in only.
 *
 * This file is discovered ONLY by integration/vitest.config.ts and only
 * when `npm run test:integration` passes its fail-closed configuration
 * check (GITHUB_INTEGRATION=true + valid dedicated-repo configuration).
 *
 * SCOPE: harness and configuration safety only. The tests below are
 * non-mutating and offline. The real-GitHub content lifecycle
 * (create/read/update/conflict/list with guaranteed cleanup) lives in
 * `github-content.test.ts` and is a separate, operator-approved live
 * suite.
 *
 * The process-level fetch guard records every network call made from
 * this Vitest process. The zero-network assertion below is scoped to
 * the calls made DURING THIS HARNESS BLOCK, so it proves the
 * harness/configuration validation performs no network I/O without
 * depending on whether the live suite (which makes real calls by
 * design) ran earlier in the same process.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

const execFileAsync = promisify(execFile);

import {
  isIntegrationEnabled,
  validateIntegrationConfig,
} from "./config.js";
import { DISABLED_MESSAGE, evaluateIntegrationEnv } from "./run.mjs";

const fetchCalls: string[] = [];
let realFetch: typeof fetch;

beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    fetchCalls.push(String(args[0]));
    return realFetch(...args);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("task 5.1 integration harness (opt-in suite)", () => {
  // Number of calls recorded before this block started; the zero-network
  // assertion only counts calls made during the harness block itself.
  const fetchCallsAtBlockStart: number[] = [0];

  beforeAll(() => {
    fetchCallsAtBlockStart[0] = fetchCalls.length;
  });

  it("ran under an explicitly enabled, valid, dedicated-test configuration", () => {
    // The runner (integration/run.mjs) validates before vitest starts;
    // if this fails, the runner failed closed incorrectly.
    expect(isIntegrationEnabled(process.env)).toBe(true);
    const { ok, errors } = validateIntegrationConfig(process.env);
    expect({ ok, errors }).toEqual({ ok: true, errors: [] });
  });

  it("disabled evaluation is a pure decision (no I/O, no network)", () => {
    expect(evaluateIntegrationEnv({})).toEqual({ status: "disabled" });
    expect(evaluateIntegrationEnv({ GITHUB_INTEGRATION: "TRUE" })).toEqual({
      status: "disabled",
    });
    expect(evaluateIntegrationEnv({ GITHUB_INTEGRATION: "true" })).toEqual({
      status: "invalid",
      errors: expect.any(Array),
    });
  });

  it("the disabled CLI path exits 0, says disabled, and runs nothing", async () => {
    const env = { ...process.env };
    delete env.GITHUB_INTEGRATION;
    delete env.GITHUB_INTEGRATION_REPO;
    delete env.GITHUB_INTEGRATION_TOKEN;
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join("integration", "run.mjs")],
      { cwd: process.cwd(), env, encoding: "utf8", timeout: 30_000 }
    );
    expect(stdout).toContain(DISABLED_MESSAGE);
    // Not a pass claim, and vitest was never invoked.
    expect(stdout).not.toMatch(/Test Files/);
    expect(stdout).not.toMatch(/passed/i);
  }, 30_000);

  it("the enabled-but-invalid CLI path fails closed (exit 1, secret-free)", async () => {
    const env = {
      ...process.env,
      GITHUB_INTEGRATION: "true",
      GITHUB_INTEGRATION_REPO: "kevinctofel/SecondBrain",
      GITHUB_INTEGRATION_TOKEN: "harness-fail-closed-token-not-a-secret",
    };
    let exitCode = 0;
    let stdout = "";
    let stderr = "";
    try {
      const result = await execFileAsync(
        process.execPath,
        [path.join("integration", "run.mjs")],
        { cwd: process.cwd(), env, encoding: "utf8", timeout: 30_000 }
      );
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error: unknown) {
      exitCode =
        typeof error === "object" && error !== null && "code" in error
          ? Number((error as { code: unknown }).code)
          : 1;
      const errorObject = error as { stdout?: string; stderr?: string };
      stdout = errorObject.stdout ?? "";
      stderr = errorObject.stderr ?? "";
    }
    const output = `${stdout}${stderr}`;
    expect(exitCode).toBe(1);
    expect(output).toContain("fail-closed");
    expect(output).toContain("SecondBrain");
    // The configured token must never appear in any output.
    expect(output).not.toContain("harness-fail-closed-token-not-a-secret");
    // vitest was never invoked on the invalid path.
    expect(output).not.toMatch(/Test Files/);
  }, 30_000);

  it("validation itself performs no network calls", () => {
    const callsBefore = fetchCalls.length;
    validateIntegrationConfig({
      GITHUB_INTEGRATION: "true",
      GITHUB_INTEGRATION_REPO: "kevinctofel/gitdatnote-integration-test",
      GITHUB_INTEGRATION_TOKEN: "not-a-real-secret",
    });
    expect(fetchCalls.length).toBe(callsBefore);
  });

  it("made zero network calls during the harness block", () => {
    // The fetch guard installed in the file-level beforeAll records every
    // call from this process. The harness/configuration validation must
    // be fully offline; the live suite's calls (if any) are excluded by
    // the block-start marker.
    expect(fetchCalls.slice(fetchCallsAtBlockStart[0])).toEqual([]);
  });
});

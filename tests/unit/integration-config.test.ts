/**
 * Deterministic offline tests for the integration-test configuration
 * contract (OpenSpec task 5.1).
 *
 * These tests verify SETUP CORRECTNESS only. They never require live
 * GitHub credentials, never contact GitHub, and never mutate repository
 * contents. (CLI-level disabled/fail-closed behavior is additionally
 * covered by the opt-in integration/harness.test.ts suite.)
 */
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

import {
  DEDICATED_REPO_PATTERN,
  isIntegrationEnabled,
  parseRepositoryId,
  validateIntegrationConfig,
} from "../../integration/config.js";
import { performAccessCheck } from "../../integration/setup.mjs";

/** Distinctive sentinel so "token never appears in output" is checkable. */
const SENTINEL_TOKEN = "UNIQUE-SENTINEL-TOKEN-DO-NOT-LEAK";

const validConfig = {
  GITHUB_INTEGRATION: "true",
  GITHUB_INTEGRATION_REPO: "kevinctofel/gitdatnote-integration-test",
  GITHUB_INTEGRATION_TOKEN: SENTINEL_TOKEN,
};

function withoutKey(env: Record<string, string>, key: string) {
  const copy = { ...env };
  delete copy[key];
  return copy;
}

function errorsFor(env: Record<string, string | undefined>): string[] {
  return validateIntegrationConfig(env).errors;
}

function expectInvalid(
  env: Record<string, string | undefined>,
  needle: string
): void {
  const result = validateIntegrationConfig(env);
  expect(result.ok).toBe(false);
  expect(result.errors.join("\n")).toContain(needle);
  // No error message may ever contain the sentinel token value.
  for (const error of result.errors) {
    expect(error).not.toContain(SENTINEL_TOKEN);
  }
}

describe("integration config: opt-in switch", () => {
  it("missing GITHUB_INTEGRATION fails closed (test 1)", () => {
    expectInvalid(withoutKey(validConfig, "GITHUB_INTEGRATION"), "GITHUB_INTEGRATION");
  });

  it("opt-in values other than the literal string 'true' fail closed (test 2)", () => {
    for (const value of ["TRUE", "True", "true ", " true", "1", "yes", "on", ""]) {
      expectInvalid({ ...validConfig, GITHUB_INTEGRATION: value }, "GITHUB_INTEGRATION");
    }
    expect(isIntegrationEnabled({ GITHUB_INTEGRATION: "true" })).toBe(true);
    expect(isIntegrationEnabled({ GITHUB_INTEGRATION: "TRUE" })).toBe(false);
    expect(isIntegrationEnabled({})).toBe(false);
  });
});

describe("integration config: repository", () => {
  it("missing repository fails closed (test 3)", () => {
    expectInvalid(withoutKey(validConfig, "GITHUB_INTEGRATION_REPO"), "GITHUB_INTEGRATION_REPO");
  });

  it("malformed OWNER/REPO values fail closed (test 5)", () => {
    for (const value of [
      "no-slash",
      "a/b/c",
      "owner/",
      "/repo",
      "owner /repo",
      "owner/repo ",
      "https://github.com/owner/repo",
      "owner/repo#frag",
      "owner name/repo",
    ]) {
      expect(parseRepositoryId(value)).toBeNull();
      expectInvalid({ ...validConfig, GITHUB_INTEGRATION_REPO: value }, "malformed");
    }
  });

  it("placeholder owner/repository values fail closed (test 6)", () => {
    for (const value of [
      "OWNER/REPO",
      "your-repo/test",
      "example/blog",
      "<owner>/<repo>",
      "your-org/MyRepo",
    ]) {
      expectInvalid(
        { ...validConfig, GITHUB_INTEGRATION_REPO: value },
        "placeholder"
      );
    }
  });

  it("the GitDatNote application source repository is rejected (test 7)", () => {
    for (const value of [
      "kevinctofel/GitDatNote",
      "KEVINCTOFEL/GITDATNOTE",
      "kevinctofel/gitdatnote",
    ]) {
      expectInvalid(
        { ...validConfig, GITHUB_INTEGRATION_REPO: value },
        "source repository"
      );
    }
  });

  it("SecondBrain is rejected case-insensitively (test 8)", () => {
    for (const value of [
      "kevinctofel/SecondBrain",
      "someone/SECONDbrain",
      "SecondBrain/vault",
    ]) {
      expectInvalid(
        { ...validConfig, GITHUB_INTEGRATION_REPO: value },
        "SecondBrain"
      );
    }
  });

  it("valid dedicated test-repository configurations pass (test 9)", () => {
    expect(validateIntegrationConfig(validConfig).ok).toBe(true);
    expect(
      validateIntegrationConfig({
        ...validConfig,
        GITHUB_INTEGRATION_REPO: "kevinctofel/gitdatnote-integration-test-run2",
      }).ok
    ).toBe(true);
    // The naming convention is matched case-insensitively.
    expect(
      validateIntegrationConfig({
        ...validConfig,
        GITHUB_INTEGRATION_REPO: "kevinctofel/GitDatNote-Integration-Test",
      }).ok
    ).toBe(true);
    expect(DEDICATED_REPO_PATTERN.test("gitdatnote-integration-test")).toBe(true);
    expect(DEDICATED_REPO_PATTERN.test("gitdatnote-integration")).toBe(false);
  });
});

describe("integration config: token handling", () => {
  it("missing token fails closed (test 4)", () => {
    expectInvalid(withoutKey(validConfig, "GITHUB_INTEGRATION_TOKEN"), "GITHUB_INTEGRATION_TOKEN");
  });

  it("placeholder and malformed tokens fail closed", () => {
    for (const value of ["<secret>", "your-token", "changeme", "a b", "   "]) {
      expectInvalid({ ...validConfig, GITHUB_INTEGRATION_TOKEN: value }, "GITHUB_INTEGRATION_TOKEN");
    }
  });

  it("the token value never appears in any error message (test 10)", () => {
    const cases: Record<string, string | undefined>[] = [
      withoutKey(validConfig, "GITHUB_INTEGRATION"),
      { ...validConfig, GITHUB_INTEGRATION: "TRUE" },
      withoutKey(validConfig, "GITHUB_INTEGRATION_REPO"),
      { ...validConfig, GITHUB_INTEGRATION_REPO: "bad repo" },
      { ...validConfig, GITHUB_INTEGRATION_REPO: "OWNER/REPO" },
      { ...validConfig, GITHUB_INTEGRATION_REPO: "kevinctofel/SecondBrain" },
      { ...validConfig, GITHUB_INTEGRATION_REPO: "kevinctofel/GitDatNote" },
      withoutKey(validConfig, "GITHUB_INTEGRATION_TOKEN"),
      { ...validConfig, GITHUB_INTEGRATION_TOKEN: "<secret>" },
      {},
    ];
    for (const env of cases) {
      const allErrors = errorsFor(env).join("\n");
      expect(allErrors).not.toContain(SENTINEL_TOKEN);
    }
  });

  it("any whitespace in the token fails closed (test 13)", () => {
    for (const value of [
      `${SENTINEL_TOKEN} `, // trailing space
      ` ${SENTINEL_TOKEN}`, // leading space
      `${SENTINEL_TOKEN}\t`, // trailing tab
      `\t${SENTINEL_TOKEN}`, // leading tab
      `${SENTINEL_TOKEN}\n`, // trailing newline
      `${SENTINEL_TOKEN}\r`, // trailing carriage return
      `${SENTINEL_TOKEN}\r\n`, // trailing CRLF
      ` ${SENTINEL_TOKEN}\t \n\r `, // leading space + mixed trailing whitespace
      "   ", // whitespace only — never trimmed into a credential
    ]) {
      expectInvalid(
        { ...validConfig, GITHUB_INTEGRATION_TOKEN: value },
        "malformed"
      );
    }
  });

  it("a valid, whitespace-free token passes (test 14)", () => {
    expect(validateIntegrationConfig(validConfig).ok).toBe(true);
    expect(
      validateIntegrationConfig({
        ...validConfig,
        GITHUB_INTEGRATION_TOKEN: "ghp_0123456789abcdef0123456789abcdef012345",
      }).ok
    ).toBe(true);
  });
});

describe("integration config: suite isolation (tests 11, 12)", () => {
  it("the normal unit suite config never includes integration tests (test 11)", () => {
    const rootConfig = readFileSync(
      path.join(__dirname, "..", "..", "vitest.config.ts"),
      "utf8"
    );
    // The root include set is unchanged and does not cover integration/**.
    for (const glob of [
      "tests/characterization/**/*.test.js",
      "tests/unit/**/*.test.ts",
      "tests/web/**/*.test.ts",
      "tests/web/**/*.test.tsx",
    ]) {
      expect(rootConfig).toContain(`'${glob}'`);
    }
    expect(rootConfig).not.toContain("integration/");

    const integrationConfig = readFileSync(
      path.join(__dirname, "..", "..", "integration", "vitest.config.ts"),
      "utf8"
    );
    expect(integrationConfig).toContain('"integration/**/*.test.ts"');
  });

  it("the disabled CLI path exits 0 and makes no GitHub network calls (test 12)", async () => {
    const fetchCalls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      fetchCalls.push(String(args[0]));
      return realFetch(...args);
    }) as typeof fetch;
    try {
      const env: Record<string, string> = {};
      for (const key of Object.keys(process.env)) {
        if (!key.startsWith("GITHUB_INTEGRATION")) env[key] = process.env[key]!;
      }
      const { stdout } = await execFileAsync(
        process.execPath,
        [path.join("integration", "run.mjs")],
        { cwd: process.cwd(), env, encoding: "utf8", timeout: 30_000 }
      );
      expect(stdout).toContain("Integration tests are DISABLED.");
      expect(stdout).not.toMatch(/Test Files/);
      expect(stdout).not.toMatch(/passed/i);
      // No network calls from this process during the disabled run.
      expect(fetchCalls).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 30_000);
});

function captureStream(): {
  stream: { write(chunk: string): boolean };
  text: () => string;
} {
  let data = "";
  return {
    stream: {
      write: (chunk: string) => {
        data += chunk;
        return true;
      },
    },
    text: () => data,
  };
}

interface FakeResponseOptions {
  ok?: boolean;
  status: number;
  body?: Record<string, unknown>;
  rateLimitRemaining?: string | null;
}

function fakeResponse(options: FakeResponseOptions) {
  return {
    ok: options.ok ?? (options.status >= 200 && options.status < 300),
    status: options.status,
    headers: {
      get: (name: string) =>
        name === "x-ratelimit-remaining"
          ? options.rateLimitRemaining ?? null
          : null,
    },
    json: async () => options.body ?? {},
  };
}

describe("setup.mjs performAccessCheck (credential-safe diagnostics, offline)", () => {
  it("fixed diagnostics per HTTP status; remote body text is never forwarded", async () => {
    const cases: { status: number; needle: string }[] = [
      { status: 401, needle: "Authentication failed (HTTP 401)" },
      { status: 403, needle: "Access denied (HTTP 403)" },
      { status: 404, needle: "Repository not found (HTTP 404)" },
      { status: 429, needle: "Rate limit exceeded" },
      { status: 500, needle: "HTTP 500" },
    ];
    for (const { status, needle } of cases) {
      let requests = 0;
      const fetchImpl = async () => {
        requests += 1;
        return fakeResponse({
          status,
          body: { message: `remote-body-leak ${SENTINEL_TOKEN}` },
        });
      };
      const out = captureStream();
      const err = captureStream();
      const code = await performAccessCheck({
        env: { ...validConfig },
        fetchImpl,
        out: out.stream,
        err: err.stream,
      });
      const combined = `${out.text()}${err.text()}`;
      expect(code).toBe(1);
      expect(requests).toBe(1);
      expect(combined).toContain(needle);
      expect(combined).not.toContain(SENTINEL_TOKEN);
      expect(combined).not.toContain("remote-body-leak");
    }
  });

  it("403 with zero remaining rate-limit quota is diagnosed as rate limiting", async () => {
    const fetchImpl = async () =>
      fakeResponse({
        status: 403,
        rateLimitRemaining: "0",
        body: { message: `rate-limit ${SENTINEL_TOKEN}` },
      });
    const out = captureStream();
    const err = captureStream();
    const code = await performAccessCheck({
      env: { ...validConfig },
      fetchImpl,
      out: out.stream,
      err: err.stream,
    });
    expect(code).toBe(1);
    expect(`${out.text()}${err.text()}`).toContain("Rate limit exceeded");
  });

  it("network exception text is replaced by a fixed diagnostic (sentinel never forwarded)", async () => {
    const fetchImpl = async () => {
      throw new Error(`network down ${SENTINEL_TOKEN} exception-leak`);
    };
    const out = captureStream();
    const err = captureStream();
    const code = await performAccessCheck({
      env: { ...validConfig },
      fetchImpl,
      out: out.stream,
      err: err.stream,
    });
    const combined = `${out.text()}${err.text()}`;
    expect(code).toBe(1);
    expect(combined).toContain("Network request failed");
    expect(combined).not.toContain(SENTINEL_TOKEN);
    expect(combined).not.toContain("exception-leak");
  });

  it("invalid configuration fails before any request is made", async () => {
    let requests = 0;
    const fetchImpl = async () => {
      requests += 1;
      return fakeResponse({ status: 200, body: {} });
    };
    const out = captureStream();
    const err = captureStream();
    const code = await performAccessCheck({
      env: {
        ...validConfig,
        GITHUB_INTEGRATION_REPO: "kevinctofel/SecondBrain",
      },
      fetchImpl,
      out: out.stream,
      err: err.stream,
    });
    expect(code).toBe(1);
    expect(requests).toBe(0);
    expect(`${out.text()}${err.text()}`).toContain("SecondBrain");
  });

  it("success: token appears only in the Authorization header, never in output", async () => {
    let seenAuthorization: unknown;
    const fetchImpl = async (_url: unknown, init?: unknown) => {
      const headers = (
        init as { headers?: Record<string, string> } | undefined
      )?.headers;
      seenAuthorization = headers?.Authorization;
      return fakeResponse({
        status: 200,
        body: {
          full_name: "kevinctofel/gitdatnote-integration-test",
          private: true,
          default_branch: "main",
        },
      });
    };
    const out = captureStream();
    const err = captureStream();
    const code = await performAccessCheck({
      env: { ...validConfig },
      fetchImpl,
      out: out.stream,
      err: err.stream,
    });
    expect(code).toBe(0);
    expect(seenAuthorization).toBe(`Bearer ${SENTINEL_TOKEN}`);
    const combined = `${out.text()}${err.text()}`;
    expect(combined).not.toContain(SENTINEL_TOKEN);
    expect(combined).toContain(
      "full_name       = kevinctofel/gitdatnote-integration-test"
    );
    expect(combined).toContain(
      "reachability does NOT prove Contents write permission"
    );
  });

  it("a response whose full_name is not the configured repository fails closed", async () => {
    // The hardened path treats a non-string (or foreign) full_name as
    // "the intended repository could not be confirmed" and fails closed
    // instead of printing fallback values.
    const fetchImpl = async () =>
      fakeResponse({
        status: 200,
        body: { full_name: 42, private: "yes", default_branch: ["main"] },
      });
    const out = captureStream();
    const err = captureStream();
    const code = await performAccessCheck({
      env: { ...validConfig },
      fetchImpl,
      out: out.stream,
      err: err.stream,
    });
    expect(code).toBe(1);
    const combined = `${out.text()}${err.text()}`;
    expect(combined).toContain("does not identify the configured repository");
    expect(combined).not.toContain(SENTINEL_TOKEN);
    expect(combined).not.toContain("(unavailable)");
  });

  it("malformed JSON in an HTTP 200 response fails closed with a fixed diagnostic", async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new Error(`SyntaxError: ${SENTINEL_TOKEN} is not valid JSON`);
      },
    });
    const out = captureStream();
    const err = captureStream();
    const code = await performAccessCheck({
      env: { ...validConfig },
      fetchImpl,
      out: out.stream,
      err: err.stream,
    });
    expect(code).toBe(1);
    const combined = `${out.text()}${err.text()}`;
    expect(combined).toContain("unexpected response format");
    expect(combined).not.toContain(SENTINEL_TOKEN);
    expect(combined).not.toContain("SyntaxError");
  });

  it("a non-object HTTP 200 body is never forwarded", async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => `just a string containing ${SENTINEL_TOKEN}`,
    });
    const out = captureStream();
    const err = captureStream();
    const code = await performAccessCheck({
      env: { ...validConfig },
      fetchImpl,
      out: out.stream,
      err: err.stream,
    });
    expect(code).toBe(1);
    const combined = `${out.text()}${err.text()}`;
    expect(combined).toContain("unexpected response format");
    expect(combined).not.toContain(SENTINEL_TOKEN);
  });

  it("a mismatched full_name fails closed and the foreign value is never printed", async () => {
    const foreignRepo = `someone-else/foreign-repo-${SENTINEL_TOKEN}`;
    const fetchImpl = async () =>
      fakeResponse({
        status: 200,
        body: {
          full_name: foreignRepo,
          private: true,
          default_branch: "main",
        },
      });
    const out = captureStream();
    const err = captureStream();
    const code = await performAccessCheck({
      env: { ...validConfig },
      fetchImpl,
      out: out.stream,
      err: err.stream,
    });
    expect(code).toBe(1);
    const combined = `${out.text()}${err.text()}`;
    expect(combined).toContain("does not identify the configured repository");
    expect(combined).not.toContain(foreignRepo);
    expect(combined).not.toContain(SENTINEL_TOKEN);
    expect(combined).not.toContain("lookup succeeded");
  });

  it("a case-insensitive full_name match is accepted as the configured repository", async () => {
    const fetchImpl = async () =>
      fakeResponse({
        status: 200,
        body: {
          full_name: "KEVINCTOFEL/GitDatNote-Integration-Test",
          private: true,
          default_branch: "main",
        },
      });
    const out = captureStream();
    const err = captureStream();
    const code = await performAccessCheck({
      env: { ...validConfig },
      fetchImpl,
      out: out.stream,
      err: err.stream,
    });
    expect(code).toBe(0);
    const combined = `${out.text()}${err.text()}`;
    expect(combined).toContain(
      "full_name       = KEVINCTOFEL/GitDatNote-Integration-Test"
    );
    expect(combined).toContain("private         = true");
    expect(combined).toContain("default_branch  = main");
    expect(combined).toContain(
      "reachability does NOT prove Contents write permission"
    );
  });

  it("sentinel credentials and control characters in fields never reach output", async () => {
    const fetchImpl = async () =>
      fakeResponse({
        status: 200,
        body: {
          full_name: "kevinctofel/gitdatnote-integration-test",
          private: SENTINEL_TOKEN,
          default_branch: `main\r\n${SENTINEL_TOKEN}`,
        },
      });
    const out = captureStream();
    const err = captureStream();
    const code = await performAccessCheck({
      env: { ...validConfig },
      fetchImpl,
      out: out.stream,
      err: err.stream,
    });
    expect(code).toBe(0);
    const combined = `${out.text()}${err.text()}`;
    expect(combined).not.toContain(SENTINEL_TOKEN);
    expect(combined).toContain("private         = (unavailable)");
    expect(combined).toContain("default_branch  = (unavailable)");
  });
});

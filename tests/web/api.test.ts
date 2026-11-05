import { describe, it, expect, vi } from "vitest";
import { ApiClient, ApiError } from "../../src/web/api";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ApiClient", () => {
  it("parses a 200 session as connected", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        json(200, { connected: true, user: { login: "octocat" }, csrfToken: "t" }),
      );
    const client = new ApiClient(fetch);
    const outcome = await client.getSession();
    expect(outcome.state.connected).toBe(true);
    expect(outcome.state.user?.login).toBe("octocat");
    expect(outcome.error).toBeUndefined();
  });

  it("treats a 404 session endpoint as not connected (not an error)", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        json(404, {
          error: { code: "FILE_NOT_FOUND", message: "Not found", retryable: false, status: 404 },
        }),
      );
    const client = new ApiClient(fetch);
    const outcome = await client.getSession();
    expect(outcome.state.connected).toBe(false);
    expect(outcome.error).toBeUndefined();
  });

  it("treats a 401 session as not connected", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        json(401, {
          error: { code: "UNAUTHORIZED", message: "Unauthorized", retryable: false, status: 401 },
        }),
      );
    const client = new ApiClient(fetch);
    const outcome = await client.getSession();
    expect(outcome.state.connected).toBe(false);
    expect(outcome.error).toBeUndefined();
  });

  it("reports a session server error as an error detail", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        json(502, {
          error: { code: "GITHUB_UNAVAILABLE", message: "Downstream failed", retryable: true, status: 502 },
        }),
      );
    const client = new ApiClient(fetch);
    const outcome = await client.getSession();
    expect(outcome.state.connected).toBe(false);
    expect(outcome.error?.code).toBe("GITHUB_UNAVAILABLE");
    expect(outcome.error?.retryable).toBe(true);
  });

  it("maps a non-2xx content error to the shared contract", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        json(404, {
          error: { code: "FILE_NOT_FOUND", message: "No such file", retryable: false, status: 404 },
        }),
      );
    const client = new ApiClient(fetch);
    await expect(client.readContent("o", "r", "a.md")).rejects.toBeInstanceOf(ApiError);
    await expect(client.readContent("o", "r", "a.md")).rejects.toMatchObject({
      detail: { code: "FILE_NOT_FOUND" },
    });
  });

  it("maps a network failure to GITHUB_UNAVAILABLE (retryable)", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const client = new ApiClient(fetch);
    await expect(client.listRepositories()).rejects.toMatchObject({
      detail: { code: "GITHUB_UNAVAILABLE", retryable: true, status: 502 },
    });
  });

  it("maps a 5xx with a non-contract body to GITHUB_UNAVAILABLE", async () => {
    const fetch = vi.fn().mockResolvedValue(json(502, { notAnError: true }));
    const client = new ApiClient(fetch);
    await expect(client.listRepositories()).rejects.toMatchObject({
      detail: { code: "GITHUB_UNAVAILABLE", status: 502 },
    });
  });

  it("connectGithub: 404 → labeled unavailable placeholder", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(json(404, { error: { code: "FILE_NOT_FOUND", message: "nope", retryable: false, status: 404 } }));
    const client = new ApiClient(fetch);
    const result = await client.connectGithub();
    expect(result).toEqual({ kind: "unavailable" });
  });

  it("connectGithub: 302 → redirect", async () => {
    const fetch = vi.fn().mockResolvedValue(json(302, {}));
    const client = new ApiClient(fetch);
    const result = await client.connectGithub();
    expect(result).toEqual({ kind: "redirect" });
  });

  it("connectGithub: network failure → retryable error", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const client = new ApiClient(fetch);
    const result = await client.connectGithub();
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.detail.code).toBe("GITHUB_UNAVAILABLE");
      expect(result.detail.retryable).toBe(true);
    }
  });

  // ---- Hardening: malformed 2xx responses become a safe error ----

  it("treats an unparseable 2xx session body as a retryable connection error", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response("{ not valid json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const outcome = await new ApiClient(fetch).getSession();
    expect(outcome.state.connected).toBe(false);
    expect(outcome.error?.code).toBe("INTERNAL_ERROR");
    expect(outcome.error?.retryable).toBe(true);
    expect(outcome.error?.status).toBe(500);
  });

  it("treats a wrong-shape 2xx session body as a retryable connection error", async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, { connected: "yes" }));
    const outcome = await new ApiClient(fetch).getSession();
    expect(outcome.state.connected).toBe(false);
    expect(outcome.error?.code).toBe("INTERNAL_ERROR");
    expect(outcome.error?.retryable).toBe(true);
  });

  it("rejects a malformed 2xx repository-list body with a safe error", async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, { notAnArray: true }));
    const client = new ApiClient(fetch);
    await expect(client.listRepositories()).rejects.toMatchObject({
      detail: { code: "INTERNAL_ERROR", retryable: true, status: 500 },
    });
  });

  it("rejects a malformed 2xx content body with a safe error", async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, { type: "file" }));
    const client = new ApiClient(fetch);
    await expect(
      client.readContent("octocat", "hello", "README.md"),
    ).rejects.toMatchObject({
      detail: { code: "INTERNAL_ERROR", retryable: true, status: 500 },
    });
  });

  it("distinguishes a transport failure on the session probe from a signed-out 401", async () => {
    // Transport failure (no response) → retryable connection error.
    const failingFetch = vi.fn().mockRejectedValue(new TypeError("network down"));
    const failing = await new ApiClient(failingFetch).getSession();
    expect(failing.state.connected).toBe(false);
    expect(failing.error?.code).toBe("GITHUB_UNAVAILABLE");
    expect(failing.error?.retryable).toBe(true);

    // Signed-out 401 → plain "not connected", no error detail.
    const authFetch = vi
      .fn()
      .mockResolvedValue(
        json(401, {
          error: {
            code: "UNAUTHORIZED",
            message: "Unauthorized",
            retryable: false,
            status: 401,
          },
        }),
      );
    const signedOut = await new ApiClient(authFetch).getSession();
    expect(signedOut.state.connected).toBe(false);
    expect(signedOut.error).toBeUndefined();
  });
});

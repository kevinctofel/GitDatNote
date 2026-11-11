// @vitest-environment happy-dom
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

  it("connectGithub: exactly one top-level navigation, no fetch probe", () => {
    const fetch = vi.fn();
    const client = new ApiClient(fetch);
    const assign = vi.spyOn(window.location, "assign");
    client.connectGithub();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/api/auth/github/start");
    expect(fetch).not.toHaveBeenCalled();
    assign.mockRestore();
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

  // ---- Hardening: connected sessions require a valid user identity ----

  it("requires a valid user identity for a connected session", async () => {
    // connected: true but no user -> inconsistent -> rejected as an error.
    const fetch = vi.fn().mockResolvedValue(json(200, { connected: true }));
    const outcome = await new ApiClient(fetch).getSession();
    expect(outcome.state.connected).toBe(false);
    expect(outcome.error?.code).toBe("INTERNAL_ERROR");
    expect(outcome.error?.retryable).toBe(true);
  });

  it("rejects a disconnected session that carries a user identity", async () => {
    // connected: false but a user present -> inconsistent -> rejected.
    const fetch = vi
      .fn()
      .mockResolvedValue(
        json(200, { connected: false, user: { login: "ghost" } }),
      );
    const outcome = await new ApiClient(fetch).getSession();
    expect(outcome.state.connected).toBe(false);
    expect(outcome.error?.code).toBe("INTERNAL_ERROR");
  });

  it("accepts a connected session with a valid user and no CSRF token", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(json(200, { connected: true, user: { login: "octocat" } }));
    const outcome = await new ApiClient(fetch).getSession();
    expect(outcome.state.connected).toBe(true);
    expect(outcome.state.user?.login).toBe("octocat");
    expect(outcome.error).toBeUndefined();
  });
});

// ---- Task 3.6: disconnectGithub via POST /api/auth/logout ----

/** Server-issued CSRF token shape: 32 random bytes, hex-encoded (64 chars). */
const CSRF_TOKEN = "ab".repeat(32);

describe("ApiClient.disconnectGithub (task 3.6)", () => {
  it("POSTs to /api/auth/logout with the token only in the X-CSRF-Token header", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new ApiClient(fetch);

    // A 204 with no body is success.
    await expect(client.disconnectGithub(CSRF_TOKEN)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    // No query string, no path parameters: the cookie is the session carrier.
    expect(url).toBe("/api/auth/logout");
    expect(init?.method).toBe("POST");
    // The token lives exclusively in the CSRF header — never in a body.
    expect(init?.headers).toEqual({ "X-CSRF-Token": CSRF_TOKEN });
    expect(init?.body).toBeUndefined();
  });

  it("rejects an empty token without sending any unprotected request", async () => {
    const fetch = vi.fn();
    const client = new ApiClient(fetch);
    await expect(client.disconnectGithub("")).rejects.toMatchObject({
      detail: { code: "CSRF_INVALID", status: 403, retryable: false },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed tokens (wrong length / non-hex) before any request", async () => {
    const fetch = vi.fn();
    const client = new ApiClient(fetch);
    await expect(
      client.disconnectGithub(CSRF_TOKEN.slice(0, 63)), // 63 chars
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      client.disconnectGithub("z".repeat(64)), // non-hex
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps a 401 logout (session gone) to UNAUTHORIZED", async () => {
    const fetch = vi.fn().mockResolvedValue(
      json(401, {
        error: {
          code: "UNAUTHORIZED",
          message: "Unauthorized",
          retryable: false,
          status: 401,
        },
      }),
    );
    const client = new ApiClient(fetch);
    await expect(client.disconnectGithub(CSRF_TOKEN)).rejects.toMatchObject({
      detail: { code: "UNAUTHORIZED", status: 401 },
    });
  });

  it("maps a 403 envelope to the shared contract", async () => {
    const fetch = vi.fn().mockResolvedValue(
      json(403, {
        error: {
          code: "CSRF_INVALID",
          message:
            "This request was rejected for security reasons. Please try again.",
          retryable: false,
          status: 403,
        },
      }),
    );
    const client = new ApiClient(fetch);
    await expect(client.disconnectGithub(CSRF_TOKEN)).rejects.toMatchObject({
      detail: {
        code: "CSRF_INVALID",
        status: 403,
        retryable: false,
      },
    });
  });

  it("maps a bare 403 CSRF-boundary body (no envelope) to the shared contract", async () => {
    const fetch = vi.fn().mockResolvedValue(
      json(403, {
        code: "CSRF_INVALID",
        message:
          "This request was rejected for security reasons. Please try again.",
        retryable: false,
        status: 403,
      }),
    );
    const client = new ApiClient(fetch);
    await expect(client.disconnectGithub(CSRF_TOKEN)).rejects.toMatchObject({
      detail: {
        code: "CSRF_INVALID",
        status: 403,
        retryable: false,
      },
    });
  });

  it("maps 429 to a retryable RATE_LIMITED error", async () => {
    const fetch = vi.fn().mockResolvedValue(
      json(429, {
        error: {
          code: "RATE_LIMITED",
          message:
            "The GitHub API rate limit was reached. Please try again shortly.",
          retryable: true,
          status: 429,
        },
      }),
    );
    const client = new ApiClient(fetch);
    await expect(client.disconnectGithub(CSRF_TOKEN)).rejects.toMatchObject({
      detail: { code: "RATE_LIMITED", status: 429, retryable: true },
    });
  });

  it("maps 500 to INTERNAL_ERROR and a non-contract 502 body to GITHUB_UNAVAILABLE", async () => {
    const fetch500 = vi.fn().mockResolvedValue(
      json(500, {
        error: {
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred.",
          retryable: false,
          status: 500,
        },
      }),
    );
    await expect(
      new ApiClient(fetch500).disconnectGithub(CSRF_TOKEN),
    ).rejects.toMatchObject({
      detail: { code: "INTERNAL_ERROR", status: 500 },
    });

    const fetch502 = vi.fn().mockResolvedValue(json(502, { notAnError: true }));
    await expect(
      new ApiClient(fetch502).disconnectGithub(CSRF_TOKEN),
    ).rejects.toMatchObject({
      detail: { code: "GITHUB_UNAVAILABLE", status: 502, retryable: true },
    });
  });

  it("maps a network failure to a retryable GITHUB_UNAVAILABLE error", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const client = new ApiClient(fetch);
    await expect(client.disconnectGithub(CSRF_TOKEN)).rejects.toMatchObject({
      detail: { code: "GITHUB_UNAVAILABLE", status: 502, retryable: true },
    });
  });

  it("maps a non-JSON 403 body via the conservative status mapping", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response("<html>forbidden</html>", {
        status: 403,
        headers: { "Content-Type": "text/html" },
      }),
    );
    const client = new ApiClient(fetch);
    await expect(client.disconnectGithub(CSRF_TOKEN)).rejects.toMatchObject({
      detail: { code: "REPO_NOT_ALLOWED", status: 403 },
    });
  });
});

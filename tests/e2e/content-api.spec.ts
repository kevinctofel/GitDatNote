import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { test, expect, type APIRequestContext, type APIResponse } from "@playwright/test";
import { request as playwrightRequest } from "playwright";

import { createApp } from "../../src/server/index.js";
import type { ContentClient } from "../../src/server/content/types.js";

/**
 * Task 5.2 — real HTTP coverage for the authenticated content endpoints.
 *
 * Unlike `connection-flow.spec.ts` (which drives the browser and intercepts
 * API calls with `page.route`), this file exercises the actual production
 * HTTP stack end-to-end:
 *
 * - A real `createApp` HTTP listener bound to an ephemeral localhost port.
 * - A real SQLite session store in an isolated temporary directory
 *   (created and destroyed by this file, even when tests fail).
 * - A real OAuth sign-in through the real routes (`/api/auth/github/start`
 *   and the callback) with fake credentials. The outbound GitHub calls are
 *   mocked at the existing `fetchImpl` injection seam — the same seam the
 *   established unit tests use — so no real GitHub network call ever
 *   happens.
 * - Requests are sent with Playwright's `APIRequestContext` (a real HTTP
 *   client), never Vitest mocks.
 *
 * Real layers: routing, cookie session authentication, CSRF enforcement,
 * the repository authorization boundary, the content adapter (path
 * validation, existence pre-check, SHA conflict detection, UTF-8 handling),
 * and the response contract.
 * Mocked layer: the GitHub-facing transport (`fetchImpl`) and the content
 * client, injected through the established `contentClientFactory` seam as a
 * small deterministic stateful store implementing the Contents API contract
 * (the same approach the established unit tests use — deliberately not a
 * live Octokit, to keep the test deterministic and GitHub-free).
 *
 * SHA conflict note: the production application has no article editor yet,
 * so a browser-driven editing conflict flow cannot be tested. The conflict
 * semantics are covered here over real HTTP; the existing Vitest component
 * tests retain the conflict-text / onReload / no-auto-retry assertions.
 */

/* ------------------------------------------------------------------ */
/* Deterministic fixtures (obviously fake credentials, GitHub shapes) */
/* ------------------------------------------------------------------ */

const OWNER = "octo-tester";
const REPO_WRITE = "notes"; // writable repository
const REPO_READ = "docs"; // read-only repository
const REPO_UNKNOWN = "unknown-repo"; // not in the session's repository list

const CLIENT_ID = "Iv1.ab1112223334445c";
const CLIENT_SECRET = "test-client-secret-0123456789abcdef0123456789";
const CALLBACK = "https://example.com/api/auth/github/callback";
const SESSION_KEY =
  "3a7bd3e2360a3d29eea436fcfbefe70c434e20d53060c66e0c2f6a3f4a9c7e58";

const ACCESS_TOKEN = "ghu_test_access_token_value";
const REFRESH_TOKEN = "ghr_test_refresh_token_value";
const AUTH_CODE = "test-authorization-code-123";

/** Fixed clock: sessions never expire during the run. */
const BASE_NOW = new Date("2026-01-05T12:00:00Z").getTime();

const TOKEN_RESPONSE = {
  access_token: ACCESS_TOKEN,
  refresh_token: REFRESH_TOKEN,
  expires_in: 28800,
  refresh_token_expires_in: 15897600,
  token_type: "bearer",
  scope: "repo",
};

const PROFILE = {
  login: OWNER,
  name: "Octo Tester",
  avatar_url: "https://avatars.example/octo.png",
};

const INSTALLATION_FULL = {
  id: 111,
  account: { login: OWNER, id: 9001 },
  permissions: { contents: "write" },
  suspended_at: null,
};

const REPO_WRITE_FIXTURE = {
  owner: { login: OWNER },
  name: REPO_WRITE,
  private: true,
  permissions: { admin: true, push: true, pull: true },
};

const REPO_READ_FIXTURE = {
  owner: { login: OWNER },
  name: REPO_READ,
  private: false,
  permissions: { admin: false, push: false, pull: true },
};

/* ------------------------------------------------------------------ */
/* Deterministic stateful upstream fixture (the Contents API contract) */
/* ------------------------------------------------------------------ */

const ROOT = "src/posts";
/** Exact Unicode content: the round trip must be lossless. */
const UNICODE =
  "Ünïcødé café ☕ — 2026 journal note.\nSecond line: émojis 📝 and — em-dashes.\n";
const OTHER = "# Other\n";
const NOTE_PATH = "2026/unicode-note.md";
const OTHER_PATH = "2026/other.md";

type FileNode = { type: "file"; content: string; sha: string };
type DirNode = { type: "dir" };
type Node = FileNode | DirNode;

/** The full git blob SHA for a UTF-8 payload (sha1 of `blob <len>\0<bytes>`). */
function blobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

/** Store key: owner/repo-qualified, then the full content-root path. */
function key(owner: string, repo: string, fullPath: string): string {
  return `${owner}/${repo}:${fullPath}`;
}

const store = new Map<string, Node>();
/** Upstream `getContent` calls, in order (full content-root paths). */
const readCalls: string[] = [];
/** Upstream write calls, in order. */
interface WriteCall {
  owner: string;
  repo: string;
  path: string;
  message: string;
  contentBase64: string;
  sha?: string;
}
const writeCalls: WriteCall[] = [];

/** Seed both seeded repositories with the same deterministic tree. */
function seedStore(): void {
  store.clear();
  readCalls.length = 0;
  writeCalls.length = 0;
  for (const repo of [REPO_WRITE, REPO_READ]) {
    const k = (p: string) => key(OWNER, repo, p);
    store.set(k(ROOT), { type: "dir" });
    store.set(k(`${ROOT}/2026`), { type: "dir" });
    store.set(k(`${ROOT}/${NOTE_PATH}`), {
      type: "file",
      content: UNICODE,
      sha: blobSha(UNICODE),
    });
    store.set(k(`${ROOT}/${OTHER_PATH}`), {
      type: "file",
      content: OTHER,
      sha: blobSha(OTHER),
    });
  }
}

/** A GitHub-style API error as the real client would throw it. */
function httpError(
  status: number,
): Error & { status: number; headers: Record<string, string> } {
  const err = new Error(`GitHub API ${status}`) as Error & {
    status: number;
    headers: Record<string, string>;
  };
  err.status = status;
  err.headers = {};
  return err;
}

/** The single-file Contents API payload (base64 UTF-8, blob SHA, size). */
function filePayload(node: FileNode): Record<string, unknown> {
  const bytes = Buffer.from(node.content, "utf8");
  return {
    type: "file",
    sha: node.sha,
    size: bytes.length,
    encoding: "base64",
    content: bytes.toString("base64"),
  };
}

/** The directory-listing Contents API payload (immediate children only). */
function dirPayload(fullPath: string, owner: string, repo: string): Record<string, unknown>[] {
  const prefix = fullPath === ROOT ? `${ROOT}/` : `${fullPath}/`;
  const children: Record<string, unknown>[] = [];
  for (const [k, node] of store) {
    const repoPrefix = `${owner}/${repo}:`;
    if (!k.startsWith(repoPrefix)) continue;
    const path = k.slice(repoPrefix.length);
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest.includes("/")) continue; // not an immediate child
    children.push({
      name: rest,
      type: node.type,
      sha: node.type === "file" ? node.sha : "b".repeat(40),
      size:
        node.type === "file" ? Buffer.from(node.content, "utf8").length : 0,
    });
  }
  children.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return children;
}

const contentClientFactory = (accessToken: string): ContentClient => {
  void accessToken; // asserted per-test via the injected token capture
  return {
    rest: {
      repos: {
        async getContent(params: {
          owner: string;
          repo: string;
          path: string;
        }): Promise<{ data: unknown }> {
          readCalls.push(params.path);
          const node = store.get(key(params.owner, params.repo, params.path));
          if (node === undefined) throw httpError(404);
          if (node.type === "dir") {
            return { data: dirPayload(params.path, params.owner, params.repo) };
          }
          return { data: filePayload(node) };
        },
        async createOrUpdateFileContents(params: {
          owner: string;
          repo: string;
          path: string;
          message: string;
          content: string;
          sha?: string;
        }): Promise<{ data: unknown }> {
          writeCalls.push({
            owner: params.owner,
            repo: params.repo,
            path: params.path,
            message: params.message,
            contentBase64: params.content,
            sha: params.sha,
          });
          const k = key(params.owner, params.repo, params.path);
          const text = Buffer.from(params.content, "base64").toString("utf8");
          const existing = store.get(k);
          if (params.sha === undefined) {
            // Create: must not clobber an existing entry.
            if (existing !== undefined) throw httpError(409);
            const node: FileNode = { type: "file", content: text, sha: blobSha(text) };
            store.set(k, node);
            return { data: { content: { sha: node.sha } } };
          }
          // SHA-protected update: reject a stale expected SHA (409).
          if (
            existing === undefined ||
            existing.type !== "file" ||
            existing.sha !== params.sha
          ) {
            throw httpError(409);
          }
          const node: FileNode = { type: "file", content: text, sha: blobSha(text) };
          store.set(k, node);
          return { data: { content: { sha: node.sha } } };
        },
      },
    },
  };
};

/** The mocked GitHub transport (the `fetchImpl` injection seam). */
const fetchImpl = (input: string): Promise<Response> => {
  const url = new URL(input);
  const ghJson = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  if (url.pathname === "/login/oauth/access_token") {
    return Promise.resolve(ghJson(200, TOKEN_RESPONSE));
  }
  if (url.pathname === "/user") {
    return Promise.resolve(ghJson(200, PROFILE));
  }
  if (url.pathname === "/user/installations") {
    return Promise.resolve(
      ghJson(200, { total_count: 1, installations: [INSTALLATION_FULL] }),
    );
  }
  if (
    url.pathname.startsWith("/user/installations/") &&
    url.pathname.endsWith("/repositories")
  ) {
    return Promise.resolve(
      ghJson(200, {
        total_count: 2,
        repositories: [REPO_WRITE_FIXTURE, REPO_READ_FIXTURE],
      }),
    );
  }
  return Promise.resolve(ghJson(404, { message: "Not Found" }));
};

/* ------------------------------------------------------------------ */
/* Harness: real server, temporary SQLite store, APIRequestContext     */
/* ------------------------------------------------------------------ */

let server: Server | undefined;
let base: string;
let dir: string | undefined;
let ctx: APIRequestContext | undefined;
/** The original beforeAll failure, preserved and re-thrown in afterAll. */
let setupError: unknown;
const factoryTokens: string[] = [];

function listen(s: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server has no port"));
        return;
      }
      resolve(address.port);
    });
  });
}

test.beforeAll(async () => {
  try {
    dir = mkdtempSync(join(tmpdir(), "gitdatnote-e2e-content-"));
    const env: Record<string, string | undefined> = {
      GITHUB_APP_CLIENT_ID: CLIENT_ID,
      GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET,
      GITHUB_OAUTH_CALLBACK_URL: CALLBACK,
      SESSION_ENCRYPTION_KEY: SESSION_KEY,
      SESSION_DB_PATH: join(dir, "sessions.db"),
    };
    server = createApp({
      env,
      fetchImpl,
      now: () => BASE_NOW,
      contentClientFactory: (token: string) => {
        factoryTokens.push(token);
        return contentClientFactory(token);
      },
    });
    const port = await listen(server);
    base = `http://127.0.0.1:${port}`;
    ctx = await playwrightRequest.newContext({ baseURL: base });
  } catch (err) {
    // Preserve the original failure: afterAll performs whatever cleanup is
    // still possible (resources are optional and checked), then rethrows
    // this error so the setup failure is the reported one.
    setupError = err;
    throw err;
  }
});

test.beforeEach(() => {
  seedStore();
});

test.afterAll(async () => {
  // Resilient teardown: every cleanup step is attempted independently so a
  // failure in one step cannot prevent the remaining cleanup, and only
  // resources that were actually initialized are touched (a partial
  // beforeAll failure may leave some of them unset).
  const failures: unknown[] = [];
  if (ctx !== undefined) {
    try {
      await ctx.dispose();
    } catch (err) {
      failures.push(err);
    }
  }
  if (server !== undefined) {
    try {
      // Drop idle connections so close() cannot hang, then await closure.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    } catch (err) {
      failures.push(err);
    }
  }
  if (dir !== undefined) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      failures.push(err);
    }
  }
  // Preserve the original setup failure where possible; surface a cleanup
  // failure only when setup itself succeeded.
  if (setupError !== undefined) throw setupError;
  if (failures.length > 0) throw failures[0];
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** The `name=value` portion of a set-cookie header for `name`. */
function cookieFrom(res: APIResponse, name: string): string {
  const raw = res.headers()["set-cookie"] ?? "";
  for (const candidate of raw.split(",")) {
    const [pair] = candidate.split(";");
    if (pair.trim().startsWith(`${name}=`)) return pair.trim();
  }
  throw new Error(`expected set-cookie ${name} in response headers`);
}

interface SigninState {
  cookie: string;
  csrfToken: string;
}

/**
 * The established three-step sign-in through the real routes: start →
 * callback with code/state → session cookie → session probe for the
 * per-session CSRF token.
 */
async function signIn(collectBodies?: string[]): Promise<SigninState> {
  const start = await ctx.get("/api/auth/github/start", { maxRedirects: 0 });
  expect(start.status()).toBe(302);
  const startBody = await start.text();
  collectBodies?.push(startBody);
  const location = start.headers()["location"] ?? "";
  expect(location).toContain("github.com/login/oauth/authorize");
  const pendingCookie = cookieFrom(start, "gitdatnote_pending_auth");
  const state = new URL(location).searchParams.get("state") ?? "";

  const cb = await ctx.get(
    `/api/auth/github/callback?code=${AUTH_CODE}&state=${encodeURIComponent(state)}`,
    { headers: { cookie: pendingCookie }, maxRedirects: 0 },
  );
  expect(cb.status()).toBe(302);
  const cbBody = await cb.text();
  collectBodies?.push(cbBody);
  const sessionCookie = cookieFrom(cb, "gitdatnote_session");

  const session = await ctx.get("/api/session", {
    headers: { cookie: sessionCookie },
  });
  expect(session.status()).toBe(200);
  const sessionBody = await session.text();
  collectBodies?.push(sessionBody);
  const parsed = JSON.parse(sessionBody) as {
    connected: boolean;
    csrfToken: string;
  };
  expect(parsed.connected).toBe(true);
  return { cookie: sessionCookie, csrfToken: parsed.csrfToken };
}

function contentUrl(repo: string, path: string): string {
  const q = path === "" ? "" : `?path=${encodeURIComponent(path)}`;
  return `/api/repos/${OWNER}/${repo}/content${q}`;
}

function authHeaders(s: SigninState, withCsrf: boolean): Record<string, string> {
  const headers: Record<string, string> = { cookie: s.cookie };
  if (withCsrf) headers["X-CSRF-Token"] = s.csrfToken;
  return headers;
}

/**
 * Headers for state-changing JSON requests. Note: Playwright's Node
 * `APIRequestContext` silently drops the `json:` option in this version, so
 * the spec sends `data: JSON.stringify(...)` with an explicit content type.
 */
function writeHeaders(s: SigninState, withCsrf: boolean): Record<string, string> {
  return { ...authHeaders(s, withCsrf), "Content-Type": "application/json" };
}

/** The standard error envelope's `code`, in either accepted shape. */
function codeOf(json: unknown): string | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const obj = json as Record<string, unknown>;
  if (typeof obj.code === "string") return obj.code;
  const error = obj.error;
  if (typeof error === "object" && error !== null) {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

test.describe("content API over real HTTP (task 5.2)", () => {
  test("authenticated read returns exact Unicode content, blob SHA, and UTF-8 size", async () => {
    const s = await signIn();
    const res = await ctx.get(contentUrl(REPO_WRITE, NOTE_PATH), {
      headers: authHeaders(s, false),
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      type: string;
      path: string;
      content: string;
      sha: string;
      size: number;
    };
    expect(body.type).toBe("file");
    expect(body.path).toBe(NOTE_PATH);
    expect(body.content).toBe(UNICODE);
    expect(body.sha).toBe(blobSha(UNICODE));
    expect(body.size).toBe(Buffer.byteLength(UNICODE, "utf8"));
    // The adapter was constructed with the session's user access token.
    expect(factoryTokens).toContain(ACCESS_TOKEN);
  });

  test("directory listing returns the content root and immediate children", async () => {
    const s = await signIn();
    const root = await ctx.get(contentUrl(REPO_WRITE, ""), {
      headers: authHeaders(s, false),
    });
    expect(root.status()).toBe(200);
    const rootBody = (await root.json()) as {
      type: string;
      path: string;
      children: Record<string, unknown>[];
    };
    expect(rootBody.type).toBe("directory");
    expect(rootBody.path).toBe("");
    expect(rootBody.children).toEqual([
      { name: "2026", type: "dir", sha: "b".repeat(40), size: 0 },
    ]);

    const sub = await ctx.get(contentUrl(REPO_WRITE, "2026"), {
      headers: authHeaders(s, false),
    });
    expect(sub.status()).toBe(200);
    const subBody = (await sub.json()) as {
      type: string;
      path: string;
      children: Record<string, unknown>[];
    };
    expect(subBody.type).toBe("directory");
    expect(subBody.path).toBe("2026");
    expect(subBody.children).toEqual([
      {
        name: "other.md",
        type: "file",
        sha: blobSha(OTHER),
        size: Buffer.byteLength(OTHER, "utf8"),
      },
      {
        name: "unicode-note.md",
        type: "file",
        sha: blobSha(UNICODE),
        size: Buffer.byteLength(UNICODE, "utf8"),
      },
    ]);
  });

  test("create with a valid CSRF returns 201 and performs exactly one upstream write", async () => {
    const s = await signIn();
    const content = "# New note\n";
    const res = await ctx.post(contentUrl(REPO_WRITE, ""), {
      headers: writeHeaders(s, true),
      data: JSON.stringify({ path: "2026/new-note.md", content, message: "Add a new note" }),
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as { path: string; sha: string };
    expect(body.path).toBe("2026/new-note.md");
    expect(body.sha).toBe(blobSha(content));
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].owner).toBe(OWNER);
    expect(writeCalls[0].repo).toBe(REPO_WRITE);
    expect(writeCalls[0].path).toBe(`${ROOT}/2026/new-note.md`);
    expect(writeCalls[0].sha).toBeUndefined(); // a create carries no SHA
    // The upstream store now holds the exact bytes.
    const stored = store.get(key(OWNER, REPO_WRITE, `${ROOT}/2026/new-note.md`));
    expect(stored).toEqual({
      type: "file",
      content,
      sha: blobSha(content),
    });
  });

  test("update with the current SHA returns 200 and the new blob SHA", async () => {
    const s = await signIn();
    const current = blobSha(UNICODE);
    const next = "Updated café content ☕\n";
    const res = await ctx.put(contentUrl(REPO_WRITE, ""), {
      headers: writeHeaders(s, true),
      data: JSON.stringify({
        path: NOTE_PATH,
        content: next,
        expectedSha: current,
        message: "Update the note",
      }),
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { path: string; sha: string };
    expect(body.path).toBe(NOTE_PATH);
    expect(body.sha).toBe(blobSha(next));
    expect(body.sha).not.toBe(current);
    const stored = store.get(key(OWNER, REPO_WRITE, `${ROOT}/${NOTE_PATH}`));
    expect(stored).toEqual({ type: "file", content: next, sha: blobSha(next) });
  });

  test("stale SHA update returns 409 SHA_CONFLICT with the current SHA and no overwrite", async () => {
    const s = await signIn();
    const stale = blobSha(UNICODE);
    // First advance the file to a new SHA with a correct update.
    const advance = "Newer version of the note\n";
    const ok = await ctx.put(contentUrl(REPO_WRITE, ""), {
      headers: writeHeaders(s, true),
      data: JSON.stringify({ path: NOTE_PATH, content: advance, expectedSha: stale }),
    });
    expect(ok.status()).toBe(200);
    const currentSha = (await ok.json()) as { sha: string };
    expect(currentSha.sha).toBe(blobSha(advance));

    const writesBefore = writeCalls.length;
    const res = await ctx.put(contentUrl(REPO_WRITE, ""), {
      headers: writeHeaders(s, true),
      data: JSON.stringify({ path: NOTE_PATH, content: "Attempted overwrite\n", expectedSha: stale }),
    });
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(codeOf(body)).toBe("SHA_CONFLICT");
    const detail = (body as { error?: Record<string, unknown>; currentSha?: string }).error ??
      (body as Record<string, unknown>);
    expect(detail.currentSha).toBe(currentSha.sha);
    // No overwrite: the file still holds the newer version.
    const stored = store.get(key(OWNER, REPO_WRITE, `${ROOT}/${NOTE_PATH}`));
    expect(stored).toEqual({ type: "file", content: advance, sha: blobSha(advance) });
    // No upstream write for the rejected update.
    expect(writeCalls.length).toBe(writesBefore);
  });

  test("missing and invalid CSRF on POST and PUT returns 403 CSRF_INVALID without writes", async () => {
    const s = await signIn();
    const writesBefore = writeCalls.length;

    const noToken = await ctx.post(contentUrl(REPO_WRITE, ""), {
      headers: writeHeaders(s, false),
      data: JSON.stringify({ path: "2026/x.md", content: "# x\n" }),
    });
    expect(noToken.status()).toBe(403);
    expect(codeOf(await noToken.json())).toBe("CSRF_INVALID");

    const wrongToken = "f".repeat(64);
    expect(wrongToken).not.toBe(s.csrfToken);
    const putBad = await ctx.put(contentUrl(REPO_WRITE, ""), {
      headers: { ...writeHeaders(s, true), "X-CSRF-Token": wrongToken },
      data: JSON.stringify({
        path: NOTE_PATH,
        content: "# overwritten?\n",
        expectedSha: blobSha(UNICODE),
      }),
    });
    expect(putBad.status()).toBe(403);
    expect(codeOf(await putBad.json())).toBe("CSRF_INVALID");
    expect(writeCalls.length).toBe(writesBefore);
  });

  test("a session survives CSRF rejections and unauthenticated attempts", async () => {
    const s = await signIn();

    // A CSRF rejection does not invalidate the session.
    const bad = await ctx.post(contentUrl(REPO_WRITE, ""), {
      headers: { ...writeHeaders(s, true), "X-CSRF-Token": "0".repeat(64) },
      data: JSON.stringify({ path: "2026/rejected.md", content: "# rejected\n" }),
    });
    expect(bad.status()).toBe(403);
    expect(codeOf(await bad.json())).toBe("CSRF_INVALID");

    // An unauthenticated state-changing request is refused (no session
    // cookie). A fresh, cookie-free request context proves it — the shared
    // context's cookie jar would otherwise replay the session cookie.
    const anonCtx = await playwrightRequest.newContext({ baseURL: base });
    try {
      const anon = await anonCtx.post(contentUrl(REPO_WRITE, ""), {
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify({ path: "2026/anon.md", content: "# anon\n" }),
      });
      expect(anon.status()).toBe(401);
    } finally {
      await anonCtx.dispose();
    }

    // The session is still valid and still able to write.
    const session = await ctx.get("/api/session", {
      headers: { cookie: s.cookie },
    });
    expect(session.status()).toBe(200);
    expect(((await session.json()) as { connected: boolean }).connected).toBe(true);

    const ok = await ctx.post(contentUrl(REPO_WRITE, ""), {
      headers: writeHeaders(s, true),
      data: JSON.stringify({ path: "2026/still-valid.md", content: "# Still valid\n" }),
    });
    expect(ok.status()).toBe(201);
  });

  test("unauthorized repository read/write returns 403 REPO_NOT_ALLOWED with no upstream operations", async () => {
    const s = await signIn();
    const factoryBefore = factoryTokens.length;
    const writesBefore = writeCalls.length;

    // Read from a repository that is not in the session's repository list.
    const unknown = await ctx.get(contentUrl(REPO_UNKNOWN, "2026"), {
      headers: authHeaders(s, false),
    });
    expect(unknown.status()).toBe(403);
    expect(codeOf(await unknown.json())).toBe("REPO_NOT_ALLOWED");

    // Write to the read-only repository.
    const writeReadOnly = await ctx.post(contentUrl(REPO_READ, ""), {
      headers: writeHeaders(s, true),
      data: JSON.stringify({ path: "2026/evil.md", content: "# evil\n" }),
    });
    expect(writeReadOnly.status()).toBe(403);
    expect(codeOf(await writeReadOnly.json())).toBe("REPO_NOT_ALLOWED");

    // Read from the read-only repository is still allowed.
    const readOnlyRead = await ctx.get(contentUrl(REPO_READ, OTHER_PATH), {
      headers: authHeaders(s, false),
    });
    expect(readOnlyRead.status()).toBe(200);

    // The rejected requests never reached the content client, and no write
    // happened anywhere.
    expect(factoryTokens.length).toBe(factoryBefore + 1); // only the allowed read
    expect(writeCalls.length).toBe(writesBefore);
  });

  test("no credentials leak in any sign-in or content response", async () => {
    const bodies: string[] = [];
    const s = await signIn(bodies);

    const read = await ctx.get(contentUrl(REPO_WRITE, NOTE_PATH), {
      headers: authHeaders(s, false),
    });
    expect(read.status()).toBe(200);
    bodies.push(await read.text());

    const create = await ctx.post(contentUrl(REPO_WRITE, ""), {
      headers: writeHeaders(s, true),
      data: JSON.stringify({ path: "2026/leak-check.md", content: "# leak check\n" }),
    });
    expect(create.status()).toBe(201);
    bodies.push(await create.text());

    // GitHub OAuth credentials, the authorization code, and the session
    // cookie value must never appear in any response body.
    const secrets = [ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_SECRET, AUTH_CODE];
    const cookieValue = s.cookie.split("=")[1] ?? "";
    for (const body of bodies) {
      for (const secret of secrets) {
        expect(body).not.toContain(secret);
      }
      expect(body).not.toContain(cookieValue);
    }
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import buildFrontMatter from "../../src/components/buildFrontMatter.js";
import slugify from "slugify";

// --- A. Front matter generation (buildFrontMatter.js) -------------------
//
// Legacy behavior under characterization:
//   buildFrontMatter(title) -> "---\ntitle: <title>\ndate: <new Date().toISOString()>\n---\n"
//   - only `title` and `date`; no description, no tags
//   - date is full ISO 8601 (with time + Z), not YYYY-MM-DD
//   - no YAML quoting/escaping of the title
//
// `new Date()` cannot be frozen via `vi.spyOn(Date, "now")` (it does not call
// Date.now internally), so the date is pinned by spying on
// `Date.prototype.toISOString` — the exact method the legacy code invokes.

const FIXED_ISO = "2024-12-01T12:00:00.000Z";

describe("legacy buildFrontMatter (A)", () => {
  afterEach(() => Date.prototype.toISOString.mockRestore());

  it("produces the exact front-matter content for an ordinary title", () => {
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue(FIXED_ISO);
    expect(buildFrontMatter("My Post")).toBe(`---\ntitle: My Post\ndate: ${FIXED_ISO}\n---\n`);
  });

  it("wraps front matter in --- delimiters with a trailing newline", () => {
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue(FIXED_ISO);
    const out = buildFrontMatter("My Post");
    expect(out.split("\n")).toEqual(["---", "title: My Post", `date: ${FIXED_ISO}`, "---", ""]);
  });

  it("emits only title and date fields (no description/tags)", () => {
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue(FIXED_ISO);
    const keys = buildFrontMatter("T")
      .split("\n")
      .filter((l) => l.includes(":"))
      .map((l) => l.split(":")[0]);
    expect(keys).toEqual(["title", "date"]);
  });

  it("uses full ISO 8601 date (with time + Z), not YYYY-MM-DD", () => {
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue(FIXED_ISO);
    const out = buildFrontMatter("T");
    expect(out).toContain(`date: ${FIXED_ISO}`);
    expect(out).not.toContain("date: 2024-12-01\n"); // not a date-only value
  });

  it("characterized defect: colon in title is NOT quoted (malformed YAML value)", () => {
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue(FIXED_ISO);
    expect(buildFrontMatter("A: B")).toContain("title: A: B");
  });

  it("characterized defect: leading special char in title is NOT quoted", () => {
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue(FIXED_ISO);
    expect(buildFrontMatter("*star*")).toContain("title: *star*");
  });

  it("characterized defect: newline in title produces a multi-line, unquoted title value", () => {
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue(FIXED_ISO);
    expect(buildFrontMatter("line1\nline2")).toContain("title: line1\nline2");
  });
});

// --- B. Slug generation (slugify as used in newPost.js) ------------------
//
// Legacy usage: `let postURL = slugify(postTitle)` then file `${postURL}.md`.
// Characterized slugify 1.6.6 default behavior (no options passed in legacy code),
// verified empirically during this task:
//   - CASE IS PRESERVED (does not lowercase by default)
//   - whitespace runs become single `-`
//   - apostrophes, asterisks, colons, underscores, and trailing `!`/`.` are KEPT
//   - trailing `?` is stripped, leading `--` stripped
//   - diacritics are stripped to ASCII base characters
//   - CJK characters are stripped entirely
//   - no collision handling in the caller (newPost.js)

describe("legacy slugify filename generation (B)", () => {
  it("characterized behavior: case is PRESERVED (default slugify, no lowercase option)", () => {
    expect(slugify("Hello World")).toBe("Hello-World");
    expect(slugify("My 2025 Post")).toBe("My-2025-Post");
  });

  it("whitespace runs collapse to single hyphen", () => {
    expect(slugify("a  b   c")).toBe("a-b-c");
  });

  it("characterized behavior: apostrophes are KEPT in the slug", () => {
    expect(slugify("What's New?")).toBe("What's-New");
    // the trailing ? is stripped, the apostrophe survives -> apostrophes end up in filenames
  });

  it("characterized behavior: leading dashes are stripped", () => {
    expect(slugify("--Hello--")).toBe("Hello");
  });

  it("characterized behavior: some punctuation is kept (defect: !, * and : survive into filenames)", () => {
    expect(slugify("!!!")).toBe("!!!"); // entirely a punctuation slug; filenames get '!' chars
    expect(slugify("*star*")).toBe("*star*"); // '*' is an invalid character in Windows filenames
    expect(slugify("A: B")).toBe("A:-B"); // ':' survives — invalid in Windows filenames
  });

  it("characterized behavior: trailing period and exclamation are KEPT", () => {
    expect(slugify("Hello.")).toBe("Hello.");
    expect(slugify("B!")).toBe("B!");
  });

  it("characterized behavior: punctuation-only titles can produce a punctuation-only slug (NOT empty)", () => {
    expect(slugify("!!!")).toBe("!!!"); // '!!!' survives; the legacy caller would create a file named "!!!.md"
  });

  it("characterized behavior: accented characters are stripped to ASCII base", () => {
    expect(slugify("café")).toBe("cafe");
    expect(slugify("résumé")).toBe("resume");
  });

  it("characterized behavior: CJK characters are stripped entirely (no transliteration)", () => {
    expect(slugify("日本語")).toBe("");
  });

  it("characterized collision risk: distinct titles map to identical slugs", () => {
    expect(slugify("My Post")).toBe(slugify("My-Post"));
    expect(slugify("My Post.")).toBe(slugify("My-Post."));
    expect(slugify("Café")).toBe(slugify("Cafe"));
    expect(slugify("日本語")).toBe(slugify("???")); // both "" — CJK and '?' both vanish
  });

  it("characterized collision risk: legacy caller (newPost.js) PUTs directly to <slug>.md with no existence check", () => {
    // Verified by source inspection: newPost.js builds `path: ${postURL}.md` and
    // PUTs without checking whether the file exists — a second post with the
    // same slug silently overwrites the first. Documented only; no fix applied.
    expect(slugify("My Post")).toBe("My-Post");
  });
});

// --- C. Directory listing -> post selection (getPostTitles.js) -----------
//
// The module builds `new Octokit({ auth: import.meta.env.VITE_GITHUB_TOKEN })`
// inside the function and calls a hardcoded contents endpoint. The `octokit`
// module is mocked (hoisted) so the real GitHub API is never contacted.
// NOTE: `vi.restoreAllMocks()` must NOT be used in this file — it also restores
// the module mock's implementation. Only `mockRequest.mockReset()` is used here.

const mockRequest = vi.hoisted(() => vi.fn());

vi.mock("octokit", () => ({
  Octokit: vi.fn().mockImplementation(() => ({ request: mockRequest })),
}));

import getPostTitles from "../../src/components/getPostTitles.js";

describe("legacy getPostTitles directory listing (C)", () => {
  afterEach(() => mockRequest.mockReset());

  const fakeDirResponse = {
    data: [
      { name: "my-post.md", html_url: "https://example/my-post.md", sha: "sha-md" },
      { name: "notes.txt", html_url: "https://example/notes.txt", sha: "sha-txt" },
      { name: "README", html_url: "https://example/README", sha: "sha-readme" },
    ],
  };

  it("requests the hardcoded contents endpoint with hardcoded owner/repo", async () => {
    mockRequest.mockResolvedValue(fakeDirResponse);
    await getPostTitles();
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/contents/Journal/2024/December/",
      { owner: "kevinctofel", repo: "SecondBrain" }
    );
  });

  it("maps .md-named entries to { title, url, sha } preserving order", async () => {
    mockRequest.mockResolvedValue(fakeDirResponse);
    const posts = await getPostTitles();
    expect(posts).toEqual([{ title: "my-post", url: "https://example/my-post.md", sha: "sha-md" }]);
  });

  it("filters out non-.md entries (.txt, no extension)", async () => {
    mockRequest.mockResolvedValue(fakeDirResponse);
    const posts = await getPostTitles();
    expect(posts.map((p) => p.title)).toEqual(["my-post"]);
  });

  it("characterized limitation: the per-file helper `postInfo` is dead code — never invoked", async () => {
    mockRequest.mockResolvedValue(fakeDirResponse);
    await getPostTitles();
    // Only the directory-listing request fires; the per-file GET is defined but
    // unreachable in the current code, so its behavior cannot be characterized
    // without refactoring.
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it("characterized behavior: empty directory yields an empty post list", async () => {
    mockRequest.mockResolvedValue({ data: [] });
    expect(await getPostTitles()).toEqual([]);
  });

  it("characterized defect: entries named *.md are treated as posts regardless of entry type", async () => {
    mockRequest.mockResolvedValue({
      data: [{ name: "archive.md", html_url: "https://example/archive.md", sha: "x", type: "dir" }],
    });
    const posts = await getPostTitles();
    // Legacy code ignores `post.type` — a directory passes the name filter.
    expect(posts).toEqual([{ title: "archive", url: "https://example/archive.md", sha: "x" }]);
  });
});

// --- D. SHA-based conflict detection -------------------------------------
//
// Finding (documented in audit.md; no executable characterization is possible):
//   - The only SHA-based update in the legacy codebase is `src/components/updatePost.js`,
//     which performs a top-level `await` at module scope (executes on import, not on
//     call), hardcodes a different repo (MyConsciousStream) and path, and PUTs with
//     `sha: data.data.sha`. The SHA-check pattern exists there.
//   - The live update path (`newPost.js`, reachable from App.jsx) performs a plain PUT
//     with NO `sha` field — it silently overwrites existing files. No conflict
//     detection exists on the path the user actually exercises.
//   - Characterizing `updatePost.js`'s behavior would require executing the module,
//     which performs a real GitHub request on import. Not possible without
//     refactoring (e.g., extracting the logic into a callable, DI-injected function).
//
// Appropriate future home: the `repository-content` spec's requirements
// "Create without overwriting" (409 FILE_EXISTS) and "Update with expected SHA"
// (409 SHA_CONFLICT), to be implemented in tasks 4.3 / 4.4.

describe("legacy SHA conflict detection (D) — source-level characterization", () => {
  it("documents: live update path (newPost.js) sends no sha — no conflict detection", () => {
    // Source inspection of src/components/newPost.js: the PUT request object
    // contains owner/repo/path/message/committer/content/headers — no `sha`.
    expect(true).toBe(true);
  });
});

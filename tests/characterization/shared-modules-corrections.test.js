/**
 * Regression checks for the Task 2.3 code-review corrections (independent
 * review of commit ed0516c on feat/gitdatnote-2).
 *
 * Covers only the corrected cases:
 *   1. content-root validation (absolute roots, backslashes, traversal,
 *      control characters; nested roots preserved; user paths never leave
 *      the configured root; lexical canonicalization preserved)
 *   2. YAML-sensitive control characters in front matter fields
 *   3. calendar/time validity of accepted ISO 8601 date strings
 *   4. (permission contract: type-level only — covered by typecheck)
 *   5. SHA_CONFLICT response shape carrying currentSha
 *
 * This is NOT the Task 2.6 testing matrix.
 */
import { describe, it, expect } from "vitest";
import { validateContentPath } from "../../src/shared/validate";
import { buildFrontMatter } from "../../src/shared/frontMatter";
import {
  defaultDetail,
  shaConflictDetail,
  toShaConflictResponse,
} from "../../src/shared/errors";

describe("task 2.3 corrections: content-root validation", () => {
  it("rejects an absolute content root", () => {
    const r = validateContentPath("/Journal", "a/b.md", "file");
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("PATH_INVALID");
  });

  it("rejects backslashes in the content root", () => {
    const r = validateContentPath("Journal\\2024", "a.md", "file");
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("PATH_INVALID");
  });

  it("rejects a content root that escapes the repository root", () => {
    expect(validateContentPath("..", "a.md", "file").ok).toBe(false);
    expect(validateContentPath("a/../..", "a.md", "file").ok).toBe(false);
  });

  it("rejects control characters in the content root", () => {
    expect(validateContentPath("Journal\u0000", "a.md", "file").ok).toBe(false);
  });

  it("keeps legitimate nested content roots working", () => {
    const r = validateContentPath("Journal/2024/December", "my-post.md", "file");
    expect(r.ok).toBe(true);
    expect(r.repositoryPath).toBe("Journal/2024/December/my-post.md");
  });

  it("still rejects user paths that escape the configured root", () => {
    expect(validateContentPath("Journal", "../etc/passwd", "file").ok).toBe(false);
    expect(validateContentPath("Journal", "../../x", "dir").ok).toBe(false);
    expect(validateContentPath("Journal", "/x.md", "file").ok).toBe(false);
    expect(validateContentPath("Journal", "a\\b.md", "file").ok).toBe(false);
  });

  it("never resolves a user path outside the configured root (invariant)", () => {
    // Empty relative path stays exactly at the configured root.
    const root = validateContentPath("Journal", "", "directory");
    expect(root.ok).toBe(true);
    expect(root.relativePath).toBe("");
    expect(root.repositoryPath).toBe("Journal");
    // Internally resolvable segments stay inside the root.
    const nested = validateContentPath("Journal", "a/../b/c.md", "file");
    expect(nested.ok).toBe(true);
    expect(nested.repositoryPath).toBe("Journal/b/c.md");
  });

  it("preserves lexical canonicalization of internally resolvable .. segments", () => {
    const r = validateContentPath("Journal", "2024/December/../my-post.md", "file");
    expect(r.ok).toBe(true);
    expect(r.relativePath).toBe("2024/my-post.md");
  });
});

describe("task 2.3 corrections: YAML control characters", () => {
  it("rejects C0 control characters (other than tab/LF/CR) in the title", () => {
    expect(() => buildFrontMatter({ title: "Bad\u0000Title", date: "2026-11-02" })).toThrow(
      /unsafe control character/,
    );
    expect(() => buildFrontMatter({ title: "Bad\u000bTitle", date: "2026-11-02" })).toThrow(
      /unsafe control character/,
    );
  });

  it("rejects DEL in title, description, and tags", () => {
    expect(() => buildFrontMatter({ title: "T\u007f", date: "2026-11-02" })).toThrow(
      /unsafe control character/,
    );
    expect(() =>
      buildFrontMatter({ title: "T", date: "2026-11-02", description: "d\u007f" }),
    ).toThrow(/unsafe control character/);
    expect(() =>
      buildFrontMatter({ title: "T", date: "2026-11-02", tags: ["a\u001b"] }),
    ).toThrow(/unsafe control character/);
  });

  it("still accepts tab/newline/carriage return via double-quote escaping", () => {
    const out = buildFrontMatter({ title: "a\tb\nc\r", date: "2026-11-02" });
    expect(out).toContain('title: "a\\tb\\nc\\r"');
  });
});

describe("task 2.3 corrections: date validation", () => {
  const valid = (date) => {
    expect(() => buildFrontMatter({ title: "T", date })).not.toThrow();
  };
  const invalid = (date) => {
    expect(() => buildFrontMatter({ title: "T", date })).toThrow(
      /ISO 8601 date/,
    );
  };

  it("accepts the documented date and date-time forms", () => {
    valid("2026-11-02");
    valid("2026-11-02T12:00:00");
    valid("2026-11-02T12:00:00Z");
    valid("2026-11-02T14:27:52.010Z");
    valid("2026-11-02T12:00:00.5Z");
    valid("2026-11-02T12:00:00+02:00");
    valid("2026-11-02T12:00:00-14:00");
    valid("2024-02-29"); // leap year
  });

  it("rejects invalid calendar dates", () => {
    invalid("2023-02-29"); // not a leap year
    invalid("2026-02-29"); // not a leap year
    invalid("2024-02-31");
    invalid("2026-00-10");
    invalid("2026-13-01");
    invalid("2026-11-00");
    invalid("2026-11-32");
  });

  it("rejects out-of-range time components and offsets", () => {
    invalid("2026-11-02T24:00:00Z");
    invalid("2026-11-02T12:60:00Z");
    invalid("2026-11-02T12:00:60Z");
    invalid("2026-11-02T12:00:00+24:00");
    invalid("2026-11-02T12:00:00+02:60");
  });

  it("never normalizes an accepted date string", () => {
    const out = buildFrontMatter({ title: "T", date: "2026-11-02T14:27:52.010Z" });
    expect(out).toContain("date: 2026-11-02T14:27:52.010Z");
  });
});

describe("task 2.3 corrections: SHA conflict response shape", () => {
  it("carries the current SHA in the error object", () => {
    const resp = toShaConflictResponse("sha-current-123");
    expect(resp.error.code).toBe("SHA_CONFLICT");
    expect(resp.error.status).toBe(409);
    expect(resp.error.retryable).toBe(false);
    expect(resp.error.message).toBe(defaultDetail("SHA_CONFLICT").message);
    expect(resp.error.currentSha).toBe("sha-current-123");
  });

  it("shaConflictDetail matches the standard detail plus currentSha", () => {
    const d = shaConflictDetail("abc");
    expect({ ...d, currentSha: undefined }).toEqual(defaultDetail("SHA_CONFLICT"));
  });
});

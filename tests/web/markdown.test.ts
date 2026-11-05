// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

// DOMPurify cannot run under this project's happy-dom test environment: its
// iframe-based sandbox reads `window.defaultView.console`, which happy-dom's
// Window leaves null (and read-only, so it cannot be corrected). Under
// happy-dom DOMPurify therefore returns garbled output and crashes on
// `<iframe>` input. In a real browser DOMPurify sanitizes correctly.
//
// These tests therefore stand in for DOMPurify with a deterministic sanitizer
// and verify the PIPELINE CONTRACT that this codebase owns:
//   marked output is always routed through DOMPurify.sanitize, and the
//   sanitized result — never the raw rendered Markdown — is what is returned
//   (and is the only thing `MarkdownPreview` assigns to the DOM).
const sanitizeMock = vi.hoisted(() => vi.fn());

vi.mock("dompurify", () => ({
  default: () => ({ sanitize: sanitizeMock }),
}));

import { renderMarkdownSafe } from "../../src/web/markdown";

beforeEach(() => {
  sanitizeMock.mockReset();
});

describe("renderMarkdownSafe pipeline (marked -> DOMPurify -> DOM)", () => {
  it("runs marked and routes the rendered HTML through DOMPurify.sanitize", () => {
    sanitizeMock.mockImplementation((html: string) => "SANITIZED[" + html + "]");
    const out = renderMarkdownSafe("# Hello\n\nSome **bold** text.");

    // marked produced real HTML, and DOMPurify received exactly that HTML.
    expect(sanitizeMock).toHaveBeenCalledTimes(1);
    const passed = sanitizeMock.mock.calls[0][0] as string;
    expect(passed).toContain("<strong>bold</strong>");
    expect(passed).toContain("Hello");

    // The returned value is exactly DOMPurify's output: the raw rendered
    // Markdown never escapes to the caller.
    expect(out).toBe("SANITIZED[" + passed + "]");
    expect(out).not.toContain("**bold**");
  });

  it("returns DOMPurify's sanitized result for malicious Markdown (never the raw render)", () => {
    // Deterministic stand-in for DOMPurify: strip <script> blocks, on* handlers,
    // javascript: URLs, forbidden embed tags, and inline style attributes.
    sanitizeMock.mockImplementation((html: string) =>
      html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
        .replace(/href\s*=\s*"javascript:[^"]*"/gi, "")
        .replace(/<(?:iframe|object|embed)\b[\s\S]*?(?:\/>|<\/(?:iframe|object|embed)>)/gi, "")
        .replace(/\sstyle\s*=\s*"[^"]*"/gi, ""),
    );

    expect(
      renderMarkdownSafe("Hello <script>alert('xss')</script> world"),
    ).not.toContain("<script>");
    expect(
      renderMarkdownSafe('![x](y) <img src=x onerror="alert(1)">'),
    ).not.toContain("onerror");
    expect(renderMarkdownSafe("[click](javascript:alert(1))")).not.toContain(
      "javascript:",
    );
    const embed = renderMarkdownSafe(
      '<iframe src="https://evil.test"></iframe><object data="x"></object>',
    );
    expect(embed).not.toContain("<iframe");
    expect(embed).not.toContain("<object");
  });

  it("passes the explicit forbid list through to DOMPurify.sanitize", () => {
    sanitizeMock.mockImplementation((html: string) => html);
    renderMarkdownSafe("hi");
    const opts = sanitizeMock.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.FORBID_TAGS).toEqual(
      expect.arrayContaining(["script", "iframe", "object", "embed", "form"]),
    );
    expect(opts.FORBID_ATTR).toEqual(expect.arrayContaining(["style", "formaction"]));
  });
});

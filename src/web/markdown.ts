import DOMPurify from "dompurify";
import { Marked } from "marked";

const marked = new Marked({ gfm: true, breaks: false });

/**
 * Explicit sanitizer forbids, layered on top of DOMPurify's default profile
 * (which already drops `on*` event handlers, `javascript:`/`data:` URIs, and
 * any tag/attribute not on the allowlist). The application-foundation spec
 * requires scripts, event handlers, javascript:/data: URIs, and embedded
 * script/iframe/object tags to be neutralized; these forbids make that intent
 * unambiguous and add defense-in-depth.
 */
const DOMPURIFY_FORBID_TAGS: string[] = [
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "form",
  "meta",
  "base",
  "link",
  "noscript",
];
const DOMPURIFY_FORBID_ATTR: string[] = ["style", "formaction"];

const purify = typeof window !== "undefined" ? DOMPurify(window) : DOMPurify;

/**
 * Render Markdown to HTML, sanitized so that unsanitized rendered Markdown
 * can never reach the DOM. Callers assign only this result to a scoped
 * element (see `MarkdownPreview`).
 */
export function renderMarkdownSafe(markdown: string): string {
  // `async: false` keeps this synchronous; the cast is safe because of that.
  const html = marked.parse(markdown, { async: false }) as string;
  return purify.sanitize(html, {
    FORBID_TAGS: DOMPURIFY_FORBID_TAGS,
    FORBID_ATTR: DOMPURIFY_FORBID_ATTR,
  });
}

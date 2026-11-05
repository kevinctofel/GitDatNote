import { FIXTURE_SAMPLE_MARKDOWN } from "./fixtures";

/**
 * Development-only override for the labeled sample preview's Markdown.
 *
 * Foundation task 2.7 drives the real Markdown pipeline
 * (`marked` → real `DOMPurify` → `MarkdownPreview`) with malicious payloads
 * in a real browser. The app's preview normally renders the fixed, safe
 * `FIXTURE_SAMPLE_MARKDOWN`; this override lets a test swap in a payload
 * without changing production behavior.
 *
 * It is gated to dev mode and reachable only through an explicit test hook,
 * so malicious payloads can never appear as real user content.
 */
let devMarkdown: string | null = null;

/** Test-only hook. Inactive in production builds (the branch is dead-code-eliminated). */
export function __setDevPreviewMarkdown(markdown: string | null): void {
  if (import.meta.env.DEV) {
    devMarkdown = markdown;
  }
}

/** The Markdown the sample preview renders (the safe fixture in production). */
export function getPreviewMarkdown(): string {
  return devMarkdown ?? FIXTURE_SAMPLE_MARKDOWN;
}

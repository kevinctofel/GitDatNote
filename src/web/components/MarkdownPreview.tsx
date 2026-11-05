import { renderMarkdownSafe } from "../markdown";

interface MarkdownPreviewProps {
  /** Raw Markdown source. */
  markdown: string;
  className?: string;
}

/**
 * Renders Markdown into a scoped element. The only HTML ever assigned to the
 * DOM is the sanitized output of `renderMarkdownSafe`; unsanitized rendered
 * Markdown is never assigned to `innerHTML`.
 */
export function MarkdownPreview({ markdown, className }: MarkdownPreviewProps) {
  const html = renderMarkdownSafe(markdown);
  return (
    <article
      className={className ? `markdown-preview ${className}` : "markdown-preview"}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

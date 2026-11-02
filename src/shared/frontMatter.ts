/**
 * Markdown front matter generation (design.md A-03; audit item A).
 *
 * Replaces the legacy `buildFrontMatter` behavior:
 * - adds the previously missing `description` and `tags` fields;
 * - emits YAML-safe, always-quoted string values (titles containing `:`,
 *   leading specials, or newlines no longer corrupt the front matter);
 * - preserves Unicode text exactly;
 * - is deterministic: identical inputs produce identical output, and the
 *   date is supplied by the caller (no locale-dependent formatting here).
 *
 * A fixed, small field set means a minimal deterministic serializer is
 * sufficient; no YAML library dependency is added. Parsing front matter is
 * not required by this task and is intentionally omitted.
 */

/** Front matter metadata for a post. */
export interface FrontMatterMeta {
  /** Post title. Must be non-empty; never modified. */
  title: string;
  /**
   * ISO 8601 date string, e.g. `2026-11-02` or
   * `2026-11-02T12:00:00.000Z`. Emitted unquoted (YAML-safe for this shape,
   * and matching the legacy wire format).
   */
  date: string;
  /** Optional; omitted from the output when absent or empty. */
  description?: string;
  /** Optional; omitted from the output when absent or empty. */
  tags?: string[];
}

/**
 * Serialize front matter for a post.
 *
 * Output shape (fields in this order):
 *
 * ```
 * ---
 * title: "..."
 * description: "..."   # only when present and non-empty
 * date: 2026-11-02
 * tags: ["a", "b"]     # only when present and non-empty
 * ---
 * ```
 *
 * Throws on invalid input (empty title, non-ISO date, or multi-line/empty
 * tags) rather than silently altering the content.
 */
export function buildFrontMatter(meta: FrontMatterMeta): string {
  const { title, date, description, tags } = meta;

  if (typeof title !== 'string' || title.trim() === '') {
    throw new Error('buildFrontMatter: title must be a non-empty string');
  }
  if (!isIsoDate(date)) {
    throw new Error('buildFrontMatter: date must be an ISO 8601 date string');
  }

  const lines: string[] = ['---', `title: ${quoteYaml(title)}`];

  if (typeof description === 'string' && description !== '') {
    lines.push(`description: ${quoteYaml(description)}`);
  }

  lines.push(`date: ${date}`);

  if (Array.isArray(tags) && tags.length > 0) {
    for (const tag of tags) {
      if (typeof tag !== 'string' || tag.trim() === '') {
        throw new Error('buildFrontMatter: tags must be non-empty strings');
      }
    }
    lines.push(`tags: [${tags.map(quoteYaml).join(', ')}]`);
  }

  lines.push('---');
  return `${lines.join('\n')}\n`;
}

/**
 * Serialize a string as a double-quoted YAML scalar, escaping backslashes,
 * double quotes, and line breaks. Double-quoting every value makes the
 * output safe for titles/descriptions containing colons, quotes, leading
 * special characters, or newlines.
 */
function quoteYaml(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/**
 * Accept ISO 8601 date or date-time forms (with optional fractional
 * seconds and timezone offset/Z). These forms contain no YAML-sensitive
 * sequences, so they are safe to emit unquoted.
 */
function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/.test(value)
  );
}

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
  assertNoUnsafeControlChars(title, 'title');
  if (!isIsoDate(date)) {
    throw new Error('buildFrontMatter: date must be an ISO 8601 date string');
  }

  const lines: string[] = ['---', `title: ${quoteYaml(title)}`];

  if (typeof description === 'string' && description !== '') {
    assertNoUnsafeControlChars(description, 'description');
    lines.push(`description: ${quoteYaml(description)}`);
  }

  lines.push(`date: ${date}`);

  if (Array.isArray(tags) && tags.length > 0) {
    for (const tag of tags) {
      if (typeof tag !== 'string' || tag.trim() === '') {
        throw new Error('buildFrontMatter: tags must be non-empty strings');
      }
      assertNoUnsafeControlChars(tag, 'tags');
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
 * seconds and a `Z` or `±HH:mm` offset), and verify the calendar date and
 * time components are real values: month 01-12, day valid for the month
 * and year (including leap years), hour 00-23, minute/second 00-59, and
 * offset hour 00-23 / offset minute 00-59. Invalid calendar dates such as
 * `2024-02-31` and out-of-range components such as `T24:00:00` are
 * rejected. Accepted strings are never normalized or rewritten.
 */
function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))?)?$/,
  );
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (match[4] !== undefined) {
    if (Number(match[4]) > 23) return false;
    if (Number(match[5]) > 59) return false;
    if (Number(match[6]) > 59) return false;
    if (match[7] !== undefined) {
      if (Number(match[8]) > 23) return false;
      if (Number(match[9]) > 59) return false;
    }
  }
  return true;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1];
}

/**
 * Reject YAML c0-control characters (0x00-0x1F) other than tab, LF, and
 * CR — which `quoteYaml` escapes — and DEL (0x7F). Control characters in
 * metadata are almost always corruption, so rejecting them keeps the
 * serializer trivially correct without adding escaping surface.
 */
function assertNoUnsafeControlChars(value: string, field: string): void {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const escapable = code === 0x09 || code === 0x0a || code === 0x0d;
    if ((code < 0x20 && !escapable) || code === 0x7f) {
      throw new Error(`buildFrontMatter: ${field} contains an unsafe control character`);
    }
  }
}

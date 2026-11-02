/**
 * Article slug generation (approved OpenSpec design; audit item B).
 *
 * Pure and deterministic: identical input always yields identical output.
 *
 * Steps (in order):
 * 1. Unicode normalization (NFKD).
 * 2. Removal of combining diacritical marks (e.g. `é` -> `e`).
 * 3. Lowercasing.
 * 4. Every run of characters outside `[a-z0-9]` (punctuation, whitespace,
 *    and anything non-Latin) is replaced by a single hyphen.
 * 5. Repeated hyphens are collapsed and leading/trailing hyphens removed.
 * 6. An empty result becomes `untitled`.
 *
 * Non-Latin scripts: Latin-alphabet text and their diacritics work as
 * expected; CJK and other non-Latin characters have no transliteration in
 * this implementation and are dropped (a title consisting solely of such
 * characters yields `untitled`). This matches the legacy `slugify`
 * behavior for CJK (characterized in the audit) while fixing the legacy
 * defects (case folding, apostrophes, `*`/`!`/`:` leaking into
 * filenames).
 *
 * Slug uniqueness and filename collision detection are intentionally out
 * of scope (article-creation workflow, later task).
 */

/** Fallback slug when no slug-eligible characters remain. */
export const SLUG_FALLBACK = 'untitled';

/**
 * Generate a filesystem-safe slug from a post title.
 *
 * Examples:
 * - `"Hello World"`       -> `"hello-world"`
 * - `"Café and Coffee"`   -> `"cafe-and-coffee"`
 * - `"  My First Post!  "`-> `"my-first-post"`
 * - `"!!!"`               -> `"untitled"`
 * - `"日本語"`             -> `"untitled"`
 */
export function generateSlug(title: string): string {
  const withoutDiacritics = title.normalize('NFKD').replace(/\p{M}/gu, '');
  const lowered = withoutDiacritics.toLowerCase();
  const slug = lowered
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : SLUG_FALLBACK;
}

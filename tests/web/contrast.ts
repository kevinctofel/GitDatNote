/**
 * GitDatNote 2.0 — WCAG 2.2 contrast utility (UI Task 1.2, test-only).
 *
 * Pure, deterministic implementation of the WCAG 2.x relative-luminance and
 * contrast-ratio formulae (WCAG 2.2 §1.4.3, "Understanding SC 1.4.3 Contrast
 * (Minimum)"): sRGB channels are linearized with the 0.04045 / 12.92 / 2.4
 * curve, relative luminance uses coefficients 0.2126 / 0.7152 / 0.0722, and
 * the contrast ratio is (Llighter + 0.05) / (Ldarker + 0.05).
 *
 * No dependencies. Consumed only by tests/web/contrast.test.ts.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const VAR_RE = /^var\((--[a-z0-9-]+)\)$/;

/** Parse a strict `#RRGGBB` color into 0–255 channels. */
export function parseHexColor(value: string): Rgb {
  const v = value.trim();
  if (!HEX_RE.test(v)) {
    throw new Error(
      `invalid hex color: ${JSON.stringify(value)} (expected #RRGGBB)`,
    );
  }
  return {
    r: parseInt(v.slice(1, 3), 16),
    g: parseInt(v.slice(3, 5), 16),
    b: parseInt(v.slice(5, 7), 16),
  };
}

/** sRGB channel 0–1 -> linear 0–1 (WCAG sRGB linearization). */
function linearize(channel01: number): number {
  return channel01 <= 0.04045
    ? channel01 / 12.92
    : ((channel01 + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance: L = 0.2126R + 0.7152G + 0.0722B (linear sRGB). */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHexColor(hex);
  return (
    0.2126 * linearize(r / 255) +
    0.7152 * linearize(g / 255) +
    0.0722 * linearize(b / 255)
  );
}

/**
 * WCAG contrast ratio (Llighter + 0.05) / (Ldarker + 0.05).
 * Unrounded; always within [1, 21]. Symmetric in its arguments.
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

export type TokenMap = Readonly<Record<string, string>>;

/**
 * Resolve a token name to its final `#RRGGBB` color within a flat token map.
 *
 * Supports exactly the current token contract: literal `#RRGGBB` values and
 * single `var(--token)` references (including chains). Fails clearly with a
 * descriptive error on:
 * - missing token names,
 * - invalid color formats (anything that is neither hex nor a var reference),
 * - unsupported var() forms (fallbacks, multiple values),
 * - cyclic variable references.
 */
export function resolveColor(
  name: string,
  tokens: TokenMap,
  stack: readonly string[] = [],
): string {
  if (stack.includes(name)) {
    throw new Error(
      `cyclic token reference: ${[...stack, name].join(" -> ")}`,
    );
  }
  const value = tokens[name];
  if (value === undefined) {
    const trail = stack.length > 0 ? ` (referenced from ${stack.join(" -> ")})` : "";
    throw new Error(`missing token reference: ${name}${trail}`);
  }
  const v = value.trim();
  if (HEX_RE.test(v)) {
    return v;
  }
  const varMatch = VAR_RE.exec(v);
  if (varMatch !== null) {
    return resolveColor(varMatch[1], tokens, [...stack, name]);
  }
  throw new Error(
    `unresolvable or unsupported color value for ${name}: ${JSON.stringify(
      value,
    )} (expected #RRGGBB or var(--token))`,
  );
}

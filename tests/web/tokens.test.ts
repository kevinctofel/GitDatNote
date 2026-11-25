import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ACCENT_TOKENS,
  DEFAULT_PALETTE,
  LAYOUT_TOKENS,
  NEUTRAL_TOKENS,
  PALETTES,
  RADIUS_TOKENS,
  SHARED_TOKENS,
  SHADOW_TOKENS,
  SPACING_TOKENS,
  STATE_TOKENS,
  TYPOGRAPHY_TOKENS,
} from "../../src/web/theme/tokens";

/**
 * Task 1.1 token verification: deterministic CSS<->TypeScript correspondence
 * checks against the approved design.md §3 values. Contrast testing is
 * deliberately NOT done here — that is Task 1.2.
 */

const CSS_PATH = resolve(__dirname, "../../src/web/theme/tokens.css");

/** Approved exact values from design.md §3.1 (the acceptance reference). */
const APPROVED_ACCENTS: Record<string, { accent: string; soft: string; strong: string }> = {
  lavender: { accent: "#8271C8", soft: "#F2EFFB", strong: "#7566B4" },
  sage: { accent: "#6F947D", soft: "#EFF5F0", strong: "#597664" },
  ocean: { accent: "#668FAF", soft: "#EDF4F9", strong: "#577A95" },
  slate: { accent: "#758396", soft: "#F0F2F5", strong: "#697687" },
  clay: { accent: "#B68774", soft: "#F8F0EB", strong: "#926C5D" },
  teal: { accent: "#4E9293", soft: "#EAF5F4", strong: "#427C7D" },
};

interface CssBlock {
  selector: string;
  /** token name -> declaration value (later declaration of the same name wins) */
  tokens: Map<string, string>;
}

/** Normalize a token value for comparison: collapse whitespace, lowercase. */
function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Minimal deterministic CSS block parser: returns each top-level or
 * media-scoped rule as {selector, tokens}. Handles nested @media blocks by
 * tagging the inner selector with the media condition. Comments are
 * stripped first; the token stylesheet contains no other at-rules.
 */
function parseCssBlocks(css: string): CssBlock[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks: CssBlock[] = [];

  function walk(text: string, media: string | null): void {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open === -1) break;
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === "{") depth += 1;
        else if (text[j] === "}") depth -= 1;
        j += 1;
      }
      const header = text.slice(i, open).trim();
      const body = text.slice(open + 1, j - 1);
      if (header.startsWith("@media")) {
        walk(body, `@media ${header.slice(6).trim()}`);
      } else if (header) {
        const selector = media ? `${media} >> ${header}` : header;
        const tokens = new Map<string, string>();
        for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
          tokens.set(m[1], m[2].trim());
        }
        blocks.push({ selector, tokens });
      }
      i = j;
    }
  }

  walk(source, null);
  return blocks;
}

/** Merge all blocks matching a selector (later declarations win). */
function blockFor(blocks: CssBlock[], selector: string): CssBlock {
  const merged = new Map<string, string>();
  for (const b of blocks) {
    if (b.selector === selector) {
      for (const [name, value] of b.tokens) merged.set(name, value);
    }
  }
  if (merged.size === 0) {
    throw new Error(`no CSS block found for selector: ${selector}`);
  }
  return { selector, tokens: merged };
}

const blocks = parseCssBlocks(readFileSync(CSS_PATH, "utf8"));

const LIGHT_SELECTOR = ":root";
const DARK_SELECTOR = ':root[data-theme="dark"]';
const LIGHT_OVERRIDE_SELECTOR = ':root[data-theme="light"]';
const SYSTEM_DARK_SELECTOR =
  ':root:not([data-theme="light"])'; // inside @media (prefers-color-scheme: dark)
const SYSTEM_DARK_BLOCK = blockFor(blocks, `@media (prefers-color-scheme: dark) >> ${SYSTEM_DARK_SELECTOR}`);

const ALL_TOKENS = new Set<string>();
for (const b of blocks) {
  for (const name of b.tokens.keys()) ALL_TOKENS.add(name);
}

describe("tokens.css: required token names exist", () => {
  it("declares every token name used by the TypeScript module", () => {
    const expected = new Set<string>([
      ...Object.keys(NEUTRAL_TOKENS.light),
      ...Object.keys(STATE_TOKENS.light),
      ...Object.keys(ACCENT_TOKENS[DEFAULT_PALETTE]),
      ...Object.keys(TYPOGRAPHY_TOKENS),
      ...Object.keys(SPACING_TOKENS),
      ...Object.keys(RADIUS_TOKENS),
      ...Object.keys(SHADOW_TOKENS),
      ...Object.keys(LAYOUT_TOKENS),
    ]);
    const missing = [...expected].filter((name) => !ALL_TOKENS.has(name));
    expect(missing).toEqual([]);
  });
});

describe("tokens.css: typography tokens are independently usable", () => {
  const lightBlock = blockFor(blocks, LIGHT_SELECTOR);

  /** The approved size/line-height pairs from design.md §3.2. */
  const APPROVED_PAIRS: Array<{ name: string; size: string; lineHeight: string }> = [
    { name: "--text-xs", size: "12px", lineHeight: "1.4" },
    { name: "--text-sm", size: "14px", lineHeight: "1.5" },
    { name: "--text-md", size: "16px", lineHeight: "1.6" },
    { name: "--text-lg", size: "20px", lineHeight: "1.4" },
    { name: "--text-xl", size: "24px", lineHeight: "1.3" },
    { name: "--editor-body", size: "17px", lineHeight: "1.75" },
    { name: "--editor-body-rendered", size: "18px", lineHeight: "1.75" },
  ];

  const LENGTH_RE = /^\d+(\.\d+)?(px|rem|em)$/;
  const UNITLESS_RE = /^\d+(\.\d+)?$/;

  for (const { name, size, lineHeight } of APPROVED_PAIRS) {
    const lhName = `${name}-line-height`;

    it(`"${name}" is a valid CSS length in both CSS and TS`, () => {
      const cssValue = lightBlock.tokens.get(name) ?? "";
      const tsValue = TYPOGRAPHY_TOKENS[name] ?? "";
      expect(LENGTH_RE.test(cssValue), `CSS ${name} = ${cssValue}`).toBe(true);
      expect(LENGTH_RE.test(tsValue), `TS ${name} = ${tsValue}`).toBe(true);
      expect(normalize(cssValue)).toBe(normalize(tsValue));
    });

    it(`"${lhName}" is a valid unitless number in both CSS and TS`, () => {
      const cssValue = lightBlock.tokens.get(lhName) ?? "";
      const tsValue = TYPOGRAPHY_TOKENS[lhName] ?? "";
      expect(UNITLESS_RE.test(cssValue), `CSS ${lhName} = ${cssValue}`).toBe(true);
      expect(UNITLESS_RE.test(tsValue), `TS ${lhName} = ${tsValue}`).toBe(true);
      expect(normalize(cssValue)).toBe(normalize(tsValue));
    });

    it(`"${name}" preserves the approved ${size} / ${lineHeight} pair`, () => {
      expect(normalize(lightBlock.tokens.get(name) ?? "")).toBe(normalize(size));
      expect(normalize(lightBlock.tokens.get(`${name}-line-height`) ?? "")).toBe(
        normalize(lineHeight),
      );
      expect(TYPOGRAPHY_TOKENS[name]).toBe(size);
      expect(TYPOGRAPHY_TOKENS[`${name}-line-height`]).toBe(lineHeight);
    });
  }

  it("editor measure remains 70ch in both CSS and TS", () => {
    expect(normalize(lightBlock.tokens.get("--editor-measure") ?? "")).toBe("70ch");
    expect(TYPOGRAPHY_TOKENS["--editor-measure"]).toBe("70ch");
  });

  it("no combined 'size / line-height' strings remain", () => {
    const combined = [...ALL_TOKENS]
      .map((name) => ({ name, value: lightBlock.tokens.get(name) ?? "" }))
      .filter(({ name }) => name.includes("text") || name.startsWith("--editor"))
      .filter(({ value }) => value.includes("/"));
    expect(combined.map((entry) => entry.name)).toEqual([]);
  });
});

describe("tokens.css: all six palettes are represented", () => {
  for (const palette of PALETTES) {
    it(`palette "${palette}" provides accent, soft, strong, and soft-dark tokens`, () => {
      const selector =
        palette === DEFAULT_PALETTE
          ? LIGHT_SELECTOR
          : `:root[data-palette="${palette}"]`;
      const block = blockFor(blocks, selector);
      for (const name of Object.keys(ACCENT_TOKENS[palette])) {
        expect(block.tokens.has(name), `${selector} is missing ${name}`).toBe(true);
      }
    });
  }
});

describe("tokens.css: exact approved accent values are preserved", () => {
  for (const palette of PALETTES) {
    it(`palette "${palette}" matches the design.md §3.1 approved values`, () => {
      const selector =
        palette === DEFAULT_PALETTE
          ? LIGHT_SELECTOR
          : `:root[data-palette="${palette}"]`;
      const block = blockFor(blocks, selector);
      const approved = APPROVED_ACCENTS[palette];
      expect(normalize(block.tokens.get("--accent") ?? "")).toBe(
        normalize(approved.accent),
      );
      expect(normalize(block.tokens.get("--accent-soft") ?? "")).toBe(
        normalize(approved.soft),
      );
      expect(normalize(block.tokens.get("--accent-strong") ?? "")).toBe(
        normalize(approved.strong),
      );
    });
  }
});

describe("tokens.css: light and dark token sets are complete", () => {
  const lightBlock = blockFor(blocks, LIGHT_SELECTOR);
  const darkBlock = blockFor(blocks, DARK_SELECTOR);
  const lightOverride = blockFor(blocks, LIGHT_OVERRIDE_SELECTOR);

  const NEUTRAL_NAMES = Object.keys(NEUTRAL_TOKENS.light);
  const STATE_NAMES = Object.keys(STATE_TOKENS.light);

  for (const name of [...NEUTRAL_NAMES, ...STATE_NAMES]) {
    it(`"${name}" exists in both light and dark sets`, () => {
      expect(lightBlock.tokens.has(name)).toBe(true);
      expect(darkBlock.tokens.has(name)).toBe(true);
    });
  }

  it("explicit light mode re-declares the light values (OS-dark override protection)", () => {
    for (const name of [...NEUTRAL_NAMES, ...STATE_NAMES]) {
      expect(normalize(lightOverride.tokens.get(name) ?? "")).toBe(
        normalize(lightBlock.tokens.get(name) ?? ""),
      );
    }
  });

  it("system (OS-dark) mode matches the explicit dark values", () => {
    for (const name of [...NEUTRAL_NAMES, ...STATE_NAMES]) {
      expect(normalize(SYSTEM_DARK_BLOCK.tokens.get(name) ?? "")).toBe(
        normalize(darkBlock.tokens.get(name) ?? ""),
      );
    }
  });
});

describe("tokens.css <-> tokens.ts correspondence", () => {
  const lightBlock = blockFor(blocks, LIGHT_SELECTOR);
  const darkBlock = blockFor(blocks, DARK_SELECTOR);

  function assertValues(cssBlock: CssBlock, tsTokens: Record<string, string>, label: string) {
    for (const [name, expected] of Object.entries(tsTokens)) {
      const actual = cssBlock.tokens.get(name);
      expect(normalize(actual ?? ""), `${label}: ${name}`).toBe(normalize(expected));
    }
  }

  function assertNoOrphans(cssBlock: CssBlock, tsNames: Set<string>, label: string) {
    const orphan = [...cssBlock.tokens.keys()].filter((n) => !tsNames.has(n));
    expect(orphan, `${label}: CSS tokens missing from the TS module`).toEqual([]);
  }

  it("shared tokens (typography, spacing, radius, shadow, layout) match on :root", () => {
    assertValues(lightBlock, SHARED_TOKENS, ":root shared");
  });

  it("the full :root block matches the shared + light + default-palette TS sets", () => {
    const rootTokens = {
      ...SHARED_TOKENS,
      ...NEUTRAL_TOKENS.light,
      ...STATE_TOKENS.light,
      ...ACCENT_TOKENS[DEFAULT_PALETTE],
    };
    assertValues(lightBlock, rootTokens, ":root");
    assertNoOrphans(lightBlock, new Set(Object.keys(rootTokens)), ":root");
  });

  it("dark neutral + state tokens match on the explicit dark selector", () => {
    const darkTokens = { ...NEUTRAL_TOKENS.dark, ...STATE_TOKENS.dark };
    assertValues(darkBlock, darkTokens, ":root[data-theme=dark]");
    assertNoOrphans(darkBlock, new Set(Object.keys(darkTokens)), ":root[data-theme=dark]");
  });

  it("each palette's accent tokens match its CSS palette block", () => {
    for (const palette of PALETTES) {
      const selector =
        palette === DEFAULT_PALETTE
          ? LIGHT_SELECTOR
          : `:root[data-palette="${palette}"]`;
      const cssBlock = blockFor(blocks, selector);
      assertValues(cssBlock, ACCENT_TOKENS[palette], palette);
      if (palette !== DEFAULT_PALETTE) {
        // Dedicated palette blocks carry exactly the four accent tokens.
        assertNoOrphans(cssBlock, new Set(Object.keys(ACCENT_TOKENS[palette])), palette);
      }
    }
  });
});

describe("tokens.css: theme selector contract", () => {
  it("defines explicit dark, explicit light, and media-scoped system-dark selectors", () => {
    const selectors = new Set(blocks.map((b) => b.selector));
    expect(selectors.has(DARK_SELECTOR)).toBe(true);
    expect(selectors.has(LIGHT_OVERRIDE_SELECTOR)).toBe(true);
    expect(selectors.has(`@media (prefers-color-scheme: dark) >> ${SYSTEM_DARK_SELECTOR}`)).toBe(
      true,
    );
  });

  it("system dark tokens never apply to an explicit light root", () => {
    // The media-scoped dark block is written against :root:not([data-theme="light"]),
    // so it cannot match an explicit light root by construction.
    expect(SYSTEM_DARK_SELECTOR).toBe(':root:not([data-theme="light"])');
    // ...and the explicit light block keeps light surface values:
    const lightBlock = blockFor(blocks, LIGHT_OVERRIDE_SELECTOR);
    expect(normalize(lightBlock.tokens.get("--surface-app") ?? "")).toBe(
      normalize(NEUTRAL_TOKENS.light["--surface-app"]),
    );
  });
});

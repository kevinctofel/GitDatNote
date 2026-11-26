import { describe, it, expect } from "vitest";
import {
  ACCENT_ON_APP_TOKENS,
  ACCENT_TOKENS,
  NEUTRAL_TOKENS,
  PALETTES,
  SHARED_TOKENS,
  STATE_TOKENS,
  resolveFocusRing,
} from "../../src/web/theme/tokens";
import type { Palette, ThemeMode } from "../../src/web/theme/tokens";
import {
  contrastRatio,
  relativeLuminance,
  resolveColor,
} from "./contrast";

/**
 * Task 1.2 — WCAG 2.2 AA contrast validation for the implemented tokens.
 *
 * Source of truth: the published TypeScript token exports in
 * `src/web/theme/tokens.ts` (SHARED_TOKENS, NEUTRAL_TOKENS, STATE_TOKENS,
 * ACCENT_TOKENS, ACCENT_ON_APP_TOKENS, resolveFocusRing).
 * CSS-variable references such as `--focus-ring: var(--accent)` are resolved
 * to the selected palette's actual colors before any calculation.
 *
 * All ratios are unrounded for assertions; rounding appears only in the
 * human-readable matrix log. Thresholds are the Task 1.2 requirements:
 * primary-button label (`--text-on-accent-strong`) on `--accent-strong`
 * ≥ 4.5:1, body text on `--surface-app` / `--surface-panel` ≥ 4.5:1,
 * accent icon/large text (`--accent-on-app`) on neutral surfaces ≥ 3:1,
 * focus ring (`--focus-ring`) ≥ 3:1 against adjacent neutral surfaces.
 *
 * Task 1.2 scoped exceptions — the raw brand accent is not appropriate for
 * every foreground pairing:
 * - Primary buttons use the dedicated `--text-on-accent-strong` token
 *   (#FFFFFF both modes) — NOT the general-purpose `--text-inverse`
 *   token, which measures below 4.5:1 in 10 of the 12 palette × mode
 *   combinations (see the "regression pairing" describe below).
 * - Accent icons/large text and focus rings in Clay light: raw Clay
 *   #B68774 measures 2.91:1 on the light app surface #F7F6FA, so the
 *   approved Clay `--accent-strong` (#926C5D, 4.31:1) is used there via
 *   `ACCENT_ON_APP_TOKENS` / `resolveFocusRing`. All other combinations
 *   keep the raw accent.
 *
 * NOTE: this is token-level color contrast only. Full rendered focus-indicator
 * accessibility (2px ring dimensions, offset, interaction with component
 * backgrounds) is verified by the later UI accessibility pass (Task 2.4 /
 * 7.2), not here.
 */

const MODES: readonly ThemeMode[] = ["light", "dark"];

/** Flat resolved token map for one palette × mode combination. */
function tokenMapFor(palette: Palette, mode: ThemeMode): Record<string, string> {
  return {
    ...SHARED_TOKENS,
    ...NEUTRAL_TOKENS[mode],
    ...STATE_TOKENS[mode],
    ...ACCENT_TOKENS[palette],
    // Task 1.2 semantic tokens (design.md §3.1): each measured context
    // uses the dedicated foreground token the design now prescribes —
    // not raw --accent or the general-purpose --text-inverse.
    "--accent-on-app": ACCENT_ON_APP_TOKENS[palette][mode],
    "--focus-ring": resolveFocusRing(palette, mode),
  };
}

interface ContrastRow {
  palette: Palette;
  mode: ThemeMode;
  check: string;
  fgToken: string;
  bgToken: string;
  /** Resolved foreground color (#RRGGBB). */
  fg: string;
  /** Resolved background color (#RRGGBB). */
  bg: string;
  /** Unrounded WCAG contrast ratio. */
  ratio: number;
  /** Required minimum ratio. */
  min: number;
}

function computeRow(
  palette: Palette,
  mode: ThemeMode,
  check: string,
  fgToken: string,
  bgToken: string,
  min: number,
): ContrastRow {
  const tokens = tokenMapFor(palette, mode);
  const fg = resolveColor(fgToken, tokens);
  const bg = resolveColor(bgToken, tokens);
  return {
    palette,
    mode,
    check,
    fgToken,
    bgToken,
    fg,
    bg,
    ratio: contrastRatio(fg, bg),
    min,
  };
}

/** Human-readable failure message identifying every relevant value. */
function rowMessage(row: ContrastRow): string {
  return (
    `palette=${row.palette} mode=${row.mode} check="${row.check}": ` +
    `foreground ${row.fgToken} resolved to ${row.fg} on background ` +
    `${row.bgToken} resolved to ${row.bg} = ${row.ratio.toFixed(6)}:1, ` +
    `required >= ${row.min}:1`
  );
}

/**
 * The six required Task 1.2 checks, each measuring the SEMANTIC foreground
 * token the updated design contract prescribes for that context
 * (design.md §3.1):
 * - primary-button label: dedicated `--text-on-accent-strong` (#FFFFFF both
 *   modes) — NOT the general-purpose `--text-inverse` token, which measures
 *   below 4.5:1 in 10 of the 12 palette × mode combinations (see the
 *   "regression pairing" describe below)
 * - body text: `--text-primary`
 * - accent icons/large text on `--surface-app`: `--accent-on-app` (raw
 *   `--accent` in 11 of 12 combinations; the approved Clay
 *   `--accent-strong` in the scoped Clay light exception)
 * - accent icons/large text on `--surface-panel`: raw `--accent` (all 12
 *   combinations pass 3:1 on the panel surface)
 * - focus ring: `--focus-ring` (raw accent in 11 of 12 combinations; the
 *   approved Clay `--accent-strong` in the scoped Clay light exception)
 */
const CHECKS: ReadonlyArray<{
  check: string;
  fgToken: string;
  bgToken: string;
  min: number;
}> = [
  {
    check: "primary-button label on --accent-strong",
    fgToken: "--text-on-accent-strong",
    bgToken: "--accent-strong",
    min: 4.5,
  },
  {
    check: "body text on --surface-panel",
    fgToken: "--text-primary",
    bgToken: "--surface-panel",
    min: 4.5,
  },
  {
    check: "--accent icon/large text on --surface-panel",
    fgToken: "--accent",
    bgToken: "--surface-panel",
    min: 3,
  },
  {
    check: "--accent-on-app icon/large text on --surface-app",
    fgToken: "--accent-on-app",
    bgToken: "--surface-app",
    min: 3,
  },
  {
    check: "focus ring on --surface-panel",
    fgToken: "--focus-ring",
    bgToken: "--surface-panel",
    min: 3,
  },
  {
    check: "focus ring on --surface-app",
    fgToken: "--focus-ring",
    bgToken: "--surface-app",
    min: 3,
  },
];

/** Complete matrix: 6 palettes × 2 modes × 6 checks = 72 rows. */
const ROWS: ContrastRow[] = [];
for (const palette of PALETTES) {
  for (const mode of MODES) {
    for (const c of CHECKS) {
      ROWS.push(computeRow(palette, mode, c.check, c.fgToken, c.bgToken, c.min));
    }
  }
}

describe("WCAG contrast calculator correctness", () => {
  it("black on white is exactly 21:1", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBe(21);
  });

  it("identical colors are exactly 1:1", () => {
    expect(contrastRatio("#000000", "#000000")).toBe(1);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBe(1);
    expect(contrastRatio("#8271C8", "#8271C8")).toBe(1);
  });

  it("is symmetric in its two arguments", () => {
    expect(contrastRatio("#F7F6FA", "#597664")).toBe(
      contrastRatio("#597664", "#F7F6FA"),
    );
    expect(contrastRatio("#17161B", "#7566B4")).toBe(
      contrastRatio("#7566B4", "#17161B"),
    );
  });

  it("relative luminance of pure gray #808080 lies between 0 and 0.5", () => {
    // sRGB linearization is non-linear: #808080 is below 0.5 luminance.
    const l = relativeLuminance("#808080");
    expect(l).toBeGreaterThan(0);
    expect(l).toBeLessThan(0.5);
  });

  it("reproduces the design.md §3.1 white-on-strong measurements (±0.01)", () => {
    // These pin the calculator to the design document's own measurements
    // against pure white — establishing that the calculator, not the
    // tokens, is the variable when the implemented inverse-text label
    // differs from pure white.
    const documented: ReadonlyArray<[Palette, number]> = [
      ["lavender", 4.87],
      ["sage", 5.0],
      ["ocean", 4.54],
      ["slate", 4.62],
      ["clay", 4.64],
      ["teal", 4.76],
    ];
    for (const [palette, expected] of documented) {
      const strong = ACCENT_TOKENS[palette]["--accent-strong"];
      const ratio = contrastRatio("#FFFFFF", strong);
      expect(
        Math.abs(ratio - expected),
        `white on ${palette} --accent-strong ${strong}: measured ${ratio.toFixed(
          4,
        )} vs documented ${expected}`,
      ).toBeLessThan(0.01);
    }
  });
});

describe("token reference resolution", () => {
  it("resolves --focus-ring and --accent-on-app per the Task 1.2 scoped exception", () => {
    for (const palette of PALETTES) {
      for (const mode of MODES) {
        // Raw accent everywhere except the one scoped combination
        // (Clay light), where the approved Clay --accent-strong stands in.
        const expected =
          palette === "clay" && mode === "light"
            ? ACCENT_TOKENS.clay["--accent-strong"]
            : ACCENT_TOKENS[palette]["--accent"];
        expect(
          resolveColor("--focus-ring", tokenMapFor(palette, mode)),
          `focus-ring ${palette} ${mode}`,
        ).toBe(expected);
        expect(
          resolveColor("--accent-on-app", tokenMapFor(palette, mode)),
          `accent-on-app ${palette} ${mode}`,
        ).toBe(expected);
      }
    }
  });

  it("resolves chains of var() references", () => {
    expect(
      resolveColor("--a", { "--a": "var(--b)", "--b": "var(--c)", "--c": "#ABCDEF" }),
    ).toBe("#ABCDEF");
  });

  it("fails on a missing token reference", () => {
    expect(() =>
      resolveColor("--does-not-exist", { "--a": "#111111" }),
    ).toThrow(/missing token reference: --does-not-exist/);
  });

  it("fails when a referenced token is absent from the map", () => {
    expect(() =>
      resolveColor("--a", { "--a": "var(--absent)" }),
    ).toThrow(/missing token reference: --absent/);
  });

  it("fails on cyclic variable references", () => {
    expect(() =>
      resolveColor("--a", { "--a": "var(--b)", "--b": "var(--a)" }),
    ).toThrow(/cyclic token reference: --a -> --b -> --a/);
  });

  it("fails on unsupported var() fallback forms", () => {
    expect(() =>
      resolveColor("--a", { "--a": "var(--b, #FFFFFF)", "--b": "#111111" }),
    ).toThrow(/unresolvable or unsupported color value for --a/);
  });

  it("fails on invalid color formats", () => {
    expect(() =>
      resolveColor("--bad", { "--bad": "not-a-color" }),
    ).toThrow(/unresolvable or unsupported color value for --bad/);
    expect(() => relativeLuminance("zzz")).toThrow(/invalid hex color/);
    expect(() => relativeLuminance("#12345")).toThrow(/invalid hex color/);
  });
});

describe("independently verified reference pairs (WCAG formula)", () => {
  // Externally verified values of the standard WCAG 2.x contrast formula
  // for exact color pairs. These pin the calculator independently of any
  // token export and reproduce the Task 1.2 reference evidence:
  //   #201E26 on #FFFFFF  ≈ 16.46913:1
  //   #EDEBEF on #201F26  ≈ 13.79389:1
  //   #8271C8 on #FFFFFF  ≈ 4.08144:1
  //   #8271C8 on #F7F6FA  ≈ 3.79332:1
  //   #B68774 on #F7F6FA  ≈ 2.91012:1
  const pairs: ReadonlyArray<[string, string, number]> = [
    ["#201E26", "#FFFFFF", 16.46913],
    ["#EDEBEF", "#201F26", 13.79389],
    ["#8271C8", "#FFFFFF", 4.08144],
    ["#8271C8", "#F7F6FA", 3.79332],
    ["#B68774", "#F7F6FA", 2.91012],
  ];
  for (const [fg, bg, expected] of pairs) {
    it(`${fg} on ${bg} is ${expected}:1`, () => {
      expect(contrastRatio(fg, bg), `${fg} on ${bg}`).toBeCloseTo(expected, 4);
    });
  }
});

describe("matrix invariants (regression guards)", () => {
  // Guards against the two defects found in the previously reported matrix:
  // body-on-panel contrast varying across palettes, and accent/ring
  // measurements collapsing to identical panel and app values.
  it("body-on-panel contrast is identical across all palettes within each mode", () => {
    for (const mode of MODES) {
      const bodyRows = ROWS.filter(
        (r) => r.mode === mode && r.check === "body text on --surface-panel",
      );
      const first = bodyRows[0].ratio;
      for (const row of bodyRows) {
        expect(
          row.ratio,
          `body-on-panel in ${mode} ${row.palette} = ${row.ratio} differs from ` +
            `${first} (${row.fgToken}=${row.fg} on ${row.bgToken}=${row.bg}); ` +
            `the neutral tokens are palette-independent`,
        ).toBe(first);
      }
    }
  });

  it("panel and app surfaces are measured independently in both modes", () => {
    for (const mode of MODES) {
      const panel = NEUTRAL_TOKENS[mode]["--surface-panel"];
      const app = NEUTRAL_TOKENS[mode]["--surface-app"];
      expect(panel, `${mode} surface tokens`).not.toBe(app);
      for (const palette of PALETTES) {
        // (panel foreground token, app foreground token) pairs — the app
        // accent row uses the semantic --accent-on-app token (Task 1.2).
        for (const [panelFg, appFg] of [
          ["--accent", "--accent-on-app"],
          ["--focus-ring", "--focus-ring"],
        ]) {
          const onPanel = ROWS.find(
            (r) =>
              r.mode === mode &&
              r.palette === palette &&
              r.fgToken === panelFg &&
              r.bgToken === "--surface-panel",
          )!;
          const onApp = ROWS.find(
            (r) =>
              r.mode === mode &&
              r.palette === palette &&
              r.fgToken === appFg &&
              r.bgToken === "--surface-app",
          )!;
          expect(
            onPanel.ratio,
            `${mode} ${palette}: ${panelFg} on panel (${onPanel.bg}) = ${onPanel.ratio} ` +
              `equals ${appFg} on app (${onApp.bg}) = ${onApp.ratio} although the ` +
              `surfaces differ`,
          ).not.toBe(onApp.ratio);
        }
      }
    }
  });
});

describe("regression pairing: general-purpose inverse text on --accent-strong (Task 1.2)", () => {
  // The design contract prescribes the dedicated `--text-on-accent-strong`
  // token (#FFFFFF both modes, ≥ 4.5:1 in all 12 combinations) for
  // primary-button labels. These guards document WHY the general-purpose
  // `--text-inverse` token must not be substituted for that pairing: in
  // the 10 combinations below it measures below 4.5:1 against
  // `--accent-strong` (only lavender light at 4.52:1 and sage light at
  // 4.65:1 pass). The inverse token remains correct for its own
  // general-purpose contexts — it is a different semantic token.
  const INV_PAIRING_FAILURES: ReadonlyArray<{ palette: Palette; mode: ThemeMode }> = [
    { palette: "ocean", mode: "light" },
    { palette: "slate", mode: "light" },
    { palette: "clay", mode: "light" },
    { palette: "teal", mode: "light" },
    { palette: "lavender", mode: "dark" },
    { palette: "sage", mode: "dark" },
    { palette: "ocean", mode: "dark" },
    { palette: "slate", mode: "dark" },
    { palette: "clay", mode: "dark" },
    { palette: "teal", mode: "dark" },
  ];

  it.each(INV_PAIRING_FAILURES)(
    "fails for $palette/$mode: --text-inverse on --accent-strong < 4.5:1",
    ({ palette, mode }) => {
      const inv = NEUTRAL_TOKENS[mode]["--text-inverse"];
      const bg = ACCENT_TOKENS[palette]["--accent-strong"];
      expect(
        contrastRatio(inv, bg),
        `${palette}/${mode}: --text-inverse ${inv} on --accent-strong ${bg}`,
      ).toBeLessThan(4.5);
      // The prescribed token in the current matrix row still passes.
      const row = ROWS.find(
        (r) =>
          r.mode === mode &&
          r.palette === palette &&
          r.check === "primary-button label on --accent-strong",
      )!;
      expect(
        row.ratio,
        `${palette}/${mode}: prescribed --text-on-accent-strong row`,
      ).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each([
    { palette: "lavender", mode: "light" },
    { palette: "sage", mode: "light" },
  ])(
    "passes for $palette/$mode: --text-inverse on --accent-strong >= 4.5:1",
    ({ palette, mode }) => {
      const inv = NEUTRAL_TOKENS[mode]["--text-inverse"];
      const bg = ACCENT_TOKENS[palette]["--accent-strong"];
      expect(
        contrastRatio(inv, bg),
        `${palette}/${mode}: --text-inverse ${inv} on --accent-strong ${bg}`,
      ).toBeGreaterThanOrEqual(4.5);
    },
  );
});

describe("WCAG contrast matrix: all six palettes × both modes (Task 1.2)", () => {
  for (const row of ROWS) {
    it(
      `[${row.mode} ${row.palette}] ${row.check}: ${row.fgToken} on ${row.bgToken} >= ${row.min}:1`,
      () => {
        expect(row.ratio, rowMessage(row)).toBeGreaterThanOrEqual(row.min);
      },
    );
  }
});

describe("measured contrast values (recorded evidence)", () => {
  it("logs the full 72-row palette × mode matrix with unrounded ratios", () => {
    const lines: string[] = [];
    for (const row of ROWS) {
      lines.push(
        [
          row.palette.padEnd(9),
          row.mode.padEnd(6),
          row.check.padEnd(42),
          `${row.fgToken}=${row.fg} on ${row.bgToken}=${row.bg}`,
          `${row.ratio.toFixed(4)}:1 (need >=${row.min}:1)`,
          row.ratio >= row.min ? "PASS" : "FAIL",
        ].join(" "),
      );
    }
    console.log(`\nWCAG contrast matrix (6 palettes × 2 modes × 6 checks):\n${lines.join("\n")}\n`);
    expect(ROWS.length).toBe(72);
  });
});

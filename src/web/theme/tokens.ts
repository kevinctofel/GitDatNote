/**
 * GitDatNote 2.0 — design tokens (UI Task 1.1).
 *
 * Typed mirror of `src/web/theme/tokens.css`. Both files must stay in
 * sync; `tests/web/tokens.test.ts` verifies the correspondence
 * deterministically. All values are verbatim from
 * `openspec/changes/design-gitdatnote-ui/design.md` §3 except where a
 * documented derivation is noted.
 *
 * This module is pure data: no browser globals, no imports from server
 * code, safe to use from tests and the future appearance state store
 * (Task 1.3).
 */

/** Appearance modes (independent of palette). */
export type ThemeMode = "light" | "dark";

/** The six approved accent palettes; `lavender` is the default. */
export type Palette =
  | "lavender"
  | "sage"
  | "ocean"
  | "slate"
  | "clay"
  | "teal";

export const PALETTES: readonly Palette[] = [
  "lavender",
  "sage",
  "ocean",
  "slate",
  "clay",
  "teal",
];

export const DEFAULT_PALETTE: Palette = "lavender";

/** Root data attributes consumed by the token selector contract. */
export const THEME_ATTRIBUTE = "data-theme" as const;
export const PALETTE_ATTRIBUTE = "data-palette" as const;

/** Neutral surface/text tokens, per appearance mode (design.md §3.1). */
export const NEUTRAL_TOKENS: Record<ThemeMode, Record<string, string>> = {
  light: {
    "--surface-app": "#F7F6FA",
    "--surface-panel": "#FFFFFF",
    "--surface-sunken": "#F6F5F8",
    "--border": "#E4E2EA",
    "--border-strong": "#C9C6D2",
    "--text-primary": "#201E26",
    "--text-secondary": "#5C5866",
    "--text-tertiary": "#8A8694",
    "--text-inverse": "#F7F6FA",
  },
  dark: {
    "--surface-app": "#17161B",
    "--surface-panel": "#201F26",
    "--surface-sunken": "#141317",
    "--border": "#35333D",
    "--border-strong": "#4A4854",
    "--text-primary": "#EDEBEF",
    "--text-secondary": "#B4B1BD",
    "--text-tertiary": "#827F8C",
    "--text-inverse": "#17161B",
  },
};

/** State + focus tokens, per appearance mode (design.md §3.1). */
export const STATE_TOKENS: Record<ThemeMode, Record<string, string>> = {
  light: {
    "--success": "#3E7D52",
    "--success-soft": "#E7F3EC",
    "--error": "#B4443C",
    "--error-soft": "#FBEDEB",
    "--warning": "#9A6B21",
    "--warning-soft": "#F8F0E2",
    "--disabled-text": "#A6A3AF",
    "--disabled-surface": "#F0EEE9",
    "--focus-ring": "var(--accent)",
  },
  dark: {
    "--success": "#6FBF8E",
    "--success-soft": "#1E3226",
    "--error": "#E58C82",
    "--error-soft": "#3A201D",
    "--warning": "#D9A65B",
    "--warning-soft": "#33290F",
    "--disabled-text": "#6B6875",
    "--disabled-surface": "#26252C",
    "--focus-ring": "var(--accent)",
  },
};

/**
 * Per-palette accent tokens (design.md §3.1). `accentStrong` is the
 * measured ≥ 4.5:1 darkened variant used for small text on accent fills.
 * `accentSoftDark` is `accentSoft` alpha-composited at 15% (midpoint of the
 * approved 12–18% range) over the dark app surface `#17161B`; it is
 * consumed only in dark mode.
 */
export interface AccentTokens {
  "--accent": string;
  "--accent-soft": string;
  "--accent-strong": string;
  "--accent-soft-dark": string;
}

export const ACCENT_TOKENS: Record<Palette, AccentTokens> = {
  lavender: {
    "--accent": "#8271C8",
    "--accent-soft": "#F2EFFB",
    "--accent-strong": "#7566B4",
    "--accent-soft-dark": "#38373D",
  },
  sage: {
    "--accent": "#6F947D",
    "--accent-soft": "#EFF5F0",
    "--accent-strong": "#597664",
    "--accent-soft-dark": "#37373B",
  },
  ocean: {
    "--accent": "#668FAF",
    "--accent-soft": "#EDF4F9",
    "--accent-strong": "#577A95",
    "--accent-soft-dark": "#37373C",
  },
  slate: {
    "--accent": "#758396",
    "--accent-soft": "#F0F2F5",
    "--accent-strong": "#697687",
    "--accent-soft-dark": "#38373C",
  },
  clay: {
    "--accent": "#B68774",
    "--accent-soft": "#F8F0EB",
    "--accent-strong": "#926C5D",
    "--accent-soft-dark": "#39373A",
  },
  teal: {
    "--accent": "#4E9293",
    "--accent-soft": "#EAF5F4",
    "--accent-strong": "#427C7D",
    "--accent-soft-dark": "#37373C",
  },
};

/** Font stacks and text scale (design.md §3.2). Mode- and palette-independent. */
export const TYPOGRAPHY_TOKENS: Record<string, string> = {
  "--font-ui":
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  "--font-writing":
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  "--font-mono":
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  /* Text scale: size and line-height are independent, directly consumable
     custom properties (design.md §3.2, exact approved measurements). */
  "--text-xs": "12px",
  "--text-xs-line-height": "1.4",
  "--text-sm": "14px",
  "--text-sm-line-height": "1.5",
  "--text-md": "16px",
  "--text-md-line-height": "1.6",
  "--text-lg": "20px",
  "--text-lg-line-height": "1.4",
  "--text-xl": "24px",
  "--text-xl-line-height": "1.3",
  /* Markdown source (dominant) and rendered preview, 70ch centered. */
  "--editor-body": "17px",
  "--editor-body-line-height": "1.75",
  "--editor-body-rendered": "18px",
  "--editor-body-rendered-line-height": "1.75",
  "--editor-measure": "70ch",
};

/** 4px-based spacing rhythm (design.md §3.3). */
export const SPACING_TOKENS: Record<string, string> = {
  "--space-1": "4px",
  "--space-2": "8px",
  "--space-3": "12px",
  "--space-4": "16px",
  "--space-5": "24px",
  "--space-6": "32px",
};

export const RADIUS_TOKENS: Record<string, string> = {
  "--radius-sm": "8px",
  "--radius-md": "10px",
  "--radius-lg": "12px",
};

export const SHADOW_TOKENS: Record<string, string> = {
  "--shadow-sm": "0 1px 2px rgba(24,20,35,.06)",
  "--shadow-md": "0 2px 8px rgba(24,20,35,.10)",
  "--shadow-lg": "0 8px 24px rgba(24,20,35,.16)",
};

/** Layout measurements (design.md §3.3). */
export const LAYOUT_TOKENS: Record<string, string> = {
  "--sidebar-width": "248px",
  "--touch-target-min": "24px",
  "--touch-target-primary": "44px",
};

/**
 * Mode- and palette-independent tokens (declared on plain `:root`).
 * Used to verify the CSS/TypeScript correspondence in tests.
 */
export const SHARED_TOKENS: Record<string, string> = {
  ...TYPOGRAPHY_TOKENS,
  ...SPACING_TOKENS,
  ...RADIUS_TOKENS,
  ...SHADOW_TOKENS,
  ...LAYOUT_TOKENS,
};

import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useAppearance } from "../../theme/appearance";
import type { AppearanceMode } from "../../theme/appearance";
import { ACCENT_TOKENS, PALETTES } from "../../theme/tokens";
import type { Palette } from "../../theme/tokens";

const THEME_OPTIONS: ReadonlyArray<{ id: AppearanceMode; label: string }> = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
];

function paletteLabel(palette: Palette): string {
  if (palette === "lavender") {
    return "Lavender (Default)";
  }
  return palette.charAt(0).toUpperCase() + palette.slice(1);
}

/**
 * Appearance tab (UI Task 1.4). A three-card theme picker (Light, Dark,
 * System) and six accent swatches in the approved order drive the Task 1.3
 * `useAppearance` context, so every choice re-themes the whole app —
 * including this hub — immediately.
 */
export function AppearanceTab() {
  const { mode, palette, setMode, setPalette } = useAppearance();
  const [focusIndex, setFocusIndex] = useState(() =>
    Math.max(0, PALETTES.indexOf(palette)),
  );
  const swatchRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function selectSwatch(index: number): void {
    setPalette(PALETTES[index]);
    setFocusIndex(index);
  }

  /** Roving focus within the accent group: arrows (and Home/End) move
   *  focus; Enter/Space select via native button activation. */
  function handleSwatchKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void {
    let next: number | null = null;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (index + 1) % PALETTES.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (index - 1 + PALETTES.length) % PALETTES.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = PALETTES.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    setFocusIndex(next);
    swatchRefs.current[next]?.focus();
  }

  return (
    <div className="appearance">
      <h2 className="appearance-heading">Appearance</h2>
      <p className="appearance-description">
        Choose your theme and accent color for GitDatNote.
      </p>

      <section
        className="appearance-section"
        aria-labelledby="appearance-theme-heading"
      >
        <h3 id="appearance-theme-heading">Theme</h3>
        <div className="theme-grid" role="group" aria-label="Theme mode">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className="choice theme-choice"
              aria-pressed={mode === option.id}
              onClick={() => setMode(option.id)}
            >
              <ThemeIcon mode={option.id} />
              <span className="choice-label">{option.label}</span>
              {mode === option.id && (
                <span className="choice-current">Current</span>
              )}
            </button>
          ))}
        </div>
      </section>

      <section
        className="appearance-section"
        aria-labelledby="appearance-accent-heading"
      >
        <h3 id="appearance-accent-heading">Accent Color</h3>
        <p className="accent-hint">
          Used for buttons, navigation, and subtle interface accents.
        </p>
        <div className="accent-grid" role="group" aria-label="Accent color">
          {PALETTES.map((value, index) => (
            <button
              key={value}
              ref={(element) => {
                swatchRefs.current[index] = element;
              }}
              type="button"
              className="choice swatch"
              aria-pressed={palette === value}
              tabIndex={index === focusIndex ? 0 : -1}
              onClick={() => selectSwatch(index)}
              onKeyDown={(event) => handleSwatchKeyDown(event, index)}
            >
              <span
                className="swatch-dot"
                style={{
                  backgroundColor: ACCENT_TOKENS[value]["--accent"],
                }}
                aria-hidden="true"
              />
              <span className="choice-label">{paletteLabel(value)}</span>
              {palette === value && (
                <span className="choice-current">Current</span>
              )}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

/** Line icons for the theme cards: sun (Light), moon (Dark), device
 *  (System). */
function ThemeIcon({ mode }: { mode: AppearanceMode }) {
  const common = {
    "aria-hidden": true,
    focusable: "false" as const,
    width: 24,
    height: 24,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (mode === "light") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <line x1="12" y1="2" x2="12" y2="4" />
        <line x1="12" y1="20" x2="12" y2="22" />
        <line x1="4.93" y1="4.93" x2="6.34" y2="6.34" />
        <line x1="17.66" y1="17.66" x2="19.07" y2="19.07" />
        <line x1="2" y1="12" x2="4" y2="12" />
        <line x1="20" y1="12" x2="22" y2="12" />
        <line x1="4.93" y1="19.07" x2="6.34" y2="17.66" />
        <line x1="17.66" y1="6.34" x2="19.07" y2="4.93" />
      </svg>
    );
  }
  if (mode === "dark") {
    return (
      <svg {...common}>
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

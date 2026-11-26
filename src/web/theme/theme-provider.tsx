import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  APPEARANCE_STORAGE_KEY,
  AppearanceContext,
  DEFAULT_APPEARANCE,
  OS_DARK_MEDIA_QUERY,
} from "./appearance";
import type {
  AppearanceMode,
  AppearanceContextValue,
  EffectiveTheme,
} from "./appearance";
import {
  PALETTES,
  PALETTE_ATTRIBUTE,
  THEME_ATTRIBUTE,
} from "./tokens";
import type { Palette } from "./tokens";

interface AppearancePreferences {
  mode: AppearanceMode;
  palette: Palette;
}

function isAppearanceMode(value: unknown): value is AppearanceMode {
  return value === "light" || value === "dark" || value === "system";
}

function isPalette(value: unknown): value is Palette {
  return typeof value === "string" && (PALETTES as readonly string[]).includes(value);
}

/**
 * Parse stored preferences; documented defaults apply for missing or invalid
 * fields (spec "Persistence with graceful fallback"). Never throws.
 */
function parseStored(raw: string | null): AppearancePreferences {
  if (!raw) return { ...DEFAULT_APPEARANCE };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_APPEARANCE };
  }
  const record = parsed as Record<string, unknown>;
  return {
    mode: isAppearanceMode(record.mode) ? record.mode : DEFAULT_APPEARANCE.mode,
    palette: isPalette(record.palette) ? record.palette : DEFAULT_APPEARANCE.palette,
  };
}

/**
 * Read stored preferences. If storage access itself throws (private mode,
 * quota, blocked access), the provider stays usable in memory for the
 * session: defaults apply and `storageUsable` records that writes must not
 * even be attempted.
 */
function readStored(): { prefs: AppearancePreferences; storageUsable: boolean } {
  try {
    return {
      prefs: parseStored(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)),
      storageUsable: true,
    };
  } catch {
    return { prefs: { ...DEFAULT_APPEARANCE }, storageUsable: false };
  }
}

function osPrefersDark(): boolean {
  try {
    return window.matchMedia(OS_DARK_MEDIA_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * ThemeProvider (design.md D-02).
 *
 * - Holds `{mode, palette}` in context with independent setters for the
 *   later Appearance tab (task 1.4).
 * - Persists both as JSON under `gitdatnote.appearance.v1`; validates stored
 *   data and falls back to documented defaults (system + lavender) for
 *   missing or invalid preferences.
 * - Graceful fallback: any storage read/write failure leaves the provider
 *   fully usable in memory; once a write fails, later changes apply without
 *   retrying storage (no repeated write attempts).
 * - Applies the Task 1.1 CSS selector contract to `document.documentElement`:
 *   explicit selections set `data-theme="light"|"dark"`, System removes
 *   `data-theme` so the existing `@media (prefers-color-scheme: dark)` rule
 *   applies, and the palette uses the existing `data-palette` selectors.
 * - In System, subscribes to `matchMedia('(prefers-color-scheme: dark)')`
 *   and re-applies live; explicit Light/Dark ignore OS changes; the listener
 *   is cleaned up when leaving System or unmounting, and the current OS
 *   preference is re-read when returning to System. OS-only changes never
 *   write storage.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(readStored);
  const [prefs, setPrefs] = useState<AppearancePreferences>(initial.prefs);
  const [osDark, setOsDark] = useState<boolean>(osPrefersDark);
  const storageUsableRef = useRef(initial.storageUsable);

  const setMode = useCallback((mode: AppearanceMode) => {
    setPrefs((prev) => (prev.mode === mode ? prev : { ...prev, mode }));
  }, []);

  const setPalette = useCallback((palette: Palette) => {
    setPrefs((prev) =>
      prev.palette === palette ? prev : { ...prev, palette },
    );
  }, []);

  // Persist preference changes (never the initial read-back) and stop trying
  // once storage has failed once for this session.
  useEffect(() => {
    if (prefs === initial.prefs) return;
    if (!storageUsableRef.current) return;
    try {
      window.localStorage.setItem(
        APPEARANCE_STORAGE_KEY,
        JSON.stringify(prefs),
      );
    } catch {
      storageUsableRef.current = false;
    }
  }, [prefs, initial]);

  // System mode: track the OS appearance live.
  useEffect(() => {
    if (prefs.mode !== "system") return;
    let mql: MediaQueryList | null = null;
    try {
      mql = window.matchMedia(OS_DARK_MEDIA_QUERY);
    } catch {
      mql = null;
    }
    if (!mql) return;
    // Re-read the current OS preference when entering (or returning to) System.
    setOsDark(mql.matches);
    const onChange = (event: MediaQueryListEvent) => {
      setOsDark(event.matches);
    };
    mql.addEventListener("change", onChange);
    return () => {
      mql.removeEventListener("change", onChange);
    };
  }, [prefs.mode]);

  // Apply the token selector contract (task 1.1) to the document root so all
  // screens and dialogs inherit the tokens.
  useEffect(() => {
    const root = document.documentElement;
    if (prefs.mode === "system") {
      root.removeAttribute(THEME_ATTRIBUTE);
    } else {
      root.setAttribute(THEME_ATTRIBUTE, prefs.mode);
    }
    root.setAttribute(PALETTE_ATTRIBUTE, prefs.palette);
  }, [prefs.mode, prefs.palette]);

  const effectiveTheme: EffectiveTheme =
    prefs.mode === "system" ? (osDark ? "dark" : "light") : prefs.mode;

  const value = useMemo<AppearanceContextValue>(
    () => ({
      mode: prefs.mode,
      palette: prefs.palette,
      effectiveTheme,
      setMode,
      setPalette,
    }),
    [prefs, effectiveTheme, setMode, setPalette],
  );

  return (
    <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>
  );
}

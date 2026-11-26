import { createContext, useContext } from "react";
import { DEFAULT_PALETTE } from "./tokens";
import type { Palette, ThemeMode } from "./tokens";

/** Appearance modes; independent of the accent palette (design.md D-02). */
export type AppearanceMode = ThemeMode | "system";

/** The theme tokens actually in force after resolving "system" against the OS. */
export type EffectiveTheme = ThemeMode;

/** Browser-local persistence key (design.md D-02). No backend involved. */
export const APPEARANCE_STORAGE_KEY = "gitdatnote.appearance.v1";

/** Media query for "System" mode (design.md D-02 / spec "Appearance modes"). */
export const OS_DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

/** Documented defaults: System + Lavender (design.md D-02). */
export const DEFAULT_APPEARANCE: { mode: AppearanceMode; palette: Palette } = {
  mode: "system",
  palette: DEFAULT_PALETTE,
};

export interface AppearanceContextValue {
  /** The stored appearance mode (including `system`). */
  mode: AppearanceMode;
  /** The stored accent palette. */
  palette: Palette;
  /** The mode resolved against the OS (`system` → the OS's current choice). */
  effectiveTheme: EffectiveTheme;
  /** Independent setter: changes mode, preserves the selected palette. */
  setMode: (mode: AppearanceMode) => void;
  /** Independent setter: changes palette, preserves the selected mode. */
  setPalette: (palette: Palette) => void;
}

/**
 * Context backing the ThemeProvider (design.md D-02). Kept in a
 * non-component module so the provider module only exports its component.
 */
export const AppearanceContext = createContext<AppearanceContextValue | null>(
  null,
);

/** Read the appearance preferences from the nearest ThemeProvider. */
export function useAppearance(): AppearanceContextValue {
  const context = useContext(AppearanceContext);
  if (!context) {
    throw new Error("useAppearance must be used within a ThemeProvider");
  }
  return context;
}

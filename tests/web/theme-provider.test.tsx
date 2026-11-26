// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "./test-utils";
import {
  APPEARANCE_STORAGE_KEY,
  useAppearance,
} from "../../src/web/theme/appearance";
import type { AppearanceMode } from "../../src/web/theme/appearance";
import type { Palette } from "../../src/web/theme/tokens";
import { ThemeProvider } from "../../src/web/theme/theme-provider";

/**
 * Captured context of the mounted provider, so tests can drive the
 * independent setters directly (no UI controls exist until task 1.4).
 */
let appearance: {
  mode: AppearanceMode;
  palette: Palette;
  effectiveTheme: "light" | "dark";
  setMode: (mode: AppearanceMode) => void;
  setPalette: (palette: Palette) => void;
} | null = null;

function Probe() {
  appearance = useAppearance();
  return (
    <div
      data-testid="probe"
      data-mode={appearance.mode}
      data-palette={appearance.palette}
      data-effective={appearance.effectiveTheme}
    />
  );
}

/** Controllable stand-in for `window.matchMedia('(prefers-color-scheme: dark)')`. */
function createFakeMql(initialMatches: boolean) {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const mql = {
    matches: initialMatches,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: (
      type: string,
      listener: (event: { matches: boolean }) => void,
    ) => {
      if (type === "change") listeners.add(listener);
    },
    removeEventListener: (
      type: string,
      listener: (event: { matches: boolean }) => void,
    ) => {
      if (type === "change") listeners.delete(listener);
    },
    setMatches: (matches: boolean) => {
      mql.matches = matches;
      for (const listener of [...listeners]) listener({ matches });
    },
    listenerCount: () => listeners.size,
  };
  return mql;
}

/**
 * In-memory localStorage for the happy-dom environment (this environment's
 * `window.localStorage` is undefined). Fresh per test; tests spy on its
 * methods to simulate storage failures.
 */
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

beforeEach(() => {
  const storage = new MemoryStorage();
  try {
    Object.defineProperty(window, "localStorage", {
      value: storage,
      configurable: true,
      writable: true,
    });
  } catch {
    (window as unknown as { localStorage: MemoryStorage }).localStorage =
      storage;
  }
});

function seedStorage(value: string): void {
  window.localStorage.setItem(APPEARANCE_STORAGE_KEY, value);
}

function storedValue(): string | null {
  return window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
}

function rootAttribute(name: string): string | null {
  return document.documentElement.getAttribute(name);
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-palette");
  appearance = null;
});

describe("ThemeProvider (task 1.3)", () => {
  it("applies documented defaults (system + lavender) with no stored data", async () => {
    const el = await mount(<ThemeProvider><Probe /></ThemeProvider>);

    expect(appearance?.mode).toBe("system");
    expect(appearance?.palette).toBe("lavender");
    expect(rootAttribute("data-theme")).toBeNull();
    expect(rootAttribute("data-palette")).toBe("lavender");
    // The default read must not write storage back.
    expect(storedValue()).toBeNull();

    el.unmount();
  });

  it("round-trips Dark + Sage: change, persist, unmount, remount restores", async () => {
    const el = await mount(<ThemeProvider><Probe /></ThemeProvider>);

    act(() => {
      appearance?.setMode("dark");
    });
    act(() => {
      appearance?.setPalette("sage");
    });

    expect(appearance?.mode).toBe("dark");
    expect(appearance?.palette).toBe("sage");
    expect(rootAttribute("data-theme")).toBe("dark");
    expect(rootAttribute("data-palette")).toBe("sage");
    expect(JSON.parse(storedValue() ?? "null")).toEqual({
      mode: "dark",
      palette: "sage",
    });

    el.unmount();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-palette");

    // Remount: the stored preferences survive the round trip.
    const el2 = await mount(<ThemeProvider><Probe /></ThemeProvider>);
    expect(appearance?.mode).toBe("dark");
    expect(appearance?.palette).toBe("sage");
    expect(rootAttribute("data-theme")).toBe("dark");
    expect(rootAttribute("data-palette")).toBe("sage");
    el2.unmount();
  });

  it("independent changes preserve the other preference", async () => {
    seedStorage(JSON.stringify({ mode: "dark", palette: "sage" }));
    const el = await mount(<ThemeProvider><Probe /></ThemeProvider>);

    act(() => {
      appearance?.setPalette("ocean");
    });
    expect(appearance?.mode).toBe("dark"); // mode preserved
    expect(JSON.parse(storedValue() ?? "null")).toEqual({
      mode: "dark",
      palette: "ocean",
    });

    act(() => {
      appearance?.setMode("light");
    });
    expect(appearance?.palette).toBe("ocean"); // palette preserved
    expect(rootAttribute("data-theme")).toBe("light");
    expect(JSON.parse(storedValue() ?? "null")).toEqual({
      mode: "light",
      palette: "ocean",
    });

    el.unmount();
  });

  it.each([
    ["not json at all", { mode: "system", palette: "lavender" }],
    ["42", { mode: "system", palette: "lavender" }],
    ["[]", { mode: "system", palette: "lavender" }],
    ['{"mode":"midnight","palette":"sage"}', { mode: "system", palette: "sage" }],
    ['{"mode":"dark","palette":"gold"}', { mode: "dark", palette: "lavender" }],
    ['{"palette":"sage"}', { mode: "system", palette: "sage" }],
    ['{"mode":"system"}', { mode: "system", palette: "lavender" }],
  ])(
    "falls back field-by-field for invalid stored data: %s",
    async (raw, expected) => {
      seedStorage(raw);
      const el = await mount(<ThemeProvider><Probe /></ThemeProvider>);

      expect(appearance?.mode).toBe(expected.mode);
      expect(appearance?.palette).toBe(expected.palette);
      expect(rootAttribute("data-theme")).toBe(
        expected.mode === "system" ? null : expected.mode,
      );
      expect(rootAttribute("data-palette")).toBe(expected.palette);
      el.unmount();
    },
  );

  it("stays usable in memory when storage reads throw (session-only changes)", async () => {
    const getItem = vi
      .spyOn(window.localStorage, "getItem")
      .mockImplementation(() => {
        throw new Error("storage blocked");
      });
    const setItem = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("storage blocked");
      });

    const el = await mount(<ThemeProvider><Probe /></ThemeProvider>);
    expect(appearance?.mode).toBe("system");
    expect(appearance?.palette).toBe("lavender");
    expect(rootAttribute("data-palette")).toBe("lavender");

    act(() => {
      appearance?.setPalette("ocean");
    });
    expect(rootAttribute("data-palette")).toBe("ocean");
    expect(appearance?.mode).toBe("system"); // session-only, no crash
    expect(setItem).not.toHaveBeenCalled();

    el.unmount();
    expect(getItem).toHaveBeenCalledTimes(1);
  });

  it("applies later changes without retrying storage after a failed write", async () => {
    seedStorage(JSON.stringify({ mode: "system", palette: "lavender" }));
    const setItem = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("quota exceeded");
      });

    const el = await mount(<ThemeProvider><Probe /></ThemeProvider>);

    act(() => {
      appearance?.setMode("dark");
    });
    expect(rootAttribute("data-theme")).toBe("dark");
    expect(setItem).toHaveBeenCalledTimes(1); // the first (failed) attempt

    act(() => {
      appearance?.setPalette("sage");
    });
    expect(rootAttribute("data-palette")).toBe("sage");
    expect(appearance?.mode).toBe("dark");
    expect(setItem).toHaveBeenCalledTimes(1); // no retry after failure

    el.unmount();
  });

  it("tracks live OS changes in System mode, both directions, without writing storage", async () => {
    const mql = createFakeMql(false);
    vi.spyOn(window, "matchMedia").mockReturnValue(mql as unknown as MediaQueryList);
    seedStorage(JSON.stringify({ mode: "system", palette: "clay" }));
    const setItem = vi.spyOn(window.localStorage, "setItem");

    const el = await mount(<ThemeProvider><Probe /></ThemeProvider>);
    expect(setItem).not.toHaveBeenCalled(); // initial read never writes back
    expect(appearance?.effectiveTheme).toBe("light");
    expect(rootAttribute("data-theme")).toBeNull(); // media rule governs
    expect(rootAttribute("data-palette")).toBe("clay");

    act(() => {
      mql.setMatches(true); // OS → dark
    });
    expect(appearance?.effectiveTheme).toBe("dark");
    expect(rootAttribute("data-theme")).toBeNull();
    expect(rootAttribute("data-palette")).toBe("clay"); // palette preserved

    act(() => {
      mql.setMatches(false); // OS → light
    });
    expect(appearance?.effectiveTheme).toBe("light");

    // OS-only appearance changes never touch storage.
    expect(setItem).not.toHaveBeenCalled();
    expect(JSON.parse(storedValue() ?? "null")).toEqual({
      mode: "system",
      palette: "clay",
    });

    el.unmount();
  });

  it("explicit modes ignore OS changes", async () => {
    const mql = createFakeMql(true);
    vi.spyOn(window, "matchMedia").mockReturnValue(mql as unknown as MediaQueryList);
    seedStorage(JSON.stringify({ mode: "light", palette: "lavender" }));

    const el = await mount(<ThemeProvider><Probe /></ThemeProvider>);
    expect(appearance?.effectiveTheme).toBe("light");
    expect(rootAttribute("data-theme")).toBe("light");

    act(() => {
      mql.setMatches(false); // OS flips; explicit Light must hold
    });
    expect(appearance?.effectiveTheme).toBe("light");
    expect(rootAttribute("data-theme")).toBe("light");

    act(() => {
      appearance?.setMode("dark");
    });
    expect(rootAttribute("data-theme")).toBe("dark");

    act(() => {
      mql.setMatches(true); // OS flips again; explicit Dark must hold
    });
    expect(appearance?.effectiveTheme).toBe("dark");
    expect(rootAttribute("data-theme")).toBe("dark");

    el.unmount();
  });

  it("returns to System: reads the current OS preference and subscribes", async () => {
    const mql = createFakeMql(false); // OS starts at light
    vi.spyOn(window, "matchMedia").mockReturnValue(mql as unknown as MediaQueryList);
    seedStorage(JSON.stringify({ mode: "light", palette: "sage" }));

    const el = await mount(<ThemeProvider><Probe /></ThemeProvider>);
    expect(mql.listenerCount()).toBe(0); // explicit mode: no OS listener
    expect(appearance?.effectiveTheme).toBe("light");

    // While still in explicit Light, an OS change must have no effect.
    act(() => {
      mql.setMatches(true);
    });
    expect(appearance?.effectiveTheme).toBe("light");
    expect(rootAttribute("data-theme")).toBe("light");

    act(() => {
      appearance?.setMode("system");
    });
    expect(appearance?.mode).toBe("system");
    expect(appearance?.effectiveTheme).toBe("dark"); // current OS = dark
    expect(rootAttribute("data-theme")).toBeNull();
    expect(mql.listenerCount()).toBe(1);

    act(() => {
      mql.setMatches(false);
    });
    expect(appearance?.effectiveTheme).toBe("light");

    el.unmount();
    expect(mql.listenerCount()).toBe(0); // cleanup on unmount
  });

  it("cleans up the OS listener when leaving System; late OS events have no effect", async () => {
    const mql = createFakeMql(false);
    vi.spyOn(window, "matchMedia").mockReturnValue(mql as unknown as MediaQueryList);

    const el = await mount(<ThemeProvider><Probe /></ThemeProvider>);
    expect(mql.listenerCount()).toBe(1);

    act(() => {
      appearance?.setMode("light");
    });
    expect(mql.listenerCount()).toBe(0);
    expect(rootAttribute("data-theme")).toBe("light");

    // A stray OS change after leaving System must not alter the appearance.
    act(() => {
      mql.setMatches(true);
    });
    expect(appearance?.effectiveTheme).toBe("light");
    expect(appearance?.mode).toBe("light");
    expect(rootAttribute("data-theme")).toBe("light");

    el.unmount();
  });
});

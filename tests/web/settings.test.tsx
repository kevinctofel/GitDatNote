// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flush } from "./test-utils";
import { App } from "../../src/web/App";
import { ThemeProvider } from "../../src/web/theme/theme-provider";
import { APPEARANCE_STORAGE_KEY } from "../../src/web/theme/appearance";
import { SettingsHub } from "../../src/web/components/settings/SettingsHub";
import type { ApiClient } from "../../src/web/api";

/** In-memory localStorage for happy-dom (window.localStorage is undefined). */
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

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-palette");
});

function rootAttribute(name: string): string | null {
  return document.documentElement.getAttribute(name);
}

async function mountSettings() {
  return mount(
    <ThemeProvider>
      <SettingsHub onBack={() => {}} />
    </ThemeProvider>,
  );
}

function tabs(host: HTMLElement): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
}

function themeChoices(host: HTMLElement): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll<HTMLButtonElement>(".theme-choice"));
}

function swatches(host: HTMLElement): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll<HTMLButtonElement>(".swatch"));
}

function click(element: HTMLElement): Promise<void> {
  return act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function pressKey(
  element: HTMLElement,
  key: string,
): Promise<void> {
  return act(async () => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

function focusElement(element: HTMLElement): Promise<void> {
  return act(async () => {
    element.focus();
  });
}

/** Mock API client: `getSession` decides the connection state. */
function makeClient(outcome: {
  connected?: boolean;
  user?: { login: string };
  error?: unknown;
}): ApiClient {
  return {
    getSession: () =>
      Promise.resolve({
        state: outcome.connected
          ? { connected: true, user: outcome.user ?? { login: "acme" } }
          : { connected: false },
        ...(outcome.error ? { error: outcome.error } : {}),
      }),
  } as unknown as ApiClient;
}

describe("Settings hub navigation (task 1.4)", () => {
  it("renders the five sections in order and defaults to Appearance", async () => {
    const { host, unmount } = await mountSettings();
    const tabList = host.querySelector('[role="tablist"]');
    expect(tabList).not.toBeNull();
    expect(
      tabs(host).map((tab) => tab.textContent?.trim()),
    ).toEqual(["General", "Appearance", "Publishing", "GitHub", "About"]);

    // Appearance is the functional tab by default.
    const selected = tabs(host).filter((tab) =>
      tab.getAttribute("aria-selected") === "true",
    );
    expect(selected.map((tab) => tab.textContent?.trim())).toEqual([
      "Appearance",
    ]);

    // Each tab labels its own panel.
    const appearancePanel = host.querySelector<HTMLDivElement>(
      "#settings-panel-appearance",
    );
    expect(appearancePanel?.getAttribute("role")).toBe("tabpanel");
    expect(appearancePanel?.getAttribute("aria-labelledby")).toBe(
      "settings-tab-appearance",
    );
    expect(appearancePanel?.hasAttribute("hidden")).toBe(false);

    // The four placeholder panels are present and clearly identified.
    for (const id of ["general", "publishing", "github", "about"]) {
      const panel = host.querySelector(`#settings-panel-${id}`);
      expect(panel).not.toBeNull();
      expect(panel?.hasAttribute("hidden")).toBe(true);
      expect(panel?.textContent).toMatch(/structural placeholder/i);
    }
    unmount();
  });

  it("clicking a tab selects it, shows its panel, and hides the others", async () => {
    const { host, unmount } = await mountSettings();
    await click(tabs(host)[3]); // GitHub
    expect(tabs(host)[3].getAttribute("aria-selected")).toBe("true");
    expect(tabs(host)[2].getAttribute("aria-selected")).toBe("false");
    expect(
      host.querySelector("#settings-panel-github")?.hasAttribute("hidden"),
    ).toBe(false);
    expect(
      host.querySelector("#settings-panel-appearance")?.hasAttribute("hidden"),
    ).toBe(true);
    expect(host.querySelector("#settings-panel-github")?.textContent).toMatch(
      /GitHub settings will arrive in a later task/i,
    );
    unmount();
  });

  it("supports arrow-key navigation with a single tab stop (roving tabindex)", async () => {
    const { host, unmount } = await mountSettings();
    const tablist = tabs(host);

    // Exactly one tab stop, on the selected (Appearance) tab.
    expect(tablist.map((tab) => tab.tabIndex)).toEqual([
      -1, 0, -1, -1, -1,
    ]);

    await focusElement(tablist[1]);
    await pressKey(tablist[1], "ArrowLeft");
    expect(document.activeElement).toBe(tablist[0]);
    expect(tablist[0].getAttribute("aria-selected")).toBe("true");

    await pressKey(tablist[0], "ArrowRight");
    expect(document.activeElement).toBe(tablist[1]);

    // Wrapping at the ends.
    await pressKey(tablist[1], "End");
    expect(document.activeElement).toBe(tablist[4]);
    expect(tablist[4].getAttribute("aria-selected")).toBe("true");
    await pressKey(tablist[4], "ArrowRight");
    expect(document.activeElement).toBe(tablist[0]);
    expect(tablist[0].getAttribute("aria-selected")).toBe("true");
    await pressKey(tablist[0], "ArrowLeft");
    expect(document.activeElement).toBe(tablist[4]);

    // Home returns to the first tab.
    await pressKey(tablist[4], "Home");
    expect(document.activeElement).toBe(tablist[0]);

    // The roving tab stop follows the selection.
    expect(tablist.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    unmount();
  });

  it("offers a Back button that leaves the hub", async () => {
    const onBack = vi.fn();
    const mounted = await mount(<ThemeProvider><SettingsHub onBack={onBack} /></ThemeProvider>);
    const back = mounted.host.querySelector<HTMLButtonElement>(
      ".settings-back",
    );
    expect(back?.textContent?.trim()).toBe("Back");
    await click(back!);
    expect(onBack).toHaveBeenCalledTimes(1);
    mounted.unmount();
  });
});

describe("Appearance tab (task 1.4)", () => {
  it("shows the three theme cards in order with line icons and defaults to System", async () => {
    const { host, unmount } = await mountSettings();
    const cards = themeChoices(host);
    expect(cards.map((card) => card.querySelector(".choice-label")?.textContent)).toEqual(
      ["Light", "Dark", "System"],
    );
    // Each card is a real, labeled button carrying a line icon.
    for (const card of cards) {
      expect(card.tagName).toBe("BUTTON");
      expect(card.querySelector("svg")).not.toBeNull();
    }
    expect(cards.map((card) => card.getAttribute("aria-pressed"))).toEqual([
      "false", "false", "true",
    ]);
    expect(cards[2].textContent).toContain("Current");
    expect(cards[0].textContent).not.toContain("Current");
    unmount();
  });

  it("shows the six accent swatches in the approved order with labels", async () => {
    const { host, unmount } = await mountSettings();
    const list = swatches(host);
    expect(list.map((swatch) => swatch.querySelector(".choice-label")?.textContent)).toEqual(
      ["Lavender (Default)", "Sage", "Ocean", "Slate", "Clay", "Teal"],
    );
    for (const swatch of list) {
      expect(swatch.tagName).toBe("BUTTON");
      expect(swatch.querySelector(".swatch-dot")?.style.backgroundColor).toBeTruthy();
    }
    expect(list.map((swatch) => swatch.getAttribute("aria-pressed"))).toEqual([
      "true", "false", "false", "false", "false", "false",
    ]);
    expect(list[0].textContent).toContain("Current");
    unmount();
  });

  it("selecting a choice re-themes the app immediately and preserves the other preference", async () => {
    const { host, unmount } = await mountSettings();

    // Dark mode (palette must stay lavender).
    await click(themeChoices(host)[1]);
    expect(rootAttribute("data-theme")).toBe("dark");
    expect(rootAttribute("data-palette")).toBe("lavender");
    expect(themeChoices(host)[1].getAttribute("aria-pressed")).toBe("true");
    expect(themeChoices(host)[1].textContent).toContain("Current");
    expect(themeChoices(host)[2].getAttribute("aria-pressed")).toBe("false");

    // Ocean accent (mode must stay dark) — the swatch ring color follows.
    await click(swatches(host)[2]);
    expect(rootAttribute("data-palette")).toBe("ocean");
    expect(rootAttribute("data-theme")).toBe("dark");
    expect(swatches(host)[2].getAttribute("aria-pressed")).toBe("true");
    expect(swatches(host)[2].textContent).toContain("Current");
    expect(swatches(host)[0].getAttribute("aria-pressed")).toBe("false");

    // The selection persisted to the browser-local key.
    expect(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe(
      JSON.stringify({ mode: "dark", palette: "ocean" }),
    );
    unmount();
  });

  it("moves the 'Current' marker and selection ring to the new choice", async () => {
    const { host, unmount } = await mountSettings();
    await click(themeChoices(host)[0]); // Light
    expect(themeChoices(host)[0].textContent).toContain("Current");
    expect(themeChoices(host)[2].textContent).not.toContain("Current");
    expect(themeChoices(host)[0].getAttribute("aria-pressed")).toBe("true");

    await click(swatches(host)[5]); // Teal
    expect(swatches(host)[5].textContent).toContain("Current");
    expect(swatches(host)[0].textContent).not.toContain("Current");
    unmount();
  });

  it("supports arrow-key navigation within the accent group with one tab stop", async () => {
    const { host, unmount } = await mountSettings();
    const list = swatches(host);

    // One tab stop on the current selection (Lavender).
    expect(list.map((swatch) => swatch.tabIndex)).toEqual([
      0, -1, -1, -1, -1, -1,
    ]);

    await focusElement(list[0]);
    await pressKey(list[0], "ArrowRight");
    expect(document.activeElement).toBe(list[1]);
    await pressKey(list[1], "ArrowDown");
    expect(document.activeElement).toBe(list[2]);
    await pressKey(list[2], "ArrowLeft");
    expect(document.activeElement).toBe(list[1]);

    // Wrapping and Home/End.
    await pressKey(list[1], "Home");
    expect(document.activeElement).toBe(list[0]);
    await pressKey(list[0], "ArrowLeft");
    expect(document.activeElement).toBe(list[5]);
    await pressKey(list[5], "ArrowRight");
    expect(document.activeElement).toBe(list[0]);
    await pressKey(list[0], "End");
    expect(document.activeElement).toBe(list[5]);

    // The roving tab stop follows the focused swatch (currently the last).
    expect(list[5].tabIndex).toBe(0);
    expect(list[0].tabIndex).toBe(-1);
    unmount();
  });

  it("follows a seeded selection on mount (roving focus starts on the current swatch)", async () => {
    window.localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({ mode: "dark", palette: "sage" }),
    );
    const { host, unmount } = await mountSettings();
    expect(rootAttribute("data-theme")).toBe("dark");
    expect(rootAttribute("data-palette")).toBe("sage");
    const list = swatches(host);
    expect(list.map((swatch) => swatch.tabIndex)).toEqual([
      -1, 0, -1, -1, -1, -1,
    ]);
    expect(list[1].getAttribute("aria-pressed")).toBe("true");
    expect(list[1].textContent).toContain("Current");
    unmount();
  });

  it("keeps the tab usable for the session when storage writes fail", async () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    const { host, unmount } = await mountSettings();
    await click(themeChoices(host)[1]);
    await click(swatches(host)[2]);
    expect(rootAttribute("data-theme")).toBe("dark");
    expect(rootAttribute("data-palette")).toBe("ocean");
    expect(themeChoices(host)[1].getAttribute("aria-pressed")).toBe("true");
    expect(swatches(host)[2].getAttribute("aria-pressed")).toBe("true");
    unmount();
  });

  it("restores the stored appearance when the app remounts (reload)", async () => {
    const first = await mountSettings();
    await click(themeChoices(first.host)[1]);
    await click(swatches(first.host)[1]);
    first.unmount();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-palette");

    const second = await mountSettings();
    expect(rootAttribute("data-theme")).toBe("dark");
    expect(rootAttribute("data-palette")).toBe("sage");
    expect(themeChoices(second.host)[1].getAttribute("aria-pressed")).toBe("true");
    expect(swatches(second.host)[1].getAttribute("aria-pressed")).toBe("true");
    second.unmount();
  });
});

describe("Settings entry in the app (task 1.4)", () => {
  async function openSettings(client: ApiClient) {
    const mounted = await mount(
      <ThemeProvider>
        <App client={client} />
      </ThemeProvider>,
    );
    const entry = mounted.host.querySelector<HTMLButtonElement>(
      ".settings-entry",
    );
    expect(entry).not.toBeNull();
    expect(entry!.textContent).toContain("Settings");
    await click(entry!);
    return mounted;
  }

  it("is reachable from every connection state and reveals the hub", async () => {
    // Disconnected.
    const disconnected = await openSettings(makeClient({}));
    let host = disconnected.host;
    expect(host.querySelector("#settings-hub")).not.toBeNull();
    expect(host.querySelector('[role="tablist"]')).not.toBeNull();
    expect(host.querySelector(".app-title")).not.toBeNull();

    // The entry reflects the open state.
    let entry = host.querySelector<HTMLButtonElement>(".settings-entry");
    expect(entry?.getAttribute("aria-expanded")).toBe("true");
    expect(entry?.getAttribute("aria-controls")).toBe("settings-hub");

    // Back returns to the disconnected view (Connect GitHub action intact).
    await click(host.querySelector<HTMLButtonElement>(".settings-back")!);
    expect(host.querySelector("#settings-hub")).toBeNull();
    expect(host.textContent).toMatch(/connect github/i);
    disconnected.unmount();

    // Error.
    const errored = await openSettings(
      makeClient({
        error: {
          code: "GITHUB_UNAVAILABLE",
          message: "GitHub is unavailable.",
          retryable: true,
          status: 502,
        },
      }),
    );
    host = errored.host;
    expect(host.querySelector("#settings-hub")).not.toBeNull();
    entry = host.querySelector<HTMLButtonElement>(".settings-entry");
    expect(entry?.getAttribute("aria-expanded")).toBe("true");
    await click(host.querySelector<HTMLButtonElement>(".settings-back")!);
    expect(host.textContent).toMatch(/connection problem/i);
    errored.unmount();

    // Loading: the entry exists while the session probe is in flight.
    const loadingClient = {
      getSession: () => new Promise(() => {}),
    } as unknown as ApiClient;
    const loading = await mount(
      <ThemeProvider>
        <App client={loadingClient} />
      </ThemeProvider>,
    );
    expect(loading.host.textContent).toMatch(/checking your github connection/i);
    expect(loading.host.querySelector(".settings-entry")).not.toBeNull();
    loading.unmount();
  });

  it("leaves the connected layout (identity + repositories) intact around the hub", async () => {
    const client = {
      getSession: () =>
        Promise.resolve({
          state: { connected: true, user: { login: "octo" } },
        }),
      listRepositories: () =>
        Promise.resolve([
          {
            owner: "acme",
            name: "notes",
            contentRoot: "Journal",
            canRead: true,
            canWrite: true,
            private: false,
          },
        ]),
    } as unknown as ApiClient;
    const mounted = await openSettings(client);
    const host = mounted.host;
    expect(host.querySelector("#settings-hub")).not.toBeNull();
    // The session identity stays visible in the header while the hub is open.
    expect(host.textContent).toContain("Signed in as octo");
    await click(host.querySelector<HTMLButtonElement>(".settings-back")!);
    expect(host.querySelector("#settings-hub")).toBeNull();
    await flush();
    expect(host.textContent).toMatch(/acme\/notes/);
    mounted.unmount();
  });
});

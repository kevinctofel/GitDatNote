import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";

// React 18.3: mark the act environment so act() is permitted without warnings.
const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
g.IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  host: HTMLElement;
  unmount: () => void;
}

/**
 * Minimal mount helper (no test-library dependency): renders into a detached
 * host element in the happy-dom document and returns it for DOM assertions.
 */
export async function mount(element: ReactElement): Promise<Mounted> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(element);
  });
  return {
    host,
    unmount: () => {
      root.unmount();
      host.remove();
    },
  };
}

/**
 * Flush pending microtasks/state updates. The extra microtask tick lets an
 * effect-driven `setState` (from an already-resolved promise) settle inside
 * `act()`, so React does not warn about an unwrapped update.
 */
export async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

import { act } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

/**
 * Test utilities for React components under happy-dom.
 */

export interface Mounted {
  host: HTMLElement;
  root: Root;
  unmount: () => void;
}

/**
 * Mount `element` into a detached host node. `act` is used so effects and state
 * updates flush before assertions, avoiding "not wrapped in act" warnings.
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
    root,
    unmount: () => {
      root.unmount();
      host.remove();
    },
  };
}

/**
 * Re-render an already-mounted component with a new element (e.g. to swap in a
 * new injected client, which changes a load function's identity and re-runs its
 * data-loading effect). Used to exercise out-of-order request completion.
 */
export async function rerender(
  mounted: Mounted,
  element: ReactElement,
): Promise<void> {
  await act(async () => {
    mounted.root.render(element);
  });
}

/**
 * Flush pending microtasks (e.g. an awaited `flush()` in a test's mock client)
 * so async state updates settle before assertions.
 */
export function flush(): Promise<void> {
  return Promise.resolve();
}

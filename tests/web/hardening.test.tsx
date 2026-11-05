// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { App } from "../../src/web/App";
import { ConnectedView } from "../../src/web/components/ConnectedView";
import { ApiError } from "../../src/web/api";
import type { ApiClient, SessionOutcome } from "../../src/web/api";
import type { Repository } from "../../src/shared/types";
import { mount, rerender, flush } from "./test-utils";

const REPOS: Repository[] = [
  {
    owner: "acme",
    name: "notes",
    contentRoot: "Journal",
    canRead: true,
    canWrite: true,
    private: false,
  },
];

describe("async request safety (hardening)", () => {
  it("drops a stale repository-list response when a newer load completes first (out-of-order)", async () => {
    let resolveSlow!: (repos: Repository[]) => void;
    const slowClient = {
      listRepositories: () =>
        new Promise<Repository[]>((resolve) => {
          resolveSlow = resolve;
        }),
    } as unknown as ApiClient;
    const fastClient = {
      listRepositories: () => Promise.resolve(REPOS),
    } as unknown as ApiClient;

    const m = await mount(<ConnectedView client={slowClient} />);
    // A newer load (fast client) is issued and completes first.
    await rerender(m, <ConnectedView client={fastClient} />);
    await flush();
    // The stale, slower load resolves last — it must be dropped.
    resolveSlow([]);
    await flush();

    // The fast client's repositories win; the stale empty list is ignored.
    expect(m.host.textContent).toMatch(/acme\/notes/);
    m.unmount();
  });

  it("ignores a repository-list response that lands after the component unmounted", async () => {
    let resolveSlow!: (repos: Repository[]) => void;
    const slowClient = {
      listRepositories: () =>
        new Promise<Repository[]>((resolve) => {
          resolveSlow = resolve;
        }),
    } as unknown as ApiClient;

    const m = await mount(<ConnectedView client={slowClient} />);
    m.unmount(); // invalidate the in-flight load
    resolveSlow(REPOS); // late response: must not cause a state update
    await flush();

    expect(m.host.isConnected).toBe(false);
  });

  it("shows a safe error state for a malformed repository-list response", async () => {
    const client = {
      listRepositories: () =>
        Promise.reject(
          new ApiError({
            code: "INTERNAL_ERROR",
            message:
              "The server returned an unexpected response. Please try again.",
            retryable: true,
            status: 500,
          }),
        ),
    } as unknown as ApiClient;

    const m = await mount(<ConnectedView client={client} />);
    await flush();

    expect(m.host.textContent).toMatch(/unexpected response/i);
    const retry = Array.from(m.host.querySelectorAll("button")).find(
      (b) => /retry/i.test(b.textContent ?? ""),
    );
    expect(retry).toBeDefined();
    m.unmount();
  });

  it("shows a retryable connection-error state when the session probe fails at the transport", async () => {
    const outcome: SessionOutcome = {
      state: { connected: false },
      error: {
        code: "GITHUB_UNAVAILABLE",
        message: "GitHub is currently unavailable.",
        retryable: true,
        status: 502,
      },
    };
    const client = {
      getSession: () => Promise.resolve(outcome),
    } as unknown as ApiClient;

    const m = await mount(<App client={client} />);
    await flush();

    expect(m.host.textContent).toMatch(/GitHub is currently unavailable/i);
    const retry = Array.from(m.host.querySelectorAll("button")).find(
      (b) => /try again/i.test(b.textContent ?? ""),
    );
    expect(retry).toBeDefined();
    m.unmount();
  });

  it("drops a stale session response when a newer session check completes first (out-of-order)", async () => {
    let resolveSlow!: (outcome: SessionOutcome) => void;
    const slowClient = {
      getSession: () =>
        new Promise<SessionOutcome>((resolve) => {
          resolveSlow = resolve;
        }),
    } as unknown as ApiClient;
    const fastClient = {
      getSession: () => Promise.resolve({ state: { connected: false } }),
    } as unknown as ApiClient;

    const m = await mount(<App client={slowClient} />);
    // A newer session check (fast client) completes first.
    await rerender(m, <App client={fastClient} />);
    await flush();
    // A stale "connected" response arrives late — it must be dropped.
    resolveSlow({
      state: { connected: true, user: { login: "stale" } },
    });
    await flush();

    // The fast "disconnected" check wins; the disconnected view is shown.
    expect(m.host.textContent).toMatch(/Not connected to GitHub/i);
    m.unmount();
  });
});

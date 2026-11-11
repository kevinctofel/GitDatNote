// @vitest-environment happy-dom
import { act } from "react";
import { describe, it, expect, vi } from "vitest";
import { mount, flush } from "./test-utils";
import { App } from "../../src/web/App";
import { ConnectedView } from "../../src/web/components/ConnectedView";
import { DisconnectedView } from "../../src/web/components/DisconnectedView";
import { ErrorView } from "../../src/web/components/ErrorView";
import { ApiError } from "../../src/web/api";
import type { ApiClient, SessionOutcome } from "../../src/web/api";
import type { Repository, SessionState } from "../../src/shared/types";

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

describe("ConnectedView", () => {
  it("shows an empty state when there are no repositories", async () => {
    const client = {
      listRepositories: () => Promise.resolve([]),
    } as unknown as ApiClient;
    const { host, unmount } = await mount(<ConnectedView client={client} />);
    await flush();
    expect(host.textContent ?? "").toMatch(/No repositories are available/);
    unmount();
  });

  it("shows an error state with a retry button for retryable failures", async () => {
    const client = {
      listRepositories: () =>
        Promise.reject(
          new ApiError({
            code: "GITHUB_UNAVAILABLE",
            message: "GitHub is unavailable.",
            retryable: true,
            status: 502,
          }),
        ),
    } as unknown as ApiClient;
    const { host, unmount } = await mount(<ConnectedView client={client} />);
    await flush();
    expect(host.textContent ?? "").toMatch(/GitHub is unavailable\./);
    const retry = Array.from(host.querySelectorAll("button")).find((b) =>
      /retry/i.test(b.textContent ?? ""),
    );
    expect(retry).toBeDefined();
    unmount();
  });

  it("lists repositories and shows repo details on selection", async () => {
    const client = {
      listRepositories: () => Promise.resolve(REPOS),
    } as unknown as ApiClient;
    const { host, unmount } = await mount(<ConnectedView client={client} />);
    await flush();
    const select = host.querySelector("select") as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(select!.options.length).toBe(2); // placeholder + 1 repository
    select!.value = "acme/notes";
    await act(async () => {
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.textContent ?? "").toMatch(/acme\/notes/);
    expect(host.textContent ?? "").toMatch(/read \+ write/);
    expect(host.textContent ?? "").toMatch(/public/);
    unmount();
  });

  it("shows a labeled preview banner in preview mode", async () => {
    const client = {
      listRepositories: () => Promise.resolve([]),
    } as unknown as ApiClient;
    const { host, unmount } = await mount(<ConnectedView client={client} preview />);
    await flush();
    expect(host.textContent ?? "").toMatch(/sample data only/i);
    expect(host.querySelectorAll("option").length).toBeGreaterThan(1);
    unmount();
  });
});

describe("DisconnectedView", () => {
  it("offers a labeled Connect GitHub action", async () => {
    const client = { connectGithub: () => {} } as unknown as ApiClient;
    const { host, unmount } = await mount(<DisconnectedView client={client} />);
    const connect = Array.from(host.querySelectorAll("button")).find((b) =>
      /connect github/i.test(b.textContent ?? ""),
    );
    expect(connect).toBeDefined();
    unmount();
  });

  it("clicking Connect GitHub invokes connectGithub() exactly once", async () => {
    const connectGithub = vi.fn();
    const client = { connectGithub } as unknown as ApiClient;
    const { host, unmount } = await mount(<DisconnectedView client={client} />);
    const connect = Array.from(host.querySelectorAll("button")).find((b) =>
      /connect github/i.test(b.textContent ?? ""),
    )!;
    await act(async () => {
      connect.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(connectGithub).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe("ErrorView", () => {
  it("renders fixed copy for a known reason", async () => {
    const { host, unmount } = await mount(
      <ErrorView search="?reason=auth_unconfigured" />,
    );
    expect(host.textContent ?? "").toMatch(
      /not configured for this GitDatNote instance/i,
    );
    unmount();
  });

  it("renders fixed copy for an expired sign-in attempt", async () => {
    const { host, unmount } = await mount(<ErrorView search="?reason=state_expired" />);
    expect(host.textContent ?? "").toMatch(/expired before it completed/i);
    unmount();
  });

  it("never renders raw query values for unknown reasons", async () => {
    const { host, unmount } = await mount(
      <ErrorView search="?reason=evil-script-injection" />,
    );
    const text = host.textContent ?? "";
    expect(text).toMatch(/Something went wrong/i);
    expect(text).not.toContain("evil-script-injection");
    unmount();
  });

  it("falls back to a generic message when no reason is present", async () => {
    const { host, unmount } = await mount(<ErrorView search="" />);
    expect(host.textContent ?? "").toMatch(/Something went wrong/i);
    unmount();
  });
});

// ---- Task 3.6: App-level connection flow (connect / disconnect) ----

/** Server-issued CSRF token shape: 32 random bytes, hex-encoded (64 chars). */
const CSRF_TOKEN = "ab".repeat(32);

const CONNECTED_SESSION: SessionState = {
  connected: true,
  user: {
    login: "octocat",
    name: "Octo Cat",
    avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
  },
  csrfToken: CSRF_TOKEN,
};

function findButton(host: HTMLElement, text: RegExp): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll("button")).find((button) =>
    text.test(button.textContent ?? ""),
  );
}

async function settle(): Promise<void> {
  // Let chained microtasks (state update -> effect -> new fetch) settle.
  for (let i = 0; i < 5; i += 1) {
    await flush();
  }
}

type AppClientOverrides = Partial<
  Pick<ApiClient, "getSession" | "listRepositories" | "disconnectGithub">
>;

function makeAppClient(overrides: AppClientOverrides = {}): ApiClient {
  return {
    getSession:
      overrides.getSession ??
      (() => Promise.resolve({ state: { connected: false } } as SessionOutcome)),
    listRepositories:
      overrides.listRepositories ?? (() => Promise.resolve(REPOS)),
    disconnectGithub:
      overrides.disconnectGithub ?? (() => Promise.resolve(undefined)),
  } as unknown as ApiClient;
}

describe("App connection flow (task 3.6)", () => {
  it("shows an accessible loading state while the session probe is in flight", async () => {
    const client = makeAppClient({
      getSession: () => new Promise(() => {}), // never settles
    });
    const { host, unmount } = await mount(<App client={client} />);
    expect(host.textContent ?? "").toMatch(/Checking your GitHub connection/i);
    unmount();
  });

  it("renders the disconnected view (with Connect GitHub) when there is no session", async () => {
    const client = makeAppClient();
    const { host, unmount } = await mount(<App client={client} />);
    await settle();
    expect(host.textContent ?? "").toMatch(/Not connected to GitHub/i);
    expect(findButton(host, /connect github/i)).toBeDefined();
    unmount();
  });

  it("renders the connected user's identity, a safe avatar, and the Disconnect action", async () => {
    const client = makeAppClient({
      getSession: () =>
        Promise.resolve({ state: CONNECTED_SESSION } as SessionOutcome),
    });
    const { host, unmount } = await mount(<App client={client} />);
    await settle();
    expect(host.textContent ?? "").toMatch(/Octo Cat \(octocat\)/);
    expect(host.textContent ?? "").toMatch(/Connected to GitHub/i);
    const avatar = host.querySelector("img.avatar");
    expect(avatar).not.toBeNull();
    expect(avatar?.getAttribute("src")).toBe(
      "https://avatars.githubusercontent.com/u/583231?v=4",
    );
    expect(findButton(host, /^disconnect$/i)).toBeDefined();
    // The CSRF token is never rendered anywhere.
    expect(host.textContent ?? "").not.toContain(CSRF_TOKEN);
    unmount();
  });

  it("a successful logout clears the identity, selection, and repository list", async () => {
    const disconnectGithub = vi.fn().mockResolvedValue(undefined);
    const client = makeAppClient({
      getSession: () =>
        Promise.resolve({ state: CONNECTED_SESSION } as SessionOutcome),
      disconnectGithub,
    });
    const { host, unmount } = await mount(<App client={client} />);
    await settle();
    expect(host.textContent ?? "").toMatch(/octocat/);

    // Select a repository first, then disconnect.
    const select = host.querySelector("select") as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    select!.value = "acme/notes";
    await act(async () => {
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(host.textContent ?? "").toMatch(/acme\/notes/);

    const disconnect = findButton(host, /^disconnect$/i);
    expect(disconnect).toBeDefined();
    await act(async () => {
      disconnect!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();

    expect(disconnectGithub).toHaveBeenCalledTimes(1);
    expect(disconnectGithub).toHaveBeenCalledWith(CSRF_TOKEN);
    expect(host.textContent ?? "").toMatch(/Not connected to GitHub/i);
    expect(host.textContent ?? "").not.toMatch(/octocat/i);
    expect(host.querySelector("img.avatar")).toBeNull();
    unmount();
  });

  it("a double-click on Disconnect sends exactly one logout request and communicates pending state", async () => {
    let resolveLogout!: () => void;
    const disconnectGithub = vi.fn(() => new Promise<void>((resolve) => {
      resolveLogout = resolve;
    }));
    const client = makeAppClient({
      getSession: () =>
        Promise.resolve({ state: CONNECTED_SESSION } as SessionOutcome),
      disconnectGithub,
    });
    const { host, unmount } = await mount(<App client={client} />);
    await settle();

    const disconnect = findButton(host, /^disconnect$/i)!;
    await act(async () => {
      disconnect.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      disconnect.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(disconnectGithub).toHaveBeenCalledTimes(1);

    // Pending operation is announced via an accessible status region,
    // and the control is disabled while in flight.
    const status = host.querySelector("[role='status']");
    expect(status?.textContent ?? "").toMatch(/Disconnecting/i);
    expect(disconnect.disabled).toBe(true);

    await act(async () => {
      resolveLogout();
    });
    await settle();
    expect(host.textContent ?? "").toMatch(/Not connected to GitHub/i);
    unmount();
  });

  it("reconciles to the disconnected state when logout answers 401 (session already gone)", async () => {
    const disconnectGithub = vi.fn().mockRejectedValue(
      new ApiError({
        code: "UNAUTHORIZED",
        message: "Your session is no longer valid. Please sign in again.",
        retryable: false,
        status: 401,
      }),
    );
    const client = makeAppClient({
      getSession: () =>
        Promise.resolve({ state: CONNECTED_SESSION } as SessionOutcome),
      disconnectGithub,
    });
    const { host, unmount } = await mount(<App client={client} />);
    await settle();

    const disconnect = findButton(host, /^disconnect$/i)!;
    await act(async () => {
      disconnect.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();

    expect(disconnectGithub).toHaveBeenCalledTimes(1);
    expect(host.textContent ?? "").toMatch(/Not connected to GitHub/i);
    // No failed-disconnect message: the server confirmed the session is gone.
    expect(host.textContent ?? "").not.toMatch(/Couldn't disconnect/i);
    unmount();
  });

  it("a 403 CSRF_INVALID logout does NOT transition to disconnected and offers a session recheck", async () => {
    const disconnectGithub = vi.fn().mockRejectedValue(
      new ApiError({
        code: "CSRF_INVALID",
        message:
          "This request was rejected for security reasons. Please try again.",
        retryable: false,
        status: 403,
      }),
    );
    const client = makeAppClient({
      getSession: () =>
        Promise.resolve({ state: CONNECTED_SESSION } as SessionOutcome),
      disconnectGithub,
    });
    const { host, unmount } = await mount(<App client={client} />);
    await settle();

    const disconnect = findButton(host, /^disconnect$/i)!;
    await act(async () => {
      disconnect.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();

    const alert = host.querySelector("[role='alert']");
    expect(alert).not.toBeNull();
    expect(alert?.textContent ?? "").toMatch(/Couldn't disconnect/i);
    // Still connected: the CSRF rejection does not delete the server-side
    // session, so the UI must not claim a disconnect.
    expect(host.textContent ?? "").toMatch(/octocat/);
    expect(host.textContent ?? "").not.toMatch(/Not connected to GitHub/i);
    expect(host.textContent ?? "").not.toContain(CSRF_TOKEN);
    // No plain retry: the rejected token must not be resent as-is.
    expect(findButton(host, /^disconnect$/i)).toBeUndefined();
    // A usable recovery action is offered instead.
    expect(findButton(host, /recheck session/i)).toBeDefined();
    expect(host.textContent ?? "").toMatch(
      /Your GitHub connection is still active/i,
    );
    expect(disconnectGithub).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("after a CSRF rejection, rechecking the session yields a fresh token and logout succeeds with it", async () => {
    const FRESH_TOKEN = "cd".repeat(32);
    let sessionCalls = 0;
    const disconnectGithub = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError({
          code: "CSRF_INVALID",
          message:
            "This request was rejected for security reasons. Please try again.",
          retryable: false,
          status: 403,
        }),
      )
      .mockResolvedValueOnce(undefined);
    const client = makeAppClient({
      getSession: () => {
        sessionCalls += 1;
        return Promise.resolve({
          state:
            sessionCalls === 1
              ? CONNECTED_SESSION
              : {
                  connected: true,
                  user: { login: "octocat" },
                  csrfToken: FRESH_TOKEN,
                },
        } as SessionOutcome);
      },
      disconnectGithub,
    });
    const { host, unmount } = await mount(<App client={client} />);
    await settle();

    // First logout attempt: rejected by the CSRF boundary.
    await act(async () => {
      findButton(host, /^disconnect$/i)!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(host.textContent ?? "").toMatch(/Couldn't disconnect/i);

    // Recovery: recheck the session — a new GET /api/session, not a new
    // logout with the rejected token.
    await act(async () => {
      findButton(host, /recheck session/i)!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(sessionCalls).toBe(2);
    expect(disconnectGithub).toHaveBeenCalledTimes(1);
    // Connected again, with the fresh token available.
    expect(host.textContent ?? "").toMatch(/octocat/);
    expect(host.textContent ?? "").not.toContain(CSRF_TOKEN);

    // Now logout succeeds using the fresh token.
    await act(async () => {
      findButton(host, /^disconnect$/i)!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(disconnectGithub).toHaveBeenCalledTimes(2);
    expect(disconnectGithub).toHaveBeenLastCalledWith(FRESH_TOKEN);
    expect(host.textContent ?? "").toMatch(/Not connected to GitHub/i);
    expect(host.textContent ?? "").not.toMatch(/octocat/i);
    unmount();
  });

  it("after a CSRF rejection, rechecking a gone session reconciles to the disconnected view", async () => {
    let sessionCalls = 0;
    const disconnectGithub = vi.fn().mockRejectedValue(
      new ApiError({
        code: "CSRF_INVALID",
        message:
          "This request was rejected for security reasons. Please try again.",
        retryable: false,
        status: 403,
      }),
    );
    const client = makeAppClient({
      getSession: () => {
        sessionCalls += 1;
        return Promise.resolve(
          sessionCalls === 1
            ? ({ state: CONNECTED_SESSION } as SessionOutcome)
            : ({ state: { connected: false } } as SessionOutcome),
        );
      },
      disconnectGithub,
    });
    const { host, unmount } = await mount(<App client={client} />);
    await settle();

    await act(async () => {
      findButton(host, /^disconnect$/i)!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(host.textContent ?? "").toMatch(/Couldn't disconnect/i);

    await act(async () => {
      findButton(host, /recheck session/i)!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(sessionCalls).toBe(2);
    // The rejected token was never resent.
    expect(disconnectGithub).toHaveBeenCalledTimes(1);
    expect(host.textContent ?? "").toMatch(/Not connected to GitHub/i);
    expect(host.textContent ?? "").not.toMatch(/octocat/i);
    unmount();
  });

  it("does not offer a Disconnect control when the connected session has no CSRF token", async () => {
    const client = makeAppClient({
      getSession: () =>
        Promise.resolve({
          state: { connected: true, user: { login: "octocat" } },
        } as SessionOutcome),
    });
    const { host, unmount } = await mount(<App client={client} />);
    await settle();
    expect(host.textContent ?? "").toMatch(/octocat/);
    expect(host.textContent ?? "").toMatch(
      /Sign-out is unavailable for this session/i,
    );
    expect(findButton(host, /disconnect/i)).toBeUndefined();
    unmount();
  });

  it("a late repository response cannot restore the connected UI after a successful logout", async () => {
    let resolveRepos!: (repositories: Repository[]) => void;
    const client = makeAppClient({
      getSession: () =>
        Promise.resolve({ state: CONNECTED_SESSION } as SessionOutcome),
      listRepositories: () =>
        new Promise<Repository[]>((resolve) => {
          resolveRepos = resolve;
        }),
    });
    const { host, unmount } = await mount(<App client={client} />);
    await settle();
    expect(host.textContent ?? "").toMatch(/Connected to GitHub/i);

    const disconnect = findButton(host, /^disconnect$/i)!;
    await act(async () => {
      disconnect.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(host.textContent ?? "").toMatch(/Not connected to GitHub/i);

    // Now the stale repository list arrives — it must be dropped.
    await act(async () => {
      resolveRepos(REPOS);
    });
    await settle();
    expect(host.textContent ?? "").toMatch(/Not connected to GitHub/i);
    expect(host.textContent ?? "").not.toMatch(/acme\/notes/);
    unmount();
  });

  it("retrying a failed session check settles into the disconnected view and stays there", async () => {
    let calls = 0;
    const client = makeAppClient({
      getSession: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({
            state: { connected: false },
            error: {
              code: "GITHUB_UNAVAILABLE",
              message: "GitHub is currently unavailable.",
              retryable: true,
              status: 502,
            },
          } as SessionOutcome);
        }
        return Promise.resolve({ state: { connected: false } } as SessionOutcome);
      },
    });
    const { host, unmount } = await mount(<App client={client} />);
    await settle();
    expect(host.textContent ?? "").toMatch(/Connection problem/i);
    expect(host.textContent ?? "").toMatch(/GitHub is currently unavailable/i);

    const retry = findButton(host, /try again/i)!;
    await act(async () => {
      retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(calls).toBe(2);
    expect(host.textContent ?? "").toMatch(/Not connected to GitHub/i);
    expect(host.textContent ?? "").not.toMatch(/octocat/i);
    unmount();
  });

  it("the sample preview is clearly labeled and never implies a real connection", async () => {
    const client = makeAppClient();
    const { host, unmount } = await mount(<App client={client} />);
    await settle();

    const previewButton = findButton(host, /preview the connected layout/i)!;
    await act(async () => {
      previewButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(host.textContent ?? "").toMatch(/sample data only/i);
    expect(host.textContent ?? "").toMatch(/not a live GitHub connection/i);
    // Preview mode renders no user identity and no Disconnect control.
    expect(host.textContent ?? "").not.toMatch(/octocat/i);
    expect(findButton(host, /disconnect/i)).toBeUndefined();
    unmount();
  });
});

describe("ConnectedView avatar safety (task 3.6)", () => {
  it("does not render an avatar from a non-GitHub origin", async () => {
    const client = makeAppClient();
    const session: SessionState = {
      connected: true,
      user: {
        login: "octocat",
        avatarUrl: "https://evil.example.com/avatar.png",
      },
      csrfToken: CSRF_TOKEN,
    };
    const { host, unmount } = await mount(
      <ConnectedView client={client} session={session} />,
    );
    await flush();
    expect(host.querySelector("img.avatar")).toBeNull();
    expect(host.textContent ?? "").not.toContain("evil.example.com");
    expect(host.textContent ?? "").toMatch(/octocat/);
    unmount();
  });

  it("does not render an avatar for a non-https URL", async () => {
    const client = makeAppClient();
    const session: SessionState = {
      connected: true,
      user: {
        login: "octocat",
        avatarUrl: "http://avatars.githubusercontent.com/u/583231?v=4",
      },
      csrfToken: CSRF_TOKEN,
    };
    const { host, unmount } = await mount(
      <ConnectedView client={client} session={session} />,
    );
    await flush();
    expect(host.querySelector("img.avatar")).toBeNull();
    unmount();
  });
});

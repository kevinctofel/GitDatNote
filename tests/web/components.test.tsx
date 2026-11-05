// @vitest-environment happy-dom
import { act } from "react";
import { describe, it, expect } from "vitest";
import { mount, flush } from "./test-utils";
import { ConnectedView } from "../../src/web/components/ConnectedView";
import { DisconnectedView } from "../../src/web/components/DisconnectedView";
import { ApiError } from "../../src/web/api";
import type { ApiClient } from "../../src/web/api";
import type { Repository } from "../../src/shared/types";

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
    const client = {
      connectGithub: () => Promise.resolve({ kind: "unavailable" as const }),
    } as unknown as ApiClient;
    const { host, unmount } = await mount(<DisconnectedView client={client} />);
    const connect = Array.from(host.querySelectorAll("button")).find((b) =>
      /connect github/i.test(b.textContent ?? ""),
    );
    expect(connect).toBeDefined();
    unmount();
  });

  it("shows a labeled 'not available yet' placeholder after a 404 attempt", async () => {
    const client = {
      connectGithub: () => Promise.resolve({ kind: "unavailable" as const }),
    } as unknown as ApiClient;
    const { host, unmount } = await mount(<DisconnectedView client={client} />);
    const connect = Array.from(host.querySelectorAll("button")).find((b) =>
      /connect github/i.test(b.textContent ?? ""),
    )!;
    await act(async () => {
      connect.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(host.textContent ?? "").toMatch(/not available yet/i);
    expect(host.textContent ?? "").toMatch(/labeled placeholder|no live connection/i);
    unmount();
  });
});

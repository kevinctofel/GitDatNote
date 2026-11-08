// @vitest-environment happy-dom
import { act } from "react";
import { describe, it, expect, vi } from "vitest";
import { mount, flush } from "./test-utils";
import { ConnectedView } from "../../src/web/components/ConnectedView";
import { DisconnectedView } from "../../src/web/components/DisconnectedView";
import { ErrorView } from "../../src/web/components/ErrorView";
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

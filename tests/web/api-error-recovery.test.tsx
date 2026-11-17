// @vitest-environment happy-dom
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, rerender } from "./test-utils";
import { ApiErrorRecovery } from "../../src/web/components/ApiErrorRecovery";
import type { ErrorDetail } from "../../src/shared/types";

/** Build a well-formed ErrorDetail with the fields overridden as needed. */
function detail(overrides: Partial<ErrorDetail> = {}): ErrorDetail {
  return {
    code: "GITHUB_UNAVAILABLE",
    message: "GitHub is unreachable.",
    retryable: true,
    status: 502,
    ...overrides,
  };
}

function click(el: HTMLElement): Promise<void> {
  return act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("ApiErrorRecovery (task 4.8)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- RATE_LIMITED ----

  it("renders the required rate-limit message with a validated delay", async () => {
    const { host, unmount } = await mount(
      <ApiErrorRecovery
        detail={detail({ code: "RATE_LIMITED", retryAfterSeconds: 30 })}
        onRetry={() => {}}
      />,
    );
    expect(host.textContent ?? "").toMatch(
      /GitHub rate limit reached — try again in 30 seconds/i,
    );
    unmount();
  });

  it("does not invent a countdown when no validated timing exists", async () => {
    const { host, unmount } = await mount(
      <ApiErrorRecovery
        detail={detail({ code: "RATE_LIMITED" })}
        onRetry={() => {}}
      />,
    );
    const text = host.textContent ?? "";
    expect(text).toMatch(/GitHub rate limit reached — please try again shortly/i);
    expect(text).not.toMatch(/in \d+ seconds/i);
    // Without timing, the user can still retry explicitly.
    const button = host.querySelector("button");
    expect(button).not.toBeNull();
    expect(button!.disabled).toBe(false);
    unmount();
  });

  it("ignores invalid retry timing values", async () => {
    const invalid: unknown[] = [-5, 0.5, "30", null, NaN, 86_401, { seconds: 30 }, []];
    for (const value of invalid) {
      const { host, unmount } = await mount(
        <ApiErrorRecovery
          detail={detail({ code: "RATE_LIMITED", retryAfterSeconds: value })}
        />,
      );
      expect(host.textContent ?? "").toMatch(/please try again shortly/i);
      unmount();
    }
  });

  it("a validated zero delay enables Retry immediately without a countdown", async () => {
    const onRetry = vi.fn();
    const { host, unmount } = await mount(
      <ApiErrorRecovery
        detail={detail({ code: "RATE_LIMITED", retryAfterSeconds: 0 })}
        onRetry={onRetry}
      />,
    );
    const text = host.textContent ?? "";
    expect(text).toMatch(/GitHub rate limit reached/i);
    expect(text).not.toMatch(/try again in/i);
    expect(host.querySelector("button")!.disabled).toBe(false);
    await click(host.querySelector("button")!);
    expect(onRetry).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("disables Retry while the delay remains, then requires an explicit click", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const onRetry = vi.fn();
    const { host, unmount } = await mount(
      <ApiErrorRecovery
        detail={detail({ code: "RATE_LIMITED", retryAfterSeconds: 30 })}
        onRetry={onRetry}
      />,
    );
    const button = host.querySelector("button")!;
    const text = () => host.textContent ?? "";

    expect(text()).toMatch(/try again in 30 seconds/i);
    expect(button.disabled).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(29_000);
    });
    expect(text()).toMatch(/try again in 1 seconds/i);
    expect(button.disabled).toBe(true);
    expect(onRetry).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(text()).not.toMatch(/try again in/i);
    expect(button.disabled).toBe(false);
    // Reaching zero never submits automatically.
    expect(onRetry).not.toHaveBeenCalled();

    await click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("a pending retry cannot be submitted twice", async () => {
    const onRetry = vi.fn();
    const { host, unmount } = await mount(
      <ApiErrorRecovery
        detail={detail({ code: "GITHUB_UNAVAILABLE" })}
        onRetry={onRetry}
      />,
    );
    const button = host.querySelector("button")!;
    await click(button);
    await click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    unmount();
  });

  it("invokes the callback exactly once when clicked twice in the same batch", async () => {
    const onRetry = vi.fn();
    const { host, unmount } = await mount(
      <ApiErrorRecovery
        detail={detail({ code: "GITHUB_UNAVAILABLE" })}
        onRetry={onRetry}
      />
    );
    const button = host.querySelector("button")!;
    // Both clicks land before React commits the disabled-button state.
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    unmount();
  });

  it("replacing the error resets the guard so the new action can run", async () => {
    const onRetryFirst = vi.fn();
    const onRetrySecond = vi.fn();
    const first = detail({ code: "GITHUB_UNAVAILABLE", message: "first" });
    const m = await mount(
      <ApiErrorRecovery detail={first} onRetry={onRetryFirst} />
    );
    const button = m.host.querySelector("button")!;
    await click(button);
    expect(onRetryFirst).toHaveBeenCalledTimes(1);
    // A second click on the same error is rejected.
    await click(button);
    expect(onRetryFirst).toHaveBeenCalledTimes(1);
    // A different error object replaces it: the guard resets and the new
    // recovery action works.
    await act(async () => {
      await rerender(
        m,
        <ApiErrorRecovery
          detail={detail({ code: "RATE_LIMITED", retryAfterSeconds: 0 })}
          onRetry={onRetrySecond}
        />
      );
    });
    const secondButton = m.host.querySelector("button")!;
    expect(secondButton.disabled).toBe(false);
    await click(secondButton);
    expect(onRetrySecond).toHaveBeenCalledTimes(1);
    expect(onRetryFirst).toHaveBeenCalledTimes(1);
    m.unmount();
  });

  it("communicates an accessible pending state and accepts no submissions", async () => {
    const onRetry = vi.fn();
    const { host, unmount } = await mount(
      <ApiErrorRecovery
        detail={detail({ code: "GITHUB_UNAVAILABLE" })}
        onRetry={onRetry}
        pending
      />,
    );
    const status = host.querySelector("[role='status']");
    expect(status?.textContent ?? "").toMatch(/Retrying/i);
    expect(host.querySelectorAll("button")).toHaveLength(0);
    expect(onRetry).not.toHaveBeenCalled();
    unmount();
  });

  it("clears its countdown timer when the component unmounts", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const startSpy = vi.spyOn(window, "setInterval");
    const clearSpy = vi.spyOn(window, "clearInterval");
    const { host, unmount } = await mount(
      <ApiErrorRecovery
        detail={detail({ code: "RATE_LIMITED", retryAfterSeconds: 30 })}
      />,
    );
    expect(startSpy).toHaveBeenCalledTimes(1);
    await act(async () => {
      unmount();
    });
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(host.isConnected).toBe(false);
    // Advancing time after unmount does nothing.
    vi.advanceTimersByTime(120_000);
    vi.restoreAllMocks();
  });

  it("a replaced error does not retain the previous countdown", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const m = await mount(
      <ApiErrorRecovery
        detail={detail({ code: "RATE_LIMITED", retryAfterSeconds: 30 })}
      />,
    );
    expect(m.host.textContent ?? "").toMatch(/try again in 30 seconds/i);

    // A different error replaces the rate limit: no stale countdown text.
    await act(async () => {
      await rerender(
        m,
        <ApiErrorRecovery detail={detail({ code: "GITHUB_UNAVAILABLE" })} />,
      );
    });
    expect(m.host.textContent ?? "").toMatch(/GitHub is unreachable/i);
    expect(m.host.textContent ?? "").not.toMatch(/try again in/i);

    // A fresh rate-limit error starts its own (shorter) countdown.
    await act(async () => {
      await rerender(
        m,
        <ApiErrorRecovery
          detail={detail({ code: "RATE_LIMITED", retryAfterSeconds: 10 })}
        />,
      );
    });
    expect(m.host.textContent ?? "").toMatch(/try again in 10 seconds/i);
    m.unmount();
  });

  // ---- GITHUB_UNAVAILABLE ----

  it("renders the required unavailable message and retries the operation", async () => {
    const onRetry = vi.fn();
    const { host, unmount } = await mount(
      <ApiErrorRecovery
        detail={detail({ code: "GITHUB_UNAVAILABLE" })}
        onRetry={onRetry}
      />,
    );
    expect(host.textContent ?? "").toMatch(
      /GitHub is unreachable — check your connection and retry/i,
    );
    await click(host.querySelector("button")!);
    expect(onRetry).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("without a callback, offers guidance without a dead button", async () => {
    const { host, unmount } = await mount(
      <ApiErrorRecovery detail={detail({ code: "GITHUB_UNAVAILABLE" })} />,
    );
    expect(host.textContent ?? "").toMatch(/GitHub is unreachable/i);
    expect(host.querySelectorAll("button")).toHaveLength(0);
    unmount();
  });

  // ---- SHA_CONFLICT ----

  it("offers only Reload, wired exclusively to the reload callback — never the write", async () => {
    const onReload = vi.fn();
    const onRetry = vi.fn();
    const { host, unmount } = await mount(
      <ApiErrorRecovery
        detail={detail({ code: "SHA_CONFLICT", retryable: false, status: 409 })}
        onRetry={onRetry}
        onReload={onReload}
      />,
    );
    expect(host.textContent ?? "").toMatch(
      /This file was modified by someone else — reload and try again/i,
    );
    const buttons = Array.from(host.querySelectorAll("button"));
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toMatch(/Reload latest version/i);
    await click(buttons[0]);
    expect(onReload).toHaveBeenCalledTimes(1);
    // The failed write is never resubmitted by the recovery UI.
    expect(onRetry).not.toHaveBeenCalled();
    unmount();
  });

  it("without a reload callback, shows guidance without a misleading button", async () => {
    const { host, unmount } = await mount(
      <ApiErrorRecovery detail={detail({ code: "SHA_CONFLICT", status: 409 })} />,
    );
    expect(host.textContent ?? "").toMatch(/reload and try again/i);
    expect(host.querySelectorAll("button")).toHaveLength(0);
    unmount();
  });

  it("a conflict does not touch surrounding unsaved user content", async () => {
    let reloads = 0;
    function Harness() {
      const [draft] = useState("My unsaved notes stay here.");
      return (
        <div>
          <p>{draft}</p>
          <ApiErrorRecovery
            detail={detail({ code: "SHA_CONFLICT", status: 409 })}
            onReload={() => {
              reloads += 1;
            }}
          />
        </div>
      );
    }
    const { host, unmount } = await mount(<Harness />);
    await click(host.querySelector("button")!);
    expect(reloads).toBe(1);
    expect(host.textContent ?? "").toContain("My unsaved notes stay here.");
    unmount();
  });

  // ---- Other codes: safe generic behavior ----

  it("a retryable unknown code keeps a safe message and a working retry", async () => {
    const onRetry = vi.fn();
    const { host, unmount } = await mount(
      <ApiErrorRecovery
        detail={detail({
          code: "INTERNAL_ERROR",
          retryable: true,
          message: "secret <img src=x onerror=alert(1)>",
        })}
        onRetry={onRetry}
      />,
    );
    expect(host.textContent ?? "").toMatch(/Something went wrong/i);
    expect(host.textContent ?? "").not.toContain("secret");
    expect(host.querySelector("button")).not.toBeNull();
    unmount();
  });

  it("a non-retryable unknown code offers no retry button even when a callback is supplied", async () => {
    const { host, unmount } = await mount(
      <ApiErrorRecovery
        detail={detail({ code: "FILE_NOT_FOUND", retryable: false })}
        onRetry={() => {}}
      />,
    );
    expect(host.textContent ?? "").toMatch(/Something went wrong/i);
    expect(host.querySelectorAll("button")).toHaveLength(0);
    unmount();
  });

  // ---- Untrusted content is never rendered as UI ----

  it("never renders untrusted upstream error text for any code", async () => {
    const payload = "x <img src=x onerror=alert(1)>";
    const codes: string[] = ["RATE_LIMITED", "GITHUB_UNAVAILABLE", "SHA_CONFLICT", "UNAUTHORIZED"];
    for (const code of codes) {
      const { host, unmount } = await mount(
        <ApiErrorRecovery
          detail={detail({ code, message: payload, retryAfterSeconds: 5 })}
          onRetry={() => {}}
          onReload={() => {}}
        />,
      );
      expect(host.textContent ?? "").not.toContain(payload);
      expect(host.querySelector("img")).toBeNull();
      unmount();
    }
  });
});

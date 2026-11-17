import { useEffect, useRef, useState } from "react";
import { isValidRetryAfterSeconds } from "../../shared/errors";
import type { ErrorDetail } from "../../shared/types";

export interface ApiErrorRecoveryProps {
  /** The error detail from the operation that failed. */
  detail: ErrorDetail;
  /**
   * Retry the exact operation that failed. Must be a safe-to-retry
   * operation; the parent keeps its own request-generation guards, and
   * this component adds its own in-flight guard (state plus a synchronous
   * ref) against double submission.
   */
  onRetry?: () => void;
  /**
   * Reload the latest repository version (e.g. after a SHA conflict).
   * This callback must only read; the component never uses it to
   * resubmit a failed write.
   */
  onReload?: () => void;
  /** The recovery operation is currently in flight. */
  pending?: boolean;
}

/** Validated rate-limit delay for this detail, or null when there is none. */
function rateLimitedSeconds(detail: ErrorDetail): number | null {
  if (detail.code !== "RATE_LIMITED") return null;
  return isValidRetryAfterSeconds(detail.retryAfterSeconds)
    ? detail.retryAfterSeconds
    : null;
}

/**
 * Reusable recovery state for recoverable API failures (task 4.8).
 *
 * Renders fixed, plain-language copy for the known recoverable codes —
 * `RATE_LIMITED`, `GITHUB_UNAVAILABLE`, `SHA_CONFLICT` — and a generic safe
 * message for everything else. It never renders untrusted upstream error
 * text as UI content.
 *
 * - `RATE_LIMITED`: shows the remaining validated delay in whole seconds
 *   and keeps Retry disabled until it reaches zero. The countdown is
 *   computed from an absolute deadline and recomputed on
 *   `visibilitychange`, so a backgrounded tab shows the correct remaining
 *   time. It never submits automatically. Without validated timing the
 *   component shows "try again shortly" with an explicit Retry.
 * - `GITHUB_UNAVAILABLE`: offers Retry for the failing operation. A
 *   transient outage is never treated as session loss.
 * - `SHA_CONFLICT`: offers only "Reload latest version", wired exclusively
 *   to the caller-supplied `onReload` — never to the failed write. With no
 *   callback the guidance is shown without a button.
 *
 * When `pending` is true, the component renders an accessible "Retrying…"
 * status instead of the action. After a user click, the in-flight state
 * and a synchronous guard reject further submissions until the error is
 * replaced or cleared.
 */
export function ApiErrorRecovery({
  detail,
  onRetry,
  onReload,
  pending = false,
}: ApiErrorRecoveryProps) {
  const [remaining, setRemaining] = useState<number | null>(() =>
    rateLimitedSeconds(detail),
  );
  const [inFlight, setInFlight] = useState(false);
  // Synchronous duplicate-click guard. React state updates only commit on
  // the next render, so two rapid clicks in the same batch would both pass
  // a state-based check; this ref flips immediately on the first click.
  const clickGuard = useRef(false);

  // The countdown and the in-flight guard belong to exactly one `detail`
  // object. When the error is replaced, the previous timer is cleared and
  // the new error's timing (if any) starts fresh — an old countdown can
  // never enable the wrong operation.
  useEffect(() => {
    setInFlight(false);
    clickGuard.current = false;
    const seconds = rateLimitedSeconds(detail);
    setRemaining(seconds);
    if (seconds === null || seconds <= 0) {
      return;
    }
    const deadline = Date.now() + seconds * 1000;
    const tick = () => {
      // Recompute from the absolute deadline, not an accumulated tick.
      setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    };
    const interval = window.setInterval(tick, 1000);
    // Keep the countdown correct after the tab is backgrounded.
    const onVisibilityChange = () => tick();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [detail]);

  const busy = pending || inFlight;

  const act = (action: (() => void) | undefined) => {
    if (action === undefined || busy || clickGuard.current) return;
    clickGuard.current = true;
    setInFlight(true);
    action();
  };

  if (pending) {
    return (
      <div className="api-error-recovery">
        <p role="status" className="api-error-recovery-message">
          Retrying…
        </p>
      </div>
    );
  }

  if (detail.code === "RATE_LIMITED") {
    const countdownActive = remaining !== null && remaining > 0;
    return (
      <div className="api-error-recovery">
        <p role="alert" className="api-error-recovery-message">
          {countdownActive ? (
            <>
              GitHub rate limit reached{" "}
              {/* Per-second numbers stay out of the live alert region so
                  screen readers hear the state once, not every tick. */}
              <span className="api-error-recovery-timer" aria-live="off">
                — try again in {remaining} seconds.
              </span>
            </>
          ) : remaining === 0 ? (
            "GitHub rate limit reached — you can retry now."
          ) : (
            "GitHub rate limit reached — please try again shortly."
          )}
        </p>
        {onRetry !== undefined && (
          <button
            type="button"
            className="api-error-recovery-action"
            disabled={countdownActive || busy}
            onClick={() => act(onRetry)}
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  if (detail.code === "GITHUB_UNAVAILABLE") {
    return (
      <div className="api-error-recovery">
        <p role="alert" className="api-error-recovery-message">
          GitHub is unreachable — check your connection and retry.
        </p>
        {onRetry !== undefined && (
          <button
            type="button"
            className="api-error-recovery-action"
            disabled={busy}
            onClick={() => act(onRetry)}
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  if (detail.code === "SHA_CONFLICT") {
    // A conflict never retries the failed write; the only offered action is
    // the caller-supplied reload of the latest version.
    return (
      <div className="api-error-recovery">
        <p role="alert" className="api-error-recovery-message">
          This file was modified by someone else — reload and try again.
        </p>
        {onReload !== undefined && (
          <button
            type="button"
            className="api-error-recovery-action"
            disabled={busy}
            onClick={() => act(onReload)}
          >
            Reload latest version
          </button>
        )}
      </div>
    );
  }

  const offersRetry = detail.retryable && onRetry !== undefined;
  return (
    <div className="api-error-recovery">
      <p role="alert" className="api-error-recovery-message">
        {offersRetry
          ? "Something went wrong. You can try again."
          : "Something went wrong. Please go back and try again."}
      </p>
      {offersRetry && (
        <button
          type="button"
          className="api-error-recovery-action"
          disabled={busy}
          onClick={() => act(onRetry)}
        >
          Retry
        </button>
      )}
    </div>
  );
}

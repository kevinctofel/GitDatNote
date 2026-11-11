import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiClient } from "./api";
import type { ConnectionState } from "./types";
import { ConnectedView } from "./components/ConnectedView";
import { DisconnectedView } from "./components/DisconnectedView";
import { ErrorView } from "./components/ErrorView";

interface AppProps {
  /** Injectable API client (defaults to a real client in production). */
  client?: ApiClient;
}

/**
 * Minimal, accessible application shell (foundation tasks 2.5/3.2/3.6).
 *
 * It probes `GET /api/session` to decide between connected / disconnected /
 * error. A valid session renders the connected user's identity with a
 * Disconnect action (task 3.6); a missing or expired session lands in the
 * disconnected state with the Connect GitHub action. A clearly-labeled
 * "Preview the connected layout (sample data)" affordance lets a reviewer
 * see the connected layout without implying a live connection.
 *
 * Session loading is guarded by a request-generation counter so that stale
 * responses (out-of-order retries, or a response that lands after the
 * component unmounts) cannot overwrite the current connection state —
 * including after a successful disconnect.
 */
export function App({ client: clientProp }: AppProps = {}) {
  const defaultClient = useMemo(() => new ApiClient(), []);
  const client = clientProp ?? defaultClient;
  const [connection, setConnection] = useState<ConnectionState>({
    status: "loading",
  });
  const [preview, setPreview] = useState(false);

  // Request-generation guard: each load increments the generation; a stale
  // completion (an older load, or a response after unmount) is dropped so
  // only the latest load wins.
  const generationRef = useRef(0);

  const loadConnection = useCallback(() => {
    const generation = ++generationRef.current;
    setConnection({ status: "loading" });
    client
      .getSession()
      .then((outcome) => {
        if (generation !== generationRef.current) return;
        if (outcome.state.connected) {
          setConnection({ status: "connected", session: outcome.state });
        } else if (outcome.error) {
          setConnection({ status: "error", detail: outcome.error });
        } else {
          setConnection({ status: "disconnected" });
        }
      })
      .catch(() => {
        // An unexpected session-probe exception is a generic, retryable
        // connection error — never silently "disconnected", and never
        // exposing raw exception details.
        if (generation !== generationRef.current) return;
        setConnection({
          status: "error",
          detail: {
            code: "GITHUB_UNAVAILABLE",
            message: "A connection problem occurred. Please try again.",
            retryable: true,
            status: 502,
          },
        });
      });
  }, [client]);

  /**
   * Task 3.6: called by ConnectedView when the connection is definitively
   * gone (a confirmed logout, or a definitive 401/404). Invalidates any
   * in-flight session or repository responses and transitions to the
   * disconnected view.
   */
  const handleDisconnected = useCallback(() => {
    generationRef.current += 1;
    setConnection({ status: "disconnected" });
  }, []);

  useEffect(() => {
    loadConnection();
    // Invalidate any in-flight load on unmount so a late response cannot
    // trigger a state update on an unmounted component.
    return () => {
      generationRef.current += 1;
    };
  }, [loadConnection]);

  // Backend auth failures redirect the browser to
  // `/error?reason=<safe-code>`; render that path with fixed, safe copy
  // (never raw query values).
  const [location] = useState(() => window.location);
  if (location.pathname === "/error") {
    return (
      <div className="app">
        <header className="app-header">
          <span className="app-title">GitDatNote</span>
        </header>
        <main>
          <ErrorView search={location.search} />
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-title">GitDatNote</span>
        {connection.status === "connected" && connection.session.user && (
          <span className="session-user">
            Signed in as {connection.session.user.login}
          </span>
        )}
      </header>

      <main>
        {connection.status === "loading" && (
          <section aria-busy="true">
            <p role="status">Checking your GitHub connection…</p>
          </section>
        )}

        {connection.status === "error" && (
          <section aria-label="Connection problem">
            <h1>Connection problem</h1>
            <p role="alert">{connection.detail.message}</p>
            <p>
              GitHub sign-in and note access are unavailable until the
              connection is restored.
            </p>
            {connection.detail.retryable && (
              <button type="button" onClick={loadConnection}>
                Try again
              </button>
            )}
          </section>
        )}

        {connection.status === "disconnected" && (
          <>
            <DisconnectedView client={client} />
            <section aria-label="Connected layout preview">
              <p>
                <button
                  type="button"
                  onClick={() => setPreview((value) => !value)}
                >
                  {preview
                    ? "Hide preview"
                    : "Preview the connected layout (sample data)"}
                </button>
              </p>
            </section>
            {preview && <ConnectedView client={client} preview />}
          </>
        )}

        {connection.status === "connected" && connection.session && (
          <ConnectedView
            client={client}
            session={connection.session}
            onDisconnected={handleDisconnected}
            // Recovery for a CSRF-rejected logout: re-probe the session so a
            // still-valid session can supply its stored (possibly fresh) CSRF
            // token; a gone session reconciles to the disconnected view.
            onRecheckSession={loadConnection}
          />
        )}
      </main>
    </div>
  );
}

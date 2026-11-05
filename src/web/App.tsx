import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiClient } from "./api";
import type { ConnectionState } from "./types";
import { ConnectedView } from "./components/ConnectedView";
import { DisconnectedView } from "./components/DisconnectedView";

interface AppProps {
  /** Injectable API client (defaults to a real client in production). */
  client?: ApiClient;
}

/**
 * Minimal, accessible application shell for foundation task 2.5.
 *
 * It probes the (not-yet-implemented) `GET /api/session` endpoint to decide
 * between connected / disconnected / error. Since the backend session and
 * authentication APIs do not exist yet, the running app lands in the
 * disconnected state; a clearly-labeled "Preview the connected layout
 * (sample data)" affordance lets a reviewer see the connected layout without
 * implying a live connection.
 *
 * Session loading is guarded by a request-generation counter so that stale
 * responses (out-of-order retries, or a response that lands after the
 * component unmounts) cannot overwrite the current connection state.
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
        // A failed session probe (e.g. server unreachable) is treated as
        // "not connected" — never as a live connection.
        if (generation !== generationRef.current) return;
        setConnection({ status: "disconnected" });
      });
  }, [client]);

  useEffect(() => {
    loadConnection();
    // Invalidate any in-flight load on unmount so a late response cannot
    // trigger a state update on an unmounted component.
    return () => {
      generationRef.current += 1;
    };
  }, [loadConnection]);

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

        {connection.status === "connected" && (
          <ConnectedView client={client} />
        )}
      </main>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiClient } from "./api";
import type { ConnectionState } from "./types";
import { ConnectedView } from "./components/ConnectedView";
import { DisconnectedView } from "./components/DisconnectedView";

/**
 * Minimal, accessible application shell for foundation task 2.5.
 *
 * It probes the (not-yet-implemented) `GET /api/session` endpoint to decide
 * between connected / disconnected / error. Since the backend session and
 * authentication APIs do not exist yet, the running app lands in the
 * disconnected state; a clearly-labeled "Preview the connected layout
 * (sample data)" affordance lets a reviewer see the connected layout without
 * implying a live connection.
 */
export function App() {
  const client = useMemo(() => new ApiClient(), []);
  const [connection, setConnection] = useState<ConnectionState>({
    status: "loading",
  });
  const [preview, setPreview] = useState(false);

  const loadConnection = useCallback(() => {
    setConnection({ status: "loading" });
    client
      .getSession()
      .then((outcome) => {
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
        setConnection({ status: "disconnected" });
      });
  }, [client]);

  useEffect(() => {
    loadConnection();
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

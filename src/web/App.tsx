import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiClient } from "./api";
import type { ConnectionState } from "./types";
import { ApiErrorRecovery } from "./components/ApiErrorRecovery";
import { ConnectedView } from "./components/ConnectedView";
import { DisconnectedView } from "./components/DisconnectedView";
import { ErrorView } from "./components/ErrorView";
import { SettingsHub } from "./components/settings/SettingsHub";

/** 16px gear line icon for the Settings entry button. */
function GearIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

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
  // Settings hub (UI Task 1.4): the hub replaces the main content while
  // open; the connection state itself stays in this component, so leaving
  // the hub returns to the same view the user came from.
  const [settingsOpen, setSettingsOpen] = useState(false);

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
        <div className="app-header-right">
          {connection.status === "connected" && connection.session.user && (
            <span className="session-user">
              Signed in as {connection.session.user.login}
            </span>
          )}
          {/* Clear Settings entry (UI Task 1.4); available in every
              connection state of the normal app interface. */}
          <button
            type="button"
            className="settings-entry"
            aria-expanded={settingsOpen}
            aria-controls={settingsOpen ? "settings-hub" : undefined}
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <GearIcon />
            Settings
          </button>
        </div>
      </header>

      <main>
        {settingsOpen ? (
          <SettingsHub onBack={() => setSettingsOpen(false)} />
        ) : (
          <>
            {connection.status === "loading" && (
              <section aria-busy="true">
                <p role="status">Checking your GitHub connection…</p>
              </section>
            )}

            {connection.status === "error" && (
              <section aria-label="Connection problem">
                <h1>Connection problem</h1>
                <p>
                  GitHub sign-in and note access are unavailable until the
                  connection is restored.
                </p>
                <ApiErrorRecovery
                  detail={connection.detail}
                  onRetry={loadConnection}
                />
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
          </>
        )}
      </main>
    </div>
  );
}

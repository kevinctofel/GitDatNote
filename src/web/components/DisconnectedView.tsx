import { useState } from "react";
import type { ApiClient } from "../api";
import type { ConnectResult } from "../types";

interface DisconnectedViewProps {
  client: ApiClient;
}

/**
 * GitHub-not-connected state. Offers the clearly-labeled "Connect GitHub"
 * action. Because the auth backend is not implemented yet, a failed attempt
 * shows an explicit "not available yet" placeholder — never a fake
 * connection.
 */
export function DisconnectedView({ client }: DisconnectedViewProps) {
  const [connecting, setConnecting] = useState(false);
  const [outcome, setOutcome] = useState<ConnectResult | null>(null);

  async function handleConnect(): Promise<void> {
    setConnecting(true);
    setOutcome(null);
    const result = await client.connectGithub();
    if (result.kind === "redirect") {
      // The backend issued a real sign-in redirect — let the browser follow
      // it (this is the future OAuth flow; it does not exist yet).
      window.location.assign("/api/auth/github/start");
      return;
    }
    setOutcome(result);
    setConnecting(false);
  }

  return (
    <section aria-labelledby="disconnected-heading" className="view">
      <h1 id="disconnected-heading">Not connected to GitHub</h1>
      <p>
        GitDatNote reads and writes your notes through GitHub. You are not
        signed in.
      </p>
      <button type="button" onClick={handleConnect} disabled={connecting}>
        {connecting ? "Connecting…" : "Connect GitHub"}
      </button>

      {outcome?.kind === "unavailable" && (
        <p role="status">
          <strong>GitHub sign-in is not available yet.</strong> The connection
          backend has not been implemented in this build. This is a labeled
          placeholder — no live connection was made.
        </p>
      )}
      {outcome?.kind === "error" && (
        <p role="alert">
          {outcome.detail.message}
          {outcome.detail.retryable ? " You can retry." : ""}
        </p>
      )}
    </section>
  );
}

import type { ApiClient } from "../api";

interface DisconnectedViewProps {
  client: ApiClient;
}

/**
 * GitHub-not-connected state. Offers the clearly-labeled "Connect GitHub"
 * action.
 *
 * A click performs exactly ONE top-level navigation to
 * `/api/auth/github/start` — no fetch probe. Every failure mode is owned by
 * the server, which answers with a safe, labeled error page or redirects
 * the browser to `/error?reason=<safe-code>`; the app renders that path
 * with fixed, safe copy (see `ErrorView`), never raw query values.
 */
export function DisconnectedView({ client }: DisconnectedViewProps) {
  function handleConnect(): void {
    client.connectGithub();
  }

  return (
    <section aria-labelledby="disconnected-heading" className="view">
      <h1 id="disconnected-heading">Not connected to GitHub</h1>
      <p>
        GitDatNote reads and writes your notes through GitHub. You are not
        signed in.
      </p>
      <button type="button" onClick={handleConnect}>
        Connect GitHub
      </button>
    </section>
  );
}

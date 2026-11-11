import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import type { ApiClient } from "../api";
import type { ErrorDetail, Repository } from "../../shared/types";
import type { SessionState, SessionUser } from "../types";
import { FIXTURE_REPOSITORIES } from "../fixtures";
import { getPreviewMarkdown } from "../preview-overrides";
import { MarkdownPreview } from "./MarkdownPreview";
import { RepositorySelector } from "./RepositorySelector";

type RepoListState =
  | { status: "loading" }
  | { status: "error"; detail: ErrorDetail }
  | { status: "ready"; repositories: Repository[] };

function toDetail(err: unknown): ErrorDetail {
  if (err instanceof ApiError) return err.detail;
  return {
    code: "INTERNAL_ERROR",
    message: "Something went wrong loading repositories.",
    retryable: true,
    status: 500,
  };
}

/**
 * The only avatar source the UI will render: an https URL on GitHub's own
 * avatar host. Anything else (protocol-relative, javascript:, other
 * origins) is omitted rather than displayed.
 */
function safeAvatarUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "avatars.githubusercontent.com"
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/**
 * A definitive session-invalid outcome: the server confirmed the logout
 * (handled separately) or definitively reported the session as gone.
 *
 * The shared error code is preferred over the HTTP status alone:
 * `UNAUTHORIZED` is the session-gone code, and a bare 404 likewise means
 * the endpoint no longer knows this session. A 403 `CSRF_INVALID` is
 * NOT a session loss — the centralized CSRF boundary rejects the request
 * without deleting the session — so it must not reconcile to the
 * disconnected state.
 */
function isSessionLost(detail: ErrorDetail): boolean {
  if (detail.code === "UNAUTHORIZED") return true;
  return detail.status === 401 || detail.status === 404;
}

type LogoutState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "failed"; detail: ErrorDetail };

/**
 * Connected-identity block (task 3.6): the user's GitHub login (and name),
 * a safe avatar when one is supplied, a "connected" status line, and the
 * Disconnect action.
 *
 * Disconnect semantics:
 * - a synchronous in-flight guard prevents duplicate logout requests;
 * - the pending state is announced via `role="status"`;
 * - success or a definitive 401 UNAUTHORIZED/404 reconciles to the
 *   disconnected view through `onDisconnected` exactly once;
 * - a 403 `CSRF_INVALID` is NOT a successful logout: the CSRF boundary
 *   rejected the request without deleting the session. The view stays
 *   connected, explains the failure safely, and offers a session
 *   recheck (which fetches the stored, possibly fresh, CSRF token)
 *   instead of resending the rejected token. Other 403 errors likewise
 *   do not imply session invalidation and keep the plain retry;
 * - any other failure (429, 5xx, network) shows a recoverable
 *   `role="alert"` message and leaves the button available to retry — the
 *   UI never claims a disconnect that the server did not confirm.
 * - a connected session without a usable CSRF token offers no disconnect
 *   control at all (no unprotected logout is ever issued).
 */
function ConnectedIdentity({
  user,
  csrfToken,
  client,
  onDisconnected,
  onRecheckSession,
}: {
  user: SessionUser;
  csrfToken?: string;
  client: ApiClient;
  onDisconnected?: () => void;
  /**
   * Recheck the session after a logout was rejected by the CSRF boundary:
   * the server-side session may still be valid and the probe returns the
   * stored (possibly fresh) CSRF token.
   */
  onRecheckSession?: () => void;
}) {
  const [logout, setLogout] = useState<LogoutState>({ status: "idle" });
  const inFlightRef = useRef(false);
  const avatar = safeAvatarUrl(user.avatarUrl);

  const handleDisconnect = useCallback(async () => {
    if (inFlightRef.current) return; // no duplicate logout requests
    if (csrfToken === undefined || csrfToken.length === 0) return;
    inFlightRef.current = true;
    setLogout({ status: "pending" });
    try {
      await client.disconnectGithub(csrfToken);
      onDisconnected?.();
    } catch (err) {
      const detail = toDetail(err);
      if (isSessionLost(detail)) {
        // The server says the session is already gone: reconcile directly
        // instead of reporting a failed disconnect.
        onDisconnected?.();
      } else {
        setLogout({ status: "failed", detail });
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [client, csrfToken, onDisconnected]);

  return (
    <div className="session-identity">
      {avatar !== null && (
        <img className="avatar" src={avatar} alt={`Avatar of ${user.login}`} />
      )}
      <div>
        <p className="identity-login">
          {user.name ? `${user.name} (${user.login})` : user.login}
        </p>
        <p className="identity-status">Connected to GitHub</p>
      </div>
      {csrfToken !== undefined && csrfToken.length > 0 ? (
        <div className="identity-actions">
          {logout.status === "pending" && (
            <span className="logout-status" role="status">
              Disconnecting…
            </span>
          )}
          {logout.status === "failed" && (
            <span className="logout-error" role="alert">
              Couldn&apos;t disconnect: {logout.detail.message}
            </span>
          )}
          {logout.status === "failed" &&
          logout.detail.code === "CSRF_INVALID" ? (
            /* The CSRF boundary rejected the request; the server-side
               session may still be valid. Do not resend the rejected
               token: recheck the session to obtain the stored (possibly
               fresh) CSRF token. */
            <>
              <p className="logout-recovery-note">
                Your GitHub connection is still active.
              </p>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => onRecheckSession?.()}
              >
                Recheck session
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn-secondary"
              disabled={logout.status === "pending"}
              onClick={() => void handleDisconnect()}
            >
              {logout.status === "pending" ? "Disconnecting…" : "Disconnect"}
            </button>
          )}
        </div>
      ) : (
        // A connected session without a usable CSRF token cannot be
        // disconnected safely — offer no unprotected logout action.
        <p className="identity-note">
          Sign-out is unavailable for this session.
        </p>
      )}
    </div>
  );
}

interface ConnectedViewProps {
  client: ApiClient;
  /**
   * The current session (tasks 3.2/3.4). When present — and not in preview
   * mode — renders the connected user's identity and the Disconnect
   * control. Preview mode never receives a session.
   */
  session?: SessionState;
  /**
   * When true, this view renders sample data with an explicit preview
   * banner instead of fetching from the backend. It is used to
   * demonstrate the connected-state layout; it is never a live connection.
   */
  preview?: boolean;
  /**
   * Called exactly once when the connection is definitively gone: a
   * confirmed logout (204), or a definitive 401/404 from logout or
   * repository discovery. The parent transitions to the disconnected view.
   */
  onDisconnected?: () => void;
  /**
   * Recheck the session (`GET /api/session`) after a logout is rejected by
   * the CSRF boundary: the server-side session may still be valid and the
   * probe returns the stored (possibly fresh) CSRF token.
   */
  onRecheckSession?: () => void;
}

/**
 * Connected-state layout: the connected user's identity with a Disconnect
 * action (task 3.6), a repository selector, and a content area with
 * explicit loading, empty, and error states. The backend content API
 * exists (task 3.4); UI content display is a later foundation task, so in
 * non-preview mode the content area shows a labeled placeholder. In
 * preview mode the safe Markdown renderer is demonstrated with sample
 * content.
 *
 * Repository loading is guarded by a request-generation counter so that
 * stale responses (out-of-order retries, or a response that lands after
 * the component unmounts) cannot overwrite the current list state.
 */
export function ConnectedView({
  client,
  session,
  preview = false,
  onDisconnected,
  onRecheckSession,
}: ConnectedViewProps) {
  const [repos, setRepos] = useState<RepoListState>({ status: "loading" });
  const [selected, setSelected] = useState<Repository | null>(null);

  // Request-generation guard: each load increments the generation; a stale
  // completion (an older load, or a response after unmount) is dropped so
  // only the latest load wins.
  const generationRef = useRef(0);

  const loadRepos = useCallback(() => {
    const generation = ++generationRef.current;
    setRepos({ status: "loading" });
    if (preview) {
      // Labeled sample data only — never a live connection.
      setRepos({ status: "ready", repositories: FIXTURE_REPOSITORIES });
      return;
    }
    client
      .listRepositories()
      .then((repositories) => {
        if (generation !== generationRef.current) return;
        setRepos({ status: "ready", repositories });
      })
      .catch((err) => {
        if (generation !== generationRef.current) return;
        const detail = toDetail(err);
        // A definitive session-invalid response reconciles to the
        // disconnected state instead of showing a repository error.
        if (isSessionLost(detail)) {
          generationRef.current += 1; // drop any further stale responses
          onDisconnected?.();
          return;
        }
        setRepos({ status: "error", detail });
      });
  }, [client, preview, onDisconnected]);

  useEffect(() => {
    loadRepos();
    // Invalidate any in-flight load on unmount.
    return () => {
      generationRef.current += 1;
    };
  }, [loadRepos]);

  // Reconcile the selected repository against each refreshed list: clear it
  // if the repository disappeared, or refresh its details if its permissions
  // or metadata changed.
  useEffect(() => {
    if (repos.status !== "ready" || selected === null) return;
    const fresh = repos.repositories.find(
      (repository) =>
        repository.owner === selected.owner &&
        repository.name === selected.name,
    );
    if (fresh === undefined) {
      setSelected(null);
      return;
    }
    if (
      fresh.contentRoot !== selected.contentRoot ||
      fresh.canRead !== selected.canRead ||
      fresh.canWrite !== selected.canWrite ||
      fresh.private !== selected.private
    ) {
      setSelected(fresh);
    }
  }, [repos, selected]);

  return (
    <div className="connected">
      {preview && (
        <p role="status" className="preview-banner">
          <strong>Preview — sample data only.</strong> This is not a live
          GitHub connection.
        </p>
      )}

      {!preview && session?.connected && (
        <ConnectedIdentity
          user={session.user}
          csrfToken={session.csrfToken}
          client={client}
          onDisconnected={onDisconnected}
          onRecheckSession={onRecheckSession}
        />
      )}

      <RepositorySelector
        repositories={repos.status === "ready" ? repos.repositories : []}
        selected={selected}
        onSelect={setSelected}
      />

      <section aria-label="Repository content" className="content-area">
        {repos.status === "loading" && (
          <p role="status">Loading repositories…</p>
        )}

        {repos.status === "error" && (
          <div role="alert">
            <p>{repos.detail.message}</p>
            {repos.detail.retryable && (
              <button type="button" onClick={loadRepos}>
                Retry
              </button>
            )}
          </div>
        )}

        {repos.status === "ready" && repos.repositories.length === 0 && (
          <p>No repositories are available for your account.</p>
        )}

        {repos.status === "ready" && repos.repositories.length > 0 && (
          <>
            {selected === null && (
              <p>Select a repository to view its content.</p>
            )}
            {selected !== null && (
              <div>
                <h2>
                  {selected.owner}/{selected.name}
                </h2>
                <ul className="repo-meta">
                  <li>
                    Access:{" "}
                    {selected.canWrite
                      ? "read + write"
                      : selected.canRead
                        ? "read-only"
                        : "none"}
                  </li>
                  <li>Visibility: {selected.private ? "private" : "public"}</li>
                </ul>
                {preview ? (
                  <MarkdownPreview markdown={getPreviewMarkdown()} />
                ) : (
                  <p>
                    Repository content reading is not implemented yet — a later
                    foundation task.
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

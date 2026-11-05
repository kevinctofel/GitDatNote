import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import type { ApiClient } from "../api";
import type { ErrorDetail, Repository } from "../../shared/types";
import { FIXTURE_REPOSITORIES, FIXTURE_SAMPLE_MARKDOWN } from "../fixtures";
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

interface ConnectedViewProps {
  client: ApiClient;
  /**
   * When true, this view renders sample data with an explicit preview banner
   * instead of fetching from the (not-yet-implemented) backend. It is used to
   * demonstrate the connected-state layout; it is never a live connection.
   */
  preview?: boolean;
}

/**
 * Connected-state layout: a repository selector plus a content area with
 * explicit loading, empty, and error states. In foundation task 2.5 the
 * content service is not implemented, so repository content reading is a
 * labeled placeholder; the safe Markdown renderer is demonstrated with
 * sample content in preview mode.
 *
 * Repository loading is guarded by a request-generation counter so that stale
 * responses (out-of-order retries, or a response that lands after the
 * component unmounts) cannot overwrite the current list state.
 */
export function ConnectedView({ client, preview = false }: ConnectedViewProps) {
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
        setRepos({ status: "error", detail: toDetail(err) });
      });
  }, [client, preview]);

  useEffect(() => {
    loadRepos();
    // Invalidate any in-flight load on unmount.
    return () => {
      generationRef.current += 1;
    };
  }, [loadRepos]);

  return (
    <div className="connected">
      {preview && (
        <p role="status" className="preview-banner">
          <strong>Preview — sample data only.</strong> This is not a live
          GitHub connection.
        </p>
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
                  <MarkdownPreview markdown={FIXTURE_SAMPLE_MARKDOWN} />
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

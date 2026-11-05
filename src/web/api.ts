import {
  mapGithubHttpError,
  mapGithubNetworkError,
} from "../shared/errors";
import type {
  ContentResult,
  ErrorDetail,
  ErrorResponse,
  Repository,
} from "../shared/types";
import type { ConnectResult, SessionState } from "./types";

/** A client-facing error that carries the shared error contract. */
export class ApiError extends Error {
  constructor(public readonly detail: ErrorDetail) {
    super(detail.message);
    this.name = "ApiError";
  }
}

/** Result of probing `GET /api/session`. */
export interface SessionOutcome {
  state: SessionState;
  /** Present when the session check failed for a reason other than
   * "simply not connected" (e.g. server error / unreachable). */
  error?: ErrorDetail;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Thin, typed API client. It talks to the (not-yet-implemented) backend
 * endpoints and maps every failure onto the shared error contract so the UI
 * can distinguish retryable from non-retryable failures.
 *
 * It never fakes success: a 404 (endpoint absent) or 401 (no session) on the
 * session probe reports "not connected", not a live connection.
 */
export class ApiClient {
  private readonly fetchImpl: FetchLike;

  constructor(
    fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
  ) {
    this.fetchImpl = fetchImpl;
  }

  async getSession(): Promise<SessionOutcome> {
    try {
      const state = await this.request<SessionState>("/api/session");
      return { state };
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.detail.status === 401 || err.detail.status === 404) {
          return { state: { connected: false } };
        }
        return { state: { connected: false }, error: err.detail };
      }
      throw err;
    }
  }

  async listRepositories(): Promise<Repository[]> {
    return this.request<Repository[]>("/api/repositories");
  }

  async readContent(
    owner: string,
    repo: string,
    path: string,
  ): Promise<ContentResult> {
    const query = new URLSearchParams({ path }).toString();
    return this.request<ContentResult>(
      `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/content?${query}`,
    );
  }

  /**
   * Attempt to start GitHub sign-in by reaching the (not-yet-implemented)
   * `/api/auth/github/start` endpoint. A real redirect means the browser
   * should follow it; a 404 means the backend is not implemented yet and the
   * UI should show a labeled "not available" placeholder.
   */
  async connectGithub(): Promise<ConnectResult> {
    try {
      const res = await this.fetchImpl("/api/auth/github/start", {
        redirect: "manual",
      });
      const isRedirect =
        res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400);
      if (isRedirect) return { kind: "redirect" };
      if (res.status === 404) return { kind: "unavailable" };
      return { kind: "error", detail: await errorDetailFromResponse(res) };
    } catch {
      return { kind: "error", detail: mapGithubNetworkError() };
    }
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(path, init);
    } catch {
      throw new ApiError(mapGithubNetworkError());
    }
    if (res.ok) {
      return (await res.json()) as T;
    }
    throw new ApiError(await errorDetailFromResponse(res));
  }
}

/**
 * Extract the shared `ErrorDetail` from an error response. Prefers a well-formed
 * `{ error: {...} }` body; otherwise maps the HTTP status conservatively.
 */
async function errorDetailFromResponse(res: Response): Promise<ErrorDetail> {
  try {
    const body = (await res.json()) as unknown;
    if (isErrorResponse(body)) return body.error;
  } catch {
    /* non-JSON body: fall through to status-based mapping */
  }
  return mapGithubHttpError(res.status);
}

function isErrorResponse(value: unknown): value is ErrorResponse {
  if (typeof value !== "object" || value === null) return false;
  const detail = (value as ErrorResponse).error;
  return (
    typeof detail === "object" &&
    detail !== null &&
    typeof detail.code === "string" &&
    typeof detail.message === "string" &&
    typeof detail.retryable === "boolean" &&
    typeof detail.status === "number"
  );
}

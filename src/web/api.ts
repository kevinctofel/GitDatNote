import {
  errorDetail,
  ERROR_CODES,
  mapGithubHttpError,
  mapGithubNetworkError,
} from "../shared/errors";
import type {
  ContentResult,
  ErrorDetail,
  ErrorDomain,
  ErrorResponse,
  ErrorStatus,
  Repository,
} from "../shared/types";
import type { SessionState } from "./types";
import {
  contentResultSchema,
  repositoryListSchema,
  sessionStateSchema,
} from "./api-schemas";

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
   * "simply not connected" (e.g. server error / unreachable / malformed). */
  error?: ErrorDetail;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * A minimal runtime validator: validates parsed JSON and reports success.
 * Structurally satisfied by a Zod schema (`safeParse(data) -> { success }`).
 * Kept structural (not a Zod generic) so the client does not depend on a
 * specific Zod version's type surface.
 */
type Validator = {
  safeParse(data: unknown): { success: boolean };
};

/**
 * A safe, understandable error for a 2xx response whose body is not the
 * expected JSON shape (unparseable JSON, or valid JSON of the wrong shape).
 * Reuses the existing `INTERNAL_ERROR` contract — no new shared type is added.
 */
const MALFORMED_RESPONSE: ErrorDetail = {
  code: "INTERNAL_ERROR",
  message: "The server returned an unexpected response. Please try again.",
  retryable: true,
  status: 500,
};

/**
 * Session-bound CSRF token shape — the exact format the server issues and
 * validates (foundation task 3.4: 32 random bytes, hex-encoded).
 */
const CSRF_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Thin, typed API client (foundation tasks 3.2/3.4/3.6). It talks to the
 * backend endpoints and maps every failure onto the shared error contract so
 * the UI can distinguish retryable from non-retryable failures.
 *
 * It never fakes success: a 404 (endpoint absent) or 401 (no session) on the
 * session probe reports "not connected", not a live connection. Successful
 * (2xx) JSON bodies are validated at runtime against the shared domain
 * shapes so a malformed body becomes a safe, understandable error instead of
 * a rendering crash.
 */
export class ApiClient {
  private readonly fetchImpl: FetchLike;

  constructor(
    fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
  ) {
    this.fetchImpl = fetchImpl;
  }

  /**
   * Probe the current session (foundation task 3.2). A connected session
   * carries the session-specific `csrfToken` (foundation task 3.4), which is
   * the only token `disconnectGithub` accepts. A connected session without
   * a usable token is still valid for reading: the UI renders the connected
   * state but does not offer an unprotected disconnect.
   */
  async getSession(): Promise<SessionOutcome> {
    try {
      const state = await this.request<SessionState>(
        "/api/session",
        sessionStateSchema,
      );
      return { state };
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.detail.status === 401 || err.detail.status === 404) {
          return { state: { connected: false } }
        }
        return { state: { connected: false }, error: err.detail };
      }
      throw err;
    }
  }

  async listRepositories(): Promise<Repository[]> {
    return this.request<Repository[]>("/api/repositories", repositoryListSchema);
  }

  async readContent(
    owner: string,
    repo: string,
    path: string,
  ): Promise<ContentResult> {
    const query = new URLSearchParams({ path }).toString();
    return this.request<ContentResult>(
      `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/content?${query}`,
      contentResultSchema,
    );
  }

  /**
   * Start GitHub sign-in with exactly one top-level navigation to
   * `/api/auth/github/start` — no fetch probe. The server owns every failure
   * mode: it answers with a safe, labeled error page or redirects the
   * browser to `/error?reason=<safe-code>`, which the app renders with
   * fixed, safe copy (see `ErrorView`).
   */
  connectGithub(): void {
    window.location.assign("/api/auth/github/start");
  }

  /**
   * End the current GitHub session (foundation task 3.6) via
   * `POST /api/auth/logout`.
   *
   * The HttpOnly session cookie travels with the same-origin request
   * automatically. The session-specific CSRF token (returned by
   * `GET /api/session`) is sent exclusively in the `X-CSRF-Token` header —
   * never in the query string, request body, or cookie — and is never
   * logged, rendered, or persisted. This is the only CSRF mechanism.
   *
   * A missing or malformed token rejects before any network request is
   * made, so a connected session without a usable token can never issue an
   * unprotected logout. HTTP 204 with no body is success; every other
   * outcome maps to the shared `ApiError`/`ErrorDetail` contract.
   */
  async disconnectGithub(csrfToken: string): Promise<void> {
    if (!CSRF_TOKEN_PATTERN.test(csrfToken)) {
      throw new ApiError(errorDetail("CSRF_INVALID"));
    }
    let res: Response;
    try {
      res = await this.fetchImpl("/api/auth/logout", {
        method: "POST",
        headers: { "X-CSRF-Token": csrfToken },
      });
    } catch {
      // Transport failure (no response at all) — a retryable connection error.
      throw new ApiError(mapGithubNetworkError());
    }
    if (res.status === 204) return;
    throw new ApiError(await errorDetailFromResponse(res));
  }

  private async request<T>(
    path: string,
    schema?: Validator,
    init?: RequestInit,
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(path, init);
    } catch {
      // Transport failure (no response at all) — a retryable connection error,
      // distinct from an expected signed-out 401/404.
      throw new ApiError(mapGithubNetworkError());
    }
    if (res.ok) {
      const data = await this.parseJson(res);
      if (schema) {
        const parsed = schema.safeParse(data);
        if (!parsed.success) {
          // A valid HTTP 200 with a malformed / wrong-shape body: a safe,
          // understandable error instead of a rendering crash.
          throw new ApiError(MALFORMED_RESPONSE);
        }
      }
      return data as T;
    }
    throw new ApiError(await errorDetailFromResponse(res));
  }

  /**
   * Parse a 2xx JSON body. A body that is not valid JSON becomes a safe
   * `MALFORMED_RESPONSE` error rather than propagating a raw `SyntaxError`.
   */
  private async parseJson(res: Response): Promise<unknown> {
    try {
      return (await res.json()) as unknown;
    } catch {
      throw new ApiError(MALFORMED_RESPONSE);
    }
  }
}

/**
 * Extract the shared `ErrorDetail` from an error response.
 *
 * Accepts both wire shapes the server emits: the standard
 * `{ "error": ErrorDetail }` envelope (content-operation routes) and the
 * bare `ErrorDetail` body (auth routes and the centralized CSRF boundary,
 * which share `sendJson`). For a bare body, `status` mirrors the actual
 * HTTP status unless the body carries a valid one. Anything else maps the
 * HTTP status conservatively.
 */
async function errorDetailFromResponse(res: Response): Promise<ErrorDetail> {
  try {
    const body = (await res.json()) as unknown;
    if (isErrorResponse(body)) return body.error;
    if (isBareErrorDetail(body)) {
      return {
        code: body.code as ErrorDomain,
        message: body.message,
        retryable: body.retryable,
        status: isErrorStatus(body.status)
          ? body.status
          : mapGithubHttpError(res.status).status,
      };
    }
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

/**
 * A bare (unwrapped) error body: a structurally valid `ErrorDetail` whose
 * `code` is a known shared domain — the shape the auth routes and the CSRF
 * boundary send via their shared `sendJson` helper.
 */
type BareErrorDetail = {
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
};

function isBareErrorDetail(value: unknown): value is BareErrorDetail {
  if (typeof value !== "object" || value === null || "error" in value) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.code === "string" &&
    v.code in ERROR_CODES &&
    typeof v.message === "string" &&
    typeof v.retryable === "boolean" &&
    (v.status === undefined || typeof v.status === "number")
  );
}

function isErrorStatus(value: number | undefined): value is ErrorStatus {
  return (
    typeof value === "number" &&
    [400, 401, 403, 404, 409, 422, 429, 500, 502].includes(value)
  );
}

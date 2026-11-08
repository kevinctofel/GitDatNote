import type { ErrorDetail } from "../shared/types";

/**
 * Web-layer view models.
 *
 * The backend session shape is provisional until foundation task 3.2
 * implements `GET /api/session`. Error handling always uses the shared
 * contract from `src/shared/errors.ts` / `src/shared/types.ts`.
 */
export interface SessionUser {
  login: string;
  name?: string | null;
  avatarUrl?: string;
}

/**
 * A session probe result. A connected session MUST carry a valid user
 * identity; a disconnected session MUST NOT. Inconsistent combinations
 * (connected without a user, or disconnected with a user) are invalid and
 * are rejected at the boundary.
 */
export type SessionState =
  | { connected: true; user: SessionUser; csrfToken?: string }
  | { connected: false; user?: null };

/** Connection-state machine for the application shell. */
export type ConnectionState =
  | { status: "loading" }
  | { status: "disconnected" }
  | { status: "connected"; session: SessionState }
  | { status: "error"; detail: ErrorDetail };

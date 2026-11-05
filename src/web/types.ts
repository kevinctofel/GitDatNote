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
  name?: string;
  avatarUrl?: string;
}

export interface SessionState {
  connected: boolean;
  user?: SessionUser;
  csrfToken?: string;
}

/** Connection-state machine for the application shell. */
export type ConnectionState =
  | { status: "loading" }
  | { status: "disconnected" }
  | { status: "connected"; session: SessionState }
  | { status: "error"; detail: ErrorDetail };

/**
 * Result of attempting to reach the (not-yet-implemented) GitHub auth
 * endpoint. `unavailable` is a local, clearly-labeled placeholder state —
 * it is NOT a backend error-contract entry and is never presented as a
 * successful connection.
 */
export type ConnectResult =
  | { kind: "redirect" }
  | { kind: "unavailable" }
  | { kind: "error"; detail: ErrorDetail };

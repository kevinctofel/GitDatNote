import type { ErrorDetail } from "../shared/types";

/**
 * The web layer's session state (foundation tasks 3.2/3.4/3.6).
 *
 * Mirrors the `GET /api/session` response: `connected` plus, when
 * connected, the user identity and (task 3.4) the session-specific CSRF
 * token that `ApiClient.disconnectGithub` sends in the `X-CSRF-Token`
 * header.
 *
 * A connected session may lack a usable `csrfToken` (an older server, or a
 * 2xx body that passed shape validation without it). Such a session is
 * still valid for reading: the UI renders the connected state but does not
 * offer a disconnect, because the client refuses to issue an unprotected
 * logout request.
 */
export interface SessionUser {
  login: string;
  name?: string | null;
  avatarUrl?: string;
}

export type SessionState =
  | { connected: true; user: SessionUser; csrfToken?: string }
  | { connected: false; user?: null };

/**
 * App-level connection state machine.
 *
 * - `loading` — the initial session probe is in flight.
 * - `disconnected` — no valid session (never signed in, or signed out).
 * - `connected` — a valid session with the connected user's identity.
 * - `error` — the session check failed for a reason other than "simply not
 *   connected" (server error, unreachable, or malformed response).
 */
export type ConnectionState =
  | { status: "loading" }
  | { status: "disconnected" }
  | { status: "connected"; session: SessionState }
  | { status: "error"; detail: ErrorDetail };

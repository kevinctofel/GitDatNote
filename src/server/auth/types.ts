/**
 * Shared types for the GitHub App user authorization foundation (task 3.2).
 */

/** Validated GitHub App web-flow configuration (server-side only). */
export interface AuthConfig {
  /** GitHub App client ID (alphanumeric string, never the numeric App ID). */
  readonly clientId: string;
  /** GitHub App client secret (never logged). */
  readonly clientSecret: string;
  /** Absolute callback URL registered with the GitHub App. */
  readonly callbackUrl: string;
}

/** Stable reasons configuration validation can fail with. */
export type AuthConfigReason =
  | 'missing_client_id'
  | 'invalid_client_id'
  | 'missing_client_secret'
  | 'invalid_client_secret'
  | 'missing_callback_url'
  | 'invalid_callback_url';

export type AuthConfigResult =
  | { readonly status: 'ok'; readonly config: AuthConfig }
  | { readonly status: 'unconfigured'; readonly reason: AuthConfigReason };

/**
 * Stable internal authorization error codes. Routes translate these to safe
 * client responses; the underlying detail is never exposed verbatim.
 */
export type AuthErrorCode =
  | 'AUTH_NOT_CONFIGURED'
  | 'STATE_INVALID'
  | 'STATE_EXPIRED'
  | 'STATE_REPLAYED'
  | 'CONSENT_DENIED'
  | 'TOKEN_ERROR'
  | 'PROFILE_ERROR'
  | 'SESSION_ERROR'
  | 'DISCOVERY_LIMIT_EXCEEDED'
  | 'DISCOVERY_LINK_UNTRUSTED'
  | 'GITHUB_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'INTERNAL';

/** Error thrown inside the auth layer; routes translate it to a safe response. */
export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Result of a one-time pending-state consumption attempt. */
export type ConsumeResult =
  | { readonly kind: 'consumed'; readonly verifier: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'replayed' };

/**
 * Server-side store for pending authorization attempts. Each record is
 * consumed exactly once and carries a short bounded lifetime.
 */
export interface PendingStateStore {
  create(state: string, verifier: string, nowMs: number): void;
  consume(state: string, nowMs: number): ConsumeResult;
  purgeExpired(nowMs: number): number;
  close(): void;
}

/** User identity retrieved from GitHub `/user`. */
export interface GitHubUser {
  readonly login: string;
  /** GitHub `name` is nullable; callers must handle `null`. */
  readonly name: string | null;
  readonly avatarUrl: string;
}

/** Token response data validated from the OAuth token endpoint. */
export interface TokenResponseData {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Access token lifetime in whole seconds (> 0). */
  readonly accessExpiresIn: number;
  /** Refresh token lifetime in whole seconds (> 0). */
  readonly refreshExpiresIn: number;
}

/** A repository accessible to the user through one of the App's installations. */
export interface DiscoveredRepository {
  readonly owner: string;
  readonly name: string;
  readonly canRead: boolean;
  readonly canWrite: boolean;
  readonly isPrivate: boolean;
}

/**
 * An App installation reported by `GET /user/installations` (normalized
 * subset). `permissions` is the installation-level permission map GitHub
 * reports (e.g. `{ contents: "read" }`); it is the App's permission on the
 * repositories inside this installation's selected repository set.
 */
export interface InstallationInfo {
  readonly id: number;
  readonly account: { readonly login: string; readonly id: number } | null;
  readonly permissions: Record<string, unknown>;
  /** `null` when the installation is active. */
  readonly suspendedAt: string | null;
}

/**
 * A repository reported by
 * `GET /user/installations/{installation_id}/repositories` (normalized
 * subset). `permissions` is the connected user's per-repository permission
 * map (`pull`/`push` booleans).
 */
export interface InstallationRepositoryInfo {
  readonly owner: string;
  readonly name: string;
  readonly isPrivate: boolean;
  readonly permissions: Record<string, unknown>;
}

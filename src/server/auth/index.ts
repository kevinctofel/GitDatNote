/**
 * Public entry point for the GitHub App user authorization foundation
 * (task 3.2).
 */

export { resolveAuthConfig } from './config.js';
export {
  GITHUB_AUTHORIZATION_URL,
  GITHUB_TOKEN_URL,
  GITHUB_API_BASE,
  GITHUB_APP_SCOPE,
  PENDING_AUTH_TTL_MS,
  REFRESH_TOKEN_DEFAULT_TTL_SECONDS,
} from './config.js';
export { openPendingStateStore } from './state.js';
export {
  PENDING_AUTH_COOKIE,
  issuePendingAuthCookie,
  clearPendingAuthCookie,
  parsePendingAuthCookie,
} from './cookies.js';
export {
  exchangeUserToken,
  fetchUserProfile,
  listAccessibleRepositories,
} from './github.js';
export {
  handleAuthStart,
  handleAuthCallback,
  handleSession,
  handleLogout,
  handleRepositories,
  type AuthRouteDeps,
} from './routes.js';
export {
  AuthError,
  type AuthConfig,
  type AuthConfigReason,
  type AuthConfigResult,
  type AuthErrorCode,
  type ConsumeResult,
  type DiscoveredRepository,
  type GitHubUser,
  type PendingStateStore,
  type TokenResponseData,
} from './types.js';

/**
 * GitHub App web-flow configuration (task 3.2, design.md A-03).
 *
 * Environment contract:
 * - `GITHUB_APP_CLIENT_ID` required; the GitHub App client ID — an
 *   alphanumeric string such as `Iv1.ab1112223334445c`, NOT the numeric
 *   App ID.
 * - `GITHUB_APP_CLIENT_SECRET` required; used only server-side during
 *   authorization-code exchange. Never logged or exposed to the browser.
 * - `GITHUB_OAUTH_CALLBACK_URL` required; the absolute URL registered with
 *   the GitHub App (must match exactly what the App has configured).
 *
 * `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are App-level credentials for
 * GitHub API App authentication; they are NOT part of this user web flow and
 * must never be used for user token exchange.
 *
 * Validation is strict and reports a stable reason. No values (valid or
 * invalid) are logged by this module.
 */

import type { AuthConfigResult } from './types.js';

/** GitHub's authorization endpoint for the App web flow. */
export const GITHUB_AUTHORIZATION_URL = 'https://github.com/login/oauth/authorize';
/** GitHub's token endpoint for authorization-code exchange. */
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
/** GitHub REST API base. */
export const GITHUB_API_BASE = 'https://api.github.com';

/**
 * The only scope the GitHub App web flow supports. GitHub Apps do not use
 * traditional OAuth scopes to grant repository access; repository access is
 * controlled by the App's declared permissions and the user's installations.
 *
 * Source: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
 * (OpenSpec task 3.2 wording was corrected accordingly — see audit.md.)
 */
export const GITHUB_APP_SCOPE = 'offline_access';

/** Pending authorizations live at most 10 minutes (design.md A-04). */
export const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;

/**
 * GitHub documents the user refresh-token lifetime as
 * `refresh_token_expires_in: 15897600` seconds (6 months). Used only when the
 * token response omits the field; a non-expiring refresh token is still a
 * bounded value, never an indefinite credential.
 */
export const REFRESH_TOKEN_DEFAULT_TTL_SECONDS = 15_897_600;

/**
 * GitHub App client IDs are alphanumeric strings, not numeric App IDs.
 * Both documented forms are accepted:
 * - `Iv` + 6-40 alphanumerics (e.g. `Iv23f8doAlphaNumer1c`), as shown in the
 *   GitHub App client-ID changelog entry (github.blog/changelog/
 *   2024-05-01-github-apps-can-now-use-the-client-id-to-fetch-installation-tokens).
 * - `Iv` + digits + `.` + 8-40 alphanumerics (e.g. `Iv1.ab1112223334445c`),
 *   as seen in GitHub REST API responses.
 * Purely numeric values are GitHub App IDs and are rejected as client IDs.
 */
const CLIENT_ID_PATTERN = /^Iv[0-9a-zA-Z]{6,40}$|^Iv[0-9]+\.[0-9a-zA-Z]{8,40}$/;
const CLIENT_SECRET_MAX_LENGTH = 256;

/**
 * Resolve and strictly validate the GitHub App web-flow configuration.
 *
 * Returns `{ status: 'ok', config }` or a stable unconfigured reason.
 * Missing configuration makes authentication unavailable safely; it must
 * never crash the rest of the server.
 */
export function resolveAuthConfig(
  env: Record<string, string | undefined>,
): AuthConfigResult {
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim();
  if (clientId === undefined || clientId === '') {
    return { status: 'unconfigured', reason: 'missing_client_id' };
  }
  if (!CLIENT_ID_PATTERN.test(clientId)) {
    return { status: 'unconfigured', reason: 'invalid_client_id' };
  }

  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
  if (clientSecret === undefined || clientSecret === '') {
    return { status: 'unconfigured', reason: 'missing_client_secret' };
  }
  if (clientSecret.length > CLIENT_SECRET_MAX_LENGTH || /\s/.test(clientSecret)) {
    return { status: 'unconfigured', reason: 'invalid_client_secret' };
  }

  const callbackRaw = env.GITHUB_OAUTH_CALLBACK_URL?.trim();
  if (callbackRaw === undefined || callbackRaw === '') {
    return { status: 'unconfigured', reason: 'missing_callback_url' };
  }
  let callback: URL;
  try {
    callback = new URL(callbackRaw);
  } catch {
    return { status: 'unconfigured', reason: 'invalid_callback_url' };
  }
  if (
    (callback.protocol !== 'http:' && callback.protocol !== 'https:') ||
    callback.hostname === '' ||
    callback.username !== '' ||
    callback.password !== '' ||
    callback.search !== '' ||
    callback.hash !== ''
  ) {
    return { status: 'unconfigured', reason: 'invalid_callback_url' };
  }

  return {
    status: 'ok',
    config: {
      clientId,
      clientSecret,
      callbackUrl: callback.toString(),
    },
  };
}

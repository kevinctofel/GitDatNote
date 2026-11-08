interface ErrorViewProps {
  /** The raw `window.location.search` for the current page. */
  search: string;
}

/**
 * Fixed, safe user-facing copy for known backend auth-failure reasons.
 * The `reason` query value is matched against this allow-list ONLY —
 * unknown or missing values fall back to a generic message, and the raw
 * query value is never rendered.
 */
const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  auth_unconfigured:
    "GitHub sign-in is not configured for this GitDatNote instance, so it cannot be started right now.",
  state_invalid:
    "The sign-in attempt could not be verified. Please try connecting to GitHub again.",
  state_expired:
    "The sign-in attempt expired before it completed. Please try connecting to GitHub again.",
  state_replayed:
    "This sign-in attempt was already used. Please try connecting to GitHub again.",
  consent_denied:
    "GitHub sign-in was not completed. You can try again whenever you are ready.",
  token_error:
    "GitHub could not verify your sign-in. Please try connecting to GitHub again.",
  profile_error:
    "GitHub could not fetch your profile. Please try connecting to GitHub again.",
  rate_limited:
    "GitHub is rate limiting sign-in requests right now. Please try again shortly.",
  github_unavailable:
    "GitHub is temporarily unavailable. Please try again shortly.",
  internal: "Something went wrong while starting GitHub sign-in. Please try again.",
};

const GENERIC_ERROR_MESSAGE =
  "Something went wrong while starting GitHub sign-in. Please try connecting to GitHub again.";

/**
 * Renders the `/error` page. Accepts only known, fixed reason codes and
 * displays fixed copy for each; arbitrary query-string values are never
 * shown as messages.
 */
export function ErrorView({ search }: ErrorViewProps) {
  const reason = new URLSearchParams(search).get("reason");
  const message =
    reason !== null ? (ERROR_MESSAGES[reason] ?? GENERIC_ERROR_MESSAGE) : GENERIC_ERROR_MESSAGE;

  return (
    <section aria-label="Sign-in problem" className="view">
      <h1>GitHub sign-in problem</h1>
      <p role="alert">{message}</p>
      <p>
        <a href="/">Return to GitDatNote</a>
      </p>
    </section>
  );
}

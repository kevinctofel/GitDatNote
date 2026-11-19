/**
 * Type declarations for integration/setup.mjs (tsc-only; the .mjs file is
 * the implementation). Tests in tests/unit import performAccessCheck with
 * an injectable fetch to verify the credential-safe diagnostics offline.
 */

export interface AccessCheckOptions {
  /** Environment map to validate (GITHUB_INTEGRATION* variables). */
  env: Record<string, string | undefined>;
  /** Injectable fetch implementation (defaults to global fetch). */
  fetchImpl?: (input: unknown, init?: unknown) => Promise<unknown>;
  /** stdout sink (defaults to process.stdout). */
  out?: { write(chunk: string): boolean };
  /** stderr sink (defaults to process.stderr). */
  err?: { write(chunk: string): boolean };
}

/**
 * Perform the ONE read-only authenticated repository lookup used by
 * `node integration/setup.mjs --check-access`. Never prints the token and
 * never forwards network exception text or remote response bodies; returns
 * the process exit code (0 on success, nonzero on any failure).
 */
export function performAccessCheck(
  options: AccessCheckOptions
): Promise<number>;

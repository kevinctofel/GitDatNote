/**
 * Type declarations for integration/config.js (task 5.1).
 * The implementation is plain ESM JavaScript so it can be loaded directly by
 * Node (setup.mjs / run.mjs); this file gives TypeScript test code typed
 * imports without changing tsconfig settings.
 */

export type IntegrationEnv = Record<string, string | undefined>;

export declare const OPT_IN_VAR: string;
export declare const REPO_VAR: string;
export declare const TOKEN_VAR: string;
export declare const DEDICATED_REPO_PREFIX: string;
export declare const DEDICATED_REPO_PATTERN: RegExp;
export declare const PRODUCTION_SOURCE_REPOSITORY: {
  owner: string;
  repo: string;
};
export declare const RESERVED_REPOSITORY_NAMES: string[];
export declare const PLACEHOLDER_REPOSITORY_VALUES: string[];
export declare const PLACEHOLDER_TOKEN_VALUES: string[];

export declare function isIntegrationEnabled(env?: IntegrationEnv): boolean;
export declare function parseRepositoryId(
  value: string | undefined
): { owner: string; repo: string } | null;
export declare function validateIntegrationConfig(env?: IntegrationEnv): {
  ok: boolean;
  errors: string[];
};

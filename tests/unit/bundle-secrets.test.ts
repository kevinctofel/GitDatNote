/**
 * Task 3.7 — Production browser bundle secret scan.
 *
 * Runs a real production Vite build of the web app (the exact same
 * configuration that `npm run build` uses, imported from `vite.config.ts`)
 * into an isolated temp directory, with synthetic high-entropy canary
 * values set in the process environment. The assertions then prove the
 * browser output carries none of them:
 *
 * - `GITHUB_APP_*` client-secret / private-key canaries,
 * - the session-encryption-key canary,
 * - a `VITE_`-prefixed canary (proves env reachability is limited to what
 *   the client code explicitly reads),
 * - server-only identifier strings that must not exist in a browser bundle
 *   (`GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`,
 *   `SESSION_ENCRYPTION_KEY`, the OAuth wire-format field names
 *   `refresh_token`/`access_token`, server-only module specifiers).
 *
 * Canary values are 32 random bytes generated at test-run time; no real
 * credential is ever placed in the environment or asserted against. The
 * scan covers every generated asset (HTML, JS, CSS, and any source maps
 * the production configuration emits).
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Dirent } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, loadConfigFromFile } from 'vite';

/* ------------------------------------------------------------------ */
/* Synthetic canaries (run-time generated; never real secrets)        */
/* ------------------------------------------------------------------ */

const CANARY = {
  clientId: `canary-client-id-${randomBytes(16).toString('hex')}`,
  clientSecret: randomBytes(32).toString('hex'),
  privateKey: `canary-private-key-${randomBytes(32).toString('hex')}`,
  sessionKey: randomBytes(32).toString('hex'),
  viteVar: `canary-vite-env-${randomBytes(24).toString('hex')}`,
} as const;

const ENV_VARS = {
  GITHUB_APP_CLIENT_ID: CANARY.clientId,
  GITHUB_APP_CLIENT_SECRET: CANARY.clientSecret,
  GITHUB_APP_PRIVATE_KEY: CANARY.privateKey,
  SESSION_ENCRYPTION_KEY: CANARY.sessionKey,
  VITE_GDN37_CANARY: CANARY.viteVar,
} as const;

let outDir = '';
let savedEnv: Record<string, string | undefined> | null = null;

/**
 * Restore the environment variables the canary build overrides to their
 * exact prior state — original value or absence. `savedEnv` becomes null
 * after the first restore, so repeated calls are safe no-ops.
 */
function restoreEnv(): void {
  if (savedEnv === null) return;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  savedEnv = null;
}

beforeAll(async () => {
  // Record each variable's original value (or absence) before overriding
  // it, so cleanup restores the environment exactly instead of assuming
  // the variables were absent before the test.
  savedEnv = {};
  for (const key of Object.keys(ENV_VARS)) {
    savedEnv[key] = process.env[key];
  }
  // Set the canaries for the build process, then restore afterwards.
  for (const [k, v] of Object.entries(ENV_VARS)) {
    process.env[k] = v;
  }
  try {
    // Resolve the exact production configuration (`vite.config.ts`) through
    // Vite's own config loader.
    const loaded = await loadConfigFromFile(
      { command: 'build', mode: 'production' },
      'vite.config.ts',
      process.cwd(),
    );
    const userConfig = loaded?.config ?? {};
    outDir = join(mkdtempSync(join(tmpdir(), 'gitdatnote-dist-')), 'dist');
    // Build with the exact production configuration, redirected to the
    // isolated output dir. `configFile: false` prevents re-reading
    // vite.config.ts (we already have the resolved object).
    await build({
      ...userConfig,
      configFile: false,
      logLevel: 'silent',
      build: {
        ...(userConfig.build ?? {}),
        outDir,
        emptyOutDir: true,
      },
    });
  } finally {
    // Restore the original values even when the build setup fails.
    restoreEnv();
  }
}, 240_000);

afterAll(() => {
  // Safety net for the normal completion path; `finally` in beforeAll
  // already restored on failure, making this call a no-op in that case.
  restoreEnv();
  if (outDir !== '') {
    rmSync(outDir, { recursive: true, force: true });
  }
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }) as Dirent[]) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (statSync(full).isFile()) out.push(full);
  }
  return out;
}

describe('task 3.7 — production browser bundle excludes server secrets', () => {
  const files = () => walk(outDir);

  it('the production build actually emitted browser assets', () => {
    const all = files();
    expect(all.some((f) => f.endsWith('.js'))).toBe(true);
    expect(all.some((f) => f.endsWith('.html'))).toBe(true);
  });

  it('no canary credential value appears in any generated asset', () => {
    for (const file of files()) {
      const text = readFileSync(file, 'utf8');
      for (const [label, value] of Object.entries(CANARY)) {
        expect(text, `${label} canary found in ${file}`).not.toContain(value);
      }
    }
  });

  it('no server-only environment identifier is embedded in the bundle', () => {
    const forbidden = [
      'GITHUB_APP_CLIENT_SECRET',
      'GITHUB_APP_PRIVATE_KEY',
      'SESSION_ENCRYPTION_KEY',
      // OAuth token-exchange wire format is server-side only.
      'refresh_token',
      'access_token',
      // Server-only module specifiers must not be referenced client-side.
      'node:crypto',
      'better-sqlite3',
    ];
    for (const file of files()) {
      const text = readFileSync(file, 'utf8');
      for (const s of forbidden) {
        expect(text, `server-only string ${JSON.stringify(s)} found in ${file}`).not.toContain(s);
      }
    }
  });
});

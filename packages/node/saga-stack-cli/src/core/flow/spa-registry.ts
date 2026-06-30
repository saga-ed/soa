/**
 * Built-in SPA registry (plan §5.3, saga-ed/soa#214).
 *
 * Lists the SPAs the CLI knows how to discover a `flows.json` for. Resolution
 * mirrors up.sh's repo-path env vars: `repoRoot = $<repoEnvVar> ?? $DEV/<default>`,
 * then `join(repoRoot, e2eDir, 'flows.json')` (see `discover.ts`).
 *
 * Onboarding a new SPA (the M6 proof) = ONE row here + author its `flows.json`
 * + specs in that repo. Zero CLI code, zero orchestration code in the SPA repo.
 *
 * PURE: frozen data + lookups; zero IO.
 */

import type { SpaDescriptor } from './types.js';

/**
 * Known SPAs, keyed by `id`. Each descriptor carries the same fields a
 * `flows.json`'s `spa` block does, so discovery can resolve a repo root and
 * Playwright invocation BEFORE the `flows.json` is even read (it is the fallback
 * descriptor + the path resolver). The authored `flows.json` `spa` block remains
 * authoritative once loaded — this registry only locates it.
 */
export const SPA_REGISTRY: Readonly<Record<string, SpaDescriptor>> = Object.freeze({
  'saga-dash': {
    id: 'saga-dash',
    system: 'saga-dash',
    repoEnvVar: 'SAGA_DASH',
    defaultRepoSubpath: 'saga-dash',
    appDir: 'apps/web/dash',
    e2eDir: 'apps/web/dash/e2e',
    // repo-relative to `appDir` (Playwright runs in `appDir`).
    playwrightConfig: 'playwright.stack.config.ts',
  },

  // ── FUTURE (M6) — connectv3 ────────────────────────────────────────────────
  // The "other SPA" proof: this row + an authored `flows.json` + specs in qboard
  // are all that onboarding connectv3 takes. UNVERIFIED placeholders — the appDir/
  // e2eDir/playwrightConfig must be confirmed against the connectv3 repo before it
  // ships (the `flows.json`'s own `spa` block is authoritative once authored).
  // `system` is `connect-web` (connectv3's frontend service in the manifest); there
  // is no standalone `connectv3` ServiceId.
  connectv3: {
    id: 'connectv3',
    system: 'connect-web',
    repoEnvVar: 'QBOARD',
    defaultRepoSubpath: 'qboard',
    appDir: 'apps/web/connect', // TODO(M6): confirm
    e2eDir: 'apps/web/connect/e2e', // TODO(M6): confirm
    playwrightConfig: 'playwright.stack.config.ts', // TODO(M6): confirm
  },
});

/** Look up a known SPA descriptor by id (undefined if not registered). */
export function lookupSpa(
  id: string,
  registry: Readonly<Record<string, SpaDescriptor>> = SPA_REGISTRY,
): SpaDescriptor | undefined {
  return registry[id];
}

/** The ids of all registered SPAs (for `e2e list` + "unknown spa" error help). */
export function knownSpaIds(
  registry: Readonly<Record<string, SpaDescriptor>> = SPA_REGISTRY,
): string[] {
  return Object.keys(registry);
}

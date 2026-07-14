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

  // ── connectv3 (M6 — the SECOND-SPA externalization proof) ──────────────────
  // The "other SPA" proof (plan §5.3): this row + a `flows.json` are ALL that
  // onboarding connectv3 takes — zero new resolver/command/core logic. Discovery
  // falls back to the package's bundled `examples/flows/connectv3.flows.json`
  // (wired in `e2e-orchestrate.ts`'s BUNDLED_EXAMPLE, exactly like saga-dash) until
  // the REAL `flows.json` is authored in the qboard repo (a follow-up).
  //
  // Paths confirmed against `core/manifest/services.ts` `connect-web` (QBOARD ·
  // `apps/web/connectv3`); `system` is `connect-web` (connectv3's frontend service
  // — there is no standalone `connectv3` ServiceId). The authored `flows.json`'s
  // own `spa` block remains authoritative once it exists; this row only locates it.
  connectv3: {
    id: 'connectv3',
    system: 'connect-web',
    repoEnvVar: 'QBOARD',
    defaultRepoSubpath: 'qboard',
    appDir: 'apps/web/connectv3',
    e2eDir: 'apps/web/connectv3/e2e',
    // repo-relative to `appDir` (Playwright runs in `appDir`).
    playwrightConfig: 'playwright.config.ts',
  },

  // ── coach-web (gh_305 — the `develop coach` concierge target) ──────────────
  // The THIRD-SPA onboarding (same M6 pattern as connectv3): this row + coach's
  // already-authored `apps/web/coach-web/e2e/flows.json` are ALL it takes — zero
  // new resolver/command/core logic. Unlike saga-dash/connectv3 there is NO
  // bundled example fallback; discovery finds coach's real `flows.json` directly
  // in the `$COACH` checkout (BUNDLED_EXAMPLE, `e2e-orchestrate.ts`, only covers
  // repos that haven't authored one).
  //
  // Paths confirmed against `core/manifest/services.ts` `coach-web` (COACH ·
  // `apps/web/coach-web`, port 8800 hard-set in coach-web's vite.config.ts) and
  // coach's own `flows.json` `spa` block. The authored `flows.json`'s own `spa`
  // block remains authoritative once loaded; this row only locates it.
  'coach-web': {
    id: 'coach-web',
    system: 'coach-web',
    repoEnvVar: 'COACH',
    defaultRepoSubpath: 'coach',
    appDir: 'apps/web/coach-web',
    e2eDir: 'apps/web/coach-web/e2e',
    // repo-relative to `appDir` (Playwright runs in `appDir`).
    playwrightConfig: 'playwright.config.ts',
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

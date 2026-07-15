/**
 * coach-web THIRD-SPA onboarding proof (plan §5.3, saga-ed/soa#214; coach e2e/
 * saga-stack-cli parity task). Unlike connectv3's bundled placeholder, coach-web
 * already has a REAL Playwright suite, so its `flows.json` is authored directly
 * in the coach repo (`apps/web/coach-web/e2e/flows.json`) rather than bundled
 * under `examples/flows/` — this test reads it from the sibling checkout the
 * same way a real `ss e2e run coach-web/dashboard` discovery would (repo root
 * derived via `$COACH` / `$DEV/coach`, mirroring `discover.ts`).
 *
 * Skips (not fails) when the coach checkout isn't present, since saga-stack-cli
 * doesn't require every mesh repo to be checked out to run its own unit suite.
 * `it.skipIf` (not a top-level conditional `describe`) keeps this file a valid
 * suite either way — vitest errors a file with zero registered tests.
 *
 * Path resolution goes through the REAL `flowsCandidatePaths`/`resolveRepoRoot`
 * (discover.ts) with an EXPLICIT env bag — not live `process.env` — so this test
 * dogfoods the actual discovery logic without being at the mercy of a stray
 * ambient `$DEV` (observed in this sandbox: some tool in the pnpm/vitest chain
 * sets `DEV=1`, which `discover.ts`'s real `$DEV`-as-tree-root convention would
 * misinterpret).
 */

// TEST-only fixture read (excluded from the lib build via tsconfig); production
// core code stays fs-free, guarded by the no-restricted-imports eslint rule.
// eslint-disable-next-line no-restricted-imports
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { flowsCandidatePaths } from '../discover.js';
import { parseFlowManifest } from '../load.js';
import { resolveFlow } from '../resolve.js';
import { lookupSpa } from '../spa-registry.js';
import type { FlowManifest } from '../types.js';

const spa = lookupSpa('coach-web');
if (!spa) throw new Error('coach-web must be registered in SPA_REGISTRY for this test to run');

// Real HOME + an explicit $COACH passthrough (for a worktree checkout), but a
// clean env bag otherwise — isolates discovery from ambient vars like the
// stray `DEV=1` seen in this sandbox's pnpm/vitest chain.
const CLEAN_ENV = { HOME: homedir(), COACH: process.env.COACH };
const FLOWS_PATH = flowsCandidatePaths({ spa, env: CLEAN_ENV }).at(-1)!;
const present = existsSync(FLOWS_PATH);

// Loaded once, lazily, only when present — avoids a top-level readFileSync that
// would throw even under `it.skipIf`.
const manifest: FlowManifest | undefined = present
  ? parseFlowManifest(readFileSync(FLOWS_PATH, 'utf8'), FLOWS_PATH)
  : undefined;

describe('coach-web flows.json — validates against the one external contract (schema)', () => {
  it.skipIf(!present)(`parses + zod-validates as a FlowManifest (checkout: ${FLOWS_PATH})`, () => {
    expect(manifest!.schemaVersion).toBe(1);
    expect(manifest!.spa.id).toBe('coach-web');
    expect(manifest!.flows.map((f) => f.name)).toContain('dashboard');
  });

  it.skipIf(!present)('the authored spa block matches the coach-web service + coach repo layout', () => {
    expect(manifest!.spa).toMatchObject({
      id: 'coach-web',
      system: 'coach-web',
      repoEnvVar: 'COACH',
      defaultRepoSubpath: 'coach',
      appDir: 'apps/web/coach-web',
      e2eDir: 'apps/web/coach-web/e2e',
      playwrightConfig: 'playwright.config.ts',
    });
  });

  it.skipIf(!present)('coach-web is registered and its descriptor agrees with the authored file', () => {
    const reg = lookupSpa('coach-web');
    expect(reg).toBeDefined();
    expect(reg).toMatchObject(manifest!.spa);
  });

  describe('dashboard flow — resolves through the SAME resolveFlow/closure engine', () => {
    it.skipIf(!present)('selects the single non-progressive dashboard stage + its Playwright target', () => {
      const r = resolveFlow(manifest!, 'dashboard');
      expect(r.stages.map((s) => s.id)).toEqual(['dashboard']);
      expect(r.playwright.project).toBe('chromium');
      expect(r.playwright.config).toBe('playwright.config.ts');
    });

    it.skipIf(!present)('requiredSystems = the stage systems (coach-web ∪ coach-api ∪ iam-api)', () => {
      const r = resolveFlow(manifest!, 'dashboard');
      expect(r.requiredSystems).toEqual(['coach-web', 'coach-api', 'iam-api']);
    });

    it.skipIf(!present)('closure is exactly {coach-web, coach-api, iam-api} — no unrelated services leak in', () => {
      const r = resolveFlow(manifest!, 'dashboard');
      expect([...r.closure.services].sort()).toEqual(['coach-api', 'coach-web', 'iam-api']);
    });

    it.skipIf(!present)('closure pulls the coach_api pg db and NO mongo (coach-api is single-store)', () => {
      const r = resolveFlow(manifest!, 'dashboard');
      expect(r.closure.databases).toContain('coach_api');
      // Was `toContain('connect-mongo')` when this branch was cut: coach-api was
      // dual-store then. `3ced4c5` RETIRED mongo — the curriculum read path is
      // Postgres now (PostgresContentReadStore over content_release), coach-api
      // declares `mesh: []`, so a coach flow must NOT drag the mesh mongo up.
      expect(r.closure.mesh).not.toContain('connect-mongo');
    });

    it.skipIf(!present)('seeds with the full profile (needed for the coach-pg alex fixture) + reset', () => {
      const r = resolveFlow(manifest!, 'dashboard');
      expect(r.seedSelection).toMatchObject({ profile: 'full', reset: true });
      expect(r.reset).toBe(true);
      expect(r.prerequisite).toBeUndefined();
    });

    it.skipIf(!present)('supports only the stack lane it declares', () => {
      expect(() => resolveFlow(manifest!, 'dashboard', { lane: 'stack' })).not.toThrow();
      expect(() => resolveFlow(manifest!, 'dashboard', { lane: 'sandbox' })).toThrow();
    });
  });
});

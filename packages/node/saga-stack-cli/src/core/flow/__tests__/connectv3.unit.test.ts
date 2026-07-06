/**
 * connectv3 EXTERNALIZATION PROOF (plan §5.3 "new-SPA onboarding", saga-ed/soa#214).
 *
 * M6 goal: prove the per-SPA externalization works for a SECOND SPA. Onboarding
 * connectv3 was "a registry row + a flows.json" — ZERO new resolver/closure/
 * orchestration code. This test resolves a connectv3 flow through the SAME PURE
 * `resolveFlow` → `computeClosure` engine the saga-dash flows use (see
 * `resolve.unit.test.ts`), and asserts the bundled example validates against the
 * one external contract (the zod `flowManifestSchema`, via `parseFlowManifest`).
 *
 * SPEC-vs-IMPL note (mirrors `resolve.unit.test.ts`): the M6 brief sketched the
 * connect-smoke closure as EXCLUDING programs/scheduling. That is NOT what the
 * frozen service manifest produces: `sessions-api.dependsOn` lists `programs-api`
 * + `scheduling-api` on `event` edges (its async projections), and the flow
 * resolver only suppresses `browser` edges (`followBrowserEdges:false`), never
 * `event`/`url`. So ANY closure containing `sessions-api` — which a Connect flow
 * always does, both directly and transitively via `connect-api`'s `url` dep —
 * pulls programs + scheduling in. These tests assert the TRUE manifest behavior.
 * The genuine N-of-M payoff for connectv3 is what STAYS OUT: the saga-dash-only
 * backends `sis-api` + `ads-adm-api`, and the `saga-dash` frontend itself.
 */

// TEST-only fixture read (this file is excluded from the lib build via tsconfig);
// the production core code stays fs-free, which the rule below guards.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseFlowManifest } from '../load.js';
import { resolveFlow } from '../resolve.js';
import { lookupSpa } from '../spa-registry.js';
import type { FlowManifest } from '../types.js';

/** The package's bundled connectv3 example flows.json (the runtime/published copy). */
const EXAMPLE_PATH = fileURLToPath(
  new URL('../../../../examples/flows/connectv3.flows.json', import.meta.url),
);

/** Loading via `parseFlowManifest` IS the schema-validation assertion (load.ts → zod). */
const manifest: FlowManifest = parseFlowManifest(readFileSync(EXAMPLE_PATH, 'utf8'), EXAMPLE_PATH);

/** Sorted copy, so set-equality assertions don't depend on insertion order. */
const sorted = (xs: readonly string[]): string[] => [...xs].sort();

describe('connectv3 example — validates against the one external contract (schema)', () => {
  it('parses + zod-validates as a FlowManifest (a misauthored file would have thrown at load)', () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.spa.id).toBe('connectv3');
    expect(manifest.flows.map((f) => f.name)).toContain('connect-smoke');
  });

  it("the example's spa block matches the connect-web service + qboard repo layout", () => {
    expect(manifest.spa).toMatchObject({
      id: 'connectv3',
      system: 'connect-web',
      repoEnvVar: 'QBOARD',
      defaultRepoSubpath: 'qboard',
      appDir: 'apps/web/connectv3',
      e2eDir: 'apps/web/connectv3/e2e',
      playwrightConfig: 'playwright.config.ts',
    });
  });
});

describe('connectv3 — first-class registry row (onboarding = 1 row + 1 json, no new logic)', () => {
  it('connectv3 is registered and its descriptor agrees with the authored example', () => {
    const reg = lookupSpa('connectv3');
    expect(reg).toBeDefined();
    // The registry row locates the file; the loaded spa block is authoritative —
    // they must agree so discovery + the resolver target the same SPA.
    expect(reg).toMatchObject({
      id: 'connectv3',
      system: 'connect-web',
      repoEnvVar: 'QBOARD',
      defaultRepoSubpath: 'qboard',
      appDir: 'apps/web/connectv3',
      e2eDir: 'apps/web/connectv3/e2e',
      playwrightConfig: 'playwright.config.ts',
    });
  });
});

describe('connectv3 connect-smoke — resolves through the SAME resolveFlow/closure engine', () => {
  const r = resolveFlow(manifest, 'connect-smoke');

  it('selects the single non-progressive smoke stage + its Playwright target', () => {
    expect(r.stages.map((s) => s.id)).toEqual(['smoke']);
    expect(r.playwright.project).toBe('connect-smoke');
    expect(r.playwright.config).toBe('playwright.config.ts');
    // Not foreground/AV → headless by default; pipeline default-excludes @interactive.
    expect(r.playwright.headed).toBe(false);
    expect(r.playwright.grepInvert).toBe('@interactive');
  });

  it('requiredSystems = the stage systems ∪ {spa.system=connect-web, iam-api}', () => {
    // connect-web is both the stage system AND spa.system (deduped); iam-api added.
    expect(r.requiredSystems).toEqual([
      'connect-web',
      'connect-api',
      'rtsm-api',
      'sessions-api',
      'iam-api',
    ]);
  });

  it('closure includes the Connect chain + content-api (via connect-api url dep) + iam', () => {
    for (const id of ['connect-web', 'connect-api', 'rtsm-api', 'sessions-api', 'content-api', 'iam-api']) {
      expect(r.closure.services).toContain(id);
    }
  });

  it('closure pulls connect-mongo mesh (reached only via connect-api.mesh) + the connectv3 db', () => {
    expect(r.closure.mesh).toContain('connect-mongo');
    expect(r.closure.databases).toContain('connectv3');
    expect(r.closure.databases).toContain('content'); // content-api's db
  });

  it('EXCLUDES the saga-dash-only backends (sis, ads-adm) AND the saga-dash frontend', () => {
    for (const id of ['sis-api', 'ads-adm-api', 'saga-dash']) {
      expect(r.closure.services).not.toContain(id);
    }
    // No optional playback service leaks in (no add-on requested).
    for (const id of ['transcripts-api', 'insights-api', 'chat-api']) {
      expect(r.closure.services).not.toContain(id);
    }
  });

  it('INCLUDES programs + scheduling — TRUE manifest behavior via sessions-api event projections', () => {
    // SPEC-vs-IMPL: not excludable while sessions-api is in the closure (it always
    // is for a Connect flow). The N-of-M payoff is the saga-dash backends staying
    // out (asserted above), not these two.
    expect(r.closure.services).toContain('programs-api');
    expect(r.closure.services).toContain('scheduling-api');
  });

  it('the full connect-smoke closure is exactly the manifest-derived set', () => {
    expect(sorted(r.closure.services)).toEqual(
      sorted([
        'connect-web',
        'connect-api',
        'rtsm-api',
        'sessions-api',
        'content-api',
        'iam-api',
        'programs-api',
        'scheduling-api',
      ]),
    );
  });

  it('self-seeds (roster, reset) with no prerequisite — a standalone smoke', () => {
    expect(r.seedSelection).toMatchObject({ profile: 'roster', reset: true });
    expect(r.reset).toBe(true);
    expect(r.prerequisite).toBeUndefined();
  });

  it('supports the sandbox lane it declares (deployed-composition run, no local stack)', () => {
    expect(() => resolveFlow(manifest, 'connect-smoke', { lane: 'sandbox' })).not.toThrow();
  });
});

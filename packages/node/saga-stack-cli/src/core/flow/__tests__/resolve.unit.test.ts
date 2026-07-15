/**
 * `resolveFlow` unit tests (plan §5.2/§5.4, saga-ed/soa#214) — the PURE flow
 * resolver, exercised against the BUNDLED example `flows.json` (the authoring
 * template shipped with the package). Offline + deterministic: no StackApi, no
 * Runner, no wall-clock — `resolveFlow` is pure and the manifest is a fixture.
 *
 * SPEC-vs-IMPL note (deliberate divergence from an early plan sketch): the plan
 * §5.2 prose imagined "journey --through pods" launching a partial stack that
 * EXCLUDES sessions/scheduling/ads-adm/content. That is NOT what the frozen
 * service manifest produces: `saga-dash.dependsOn` lists ALL seven backends
 * (manifest/services.ts — verified against up.sh), so EVERY closure that
 * contains the `saga-dash` frontend transitively pulls in all of them. The
 * genuine N-of-M narrowing therefore lives at the `requiredSystems` layer (the
 * stages' declared systems ∪ {spa.system, iam-api}), NOT at the closure layer
 * for a saga-dash flow. These tests assert the TRUE behavior — matching the
 * already-green `e2e.int.test.ts`, which observes the full 8-service launch for
 * a roster-only run — and the closure savings show up for the non-saga-dash
 * closures (see the connect-session prerequisite recursion below). The N-of-M
 * engine itself is covered exhaustively by `core/__tests__/closure.unit.test.ts`.
 */

// TEST-only fixture read (this file is excluded from the lib build via tsconfig);
// the production core code stays fs-free, which the rule below guards.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseFlowManifest } from '../load.js';
import { resolveFlow } from '../resolve.js';
import type { FlowManifest } from '../types.js';

/** The package's bundled example flows.json (the runtime/published copy). */
const EXAMPLE_PATH = fileURLToPath(
  new URL('../../../../examples/flows/saga-dash.flows.json', import.meta.url),
);

const manifest: FlowManifest = parseFlowManifest(readFileSync(EXAMPLE_PATH, 'utf8'), EXAMPLE_PATH);

/** Sorted copy, so set-equality assertions don't depend on insertion order. */
const sorted = (xs: readonly string[]): string[] => [...xs].sort();

/**
 * The FULL-journey launch closure: every backend the 8 stages' requiredSystems
 * name, + saga-dash + iam. content-api is NOT here — no journey stage lists it,
 * and flow resolution does NOT follow saga-dash's `browser` edges (the §5.2
 * N-of-M payoff). (Interactive `stack up --only saga-dash` DOES pull content-api;
 * that path keeps followBrowserEdges:true.)
 */
const JOURNEY_FULL_CLOSURE = sorted([
  'iam-api',
  'sis-api',
  'programs-api',
  'scheduling-api',
  'sessions-api',
  'ads-adm-api',
  'saga-dash',
]);

describe('resolveFlow — journey --through pods (progressive prefix)', () => {
  const r = resolveFlow(manifest, 'journey', { throughPhase: 'pods' });

  it('selects stages 1..4 (roster → program → enrollment → pods)', () => {
    expect(r.stages.map((s) => s.id)).toEqual(['roster', 'program', 'enrollment', 'pods']);
  });

  it('narrows requiredSystems to the stages’ systems ∪ {spa.system, iam-api}', () => {
    // roster needs sis+programs; program/enrollment/pods need programs; then
    // spa.system (saga-dash) + iam-api. NOT scheduling/sessions/ads-adm (later
    // stages) — that is the real N-of-M narrowing at the requiredSystems layer.
    expect(r.requiredSystems).toEqual(['sis-api', 'programs-api', 'saga-dash', 'iam-api']);
    expect(r.requiredSystems).not.toContain('scheduling-api');
    expect(r.requiredSystems).not.toContain('sessions-api');
    expect(r.requiredSystems).not.toContain('ads-adm-api');
    expect(r.requiredSystems).not.toContain('content-api');
  });

  it('narrows the closure to the through-pods systems (N-of-M payoff, §5.2)', () => {
    // Flow resolution does NOT follow saga-dash's browser edges, so stopping at
    // pods launches ONLY iam + sis + programs + saga-dash — scheduling/sessions/
    // ads-adm/content (later stages, or never-listed) stay down. Real savings.
    expect(sorted(r.closure.services)).toEqual(sorted(['iam-api', 'sis-api', 'programs-api', 'saga-dash']));
    for (const id of ['scheduling-api', 'sessions-api', 'ads-adm-api', 'content-api']) {
      expect(r.closure.services).not.toContain(id);
    }
  });

  it('excludes the optional playback services (no add-on requested)', () => {
    expect(r.closure.services).not.toContain('transcripts-api');
    expect(r.closure.services).not.toContain('insights-api');
    expect(r.closure.services).not.toContain('chat-api');
  });

  it('targets the terminal stage’s Playwright project + config, headed (foreground), excluding @interactive', () => {
    expect(r.playwright.project).toBe('stage-4-pods'); // the --through stage
    expect(r.playwright.config).toBe('playwright.stack.config.ts');
    expect(r.playwright.headed).toBe(true); // journey is foreground:true
    expect(r.playwright.grepInvert).toBe('@interactive'); // pipeline default-excludes the AV stage
  });

  it('carries the terminal stage’s spec, scoping the run to just that file (not the whole testMatch)', () => {
    expect(r.playwright.spec).toBe('journey/pods.e2e.test.ts'); // the --through stage's own spec
  });

  it('carries the flow-level roster seed and resets itself (no prerequisite)', () => {
    expect(r.seedSelection).toMatchObject({ profile: 'roster', reset: true });
    expect(r.reset).toBe(true);
    expect(r.prerequisite).toBeUndefined();
  });
});

describe('resolveFlow — journey (full, default)', () => {
  const r = resolveFlow(manifest, 'journey');

  it('selects all 8 stages with the terminal = attendance-personas', () => {
    expect(r.stages).toHaveLength(8);
    expect(r.stages.at(-1)?.id).toBe('attendance-personas');
    expect(r.playwright.project).toBe('stage-8-attendance-personas');
  });

  it('unions every stage’s requiredSystems ∪ {spa.system, iam-api}', () => {
    expect(sorted(r.requiredSystems)).toEqual(
      sorted(['sis-api', 'programs-api', 'scheduling-api', 'sessions-api', 'ads-adm-api', 'iam-api', 'saga-dash']),
    );
    // content-api is in NO stage, and flow resolution does not follow saga-dash's
    // browser edges, so the full journey NEVER launches content-api (§5.2 payoff).
    expect(r.requiredSystems).not.toContain('content-api');
    expect(r.closure.services).not.toContain('content-api');
  });

  it('closure is the full-journey backend set (7 services, NOT content-api)', () => {
    expect(sorted(r.closure.services)).toEqual(JOURNEY_FULL_CLOSURE);
  });
});

describe('resolveFlow — --through by phase number / project id', () => {
  it('matches a numeric phase token', () => {
    const r = resolveFlow(manifest, 'journey', { throughPhase: 4 });
    expect(r.stages.map((s) => s.id)).toEqual(['roster', 'program', 'enrollment', 'pods']);
    expect(r.playwright.project).toBe('stage-4-pods');
  });

  it('matches a Playwright project token', () => {
    const r = resolveFlow(manifest, 'journey', { throughPhase: 'stage-2-program-creation' });
    expect(r.stages.map((s) => s.id)).toEqual(['roster', 'program']);
  });
});

describe('resolveFlow — connect-session (non-progressive + prerequisite recursion)', () => {
  const r = resolveFlow(manifest, 'connect-session');

  it('runs the single @interactive terminal stage WITHOUT inverting its own tag', () => {
    expect(r.stages.map((s) => s.id)).toEqual(['interactive-connect']);
    expect(r.playwright.project).toBe('interactive-connect');
    // The run IS the tagged stage, so it must NOT --grep-invert @interactive.
    expect(r.playwright.grepInvert).toBeUndefined();
    expect(r.playwright.headed).toBe(true); // foreground AV flow
  });

  it('requiredSystems = the connect stage systems ∪ {spa.system, iam-api}', () => {
    expect(r.requiredSystems).toEqual([
      'connect-web',
      'connect-api',
      'rtsm-api',
      'sessions-api',
      'saga-dash',
      'iam-api',
    ]);
  });

  it('closure pulls content-api transitively via connect-api (authored only on the dep edge)', () => {
    for (const id of ['connect-web', 'connect-api', 'rtsm-api', 'sessions-api', 'content-api']) {
      expect(r.closure.services).toContain(id);
    }
    // connect-mongo mesh + connectv3 db arrive with connect-api.
    expect(r.closure.mesh).toContain('connect-mongo');
  });

  it('recurses the journey prerequisite through schedule, headless, owning the reset', () => {
    const pre = r.prerequisite;
    expect(pre).toBeDefined();
    expect(pre?.flow.name).toBe('journey');
    expect(pre?.stages.at(-1)?.id).toBe('schedule'); // through 'schedule'
    expect(pre?.playwright.project).toBe('stage-5-schedule');
    expect(pre?.playwright.headed).toBe(false); // prerequisite always built headless
    expect(pre?.reset).toBe(true); // the prerequisite resets+seeds the end-state
  });

  it('the main flow itself runs SKIP_RESET because the prerequisite built the state', () => {
    expect(r.reset).toBe(false);
  });
});

describe('resolveFlow — validation errors', () => {
  it('throws a listing error on an unknown flow', () => {
    expect(() => resolveFlow(manifest, 'nope')).toThrow(/unknown flow 'nope'.*journey.*connect-session/s);
  });

  it('throws on an unsupported lane (connect-session is stack-only)', () => {
    expect(() => resolveFlow(manifest, 'connect-session', { lane: 'sandbox' })).toThrow(
      /does not support lane 'sandbox'/,
    );
  });

  it('accepts the sandbox lane for journey (which declares it)', () => {
    expect(() => resolveFlow(manifest, 'journey', { lane: 'sandbox' })).not.toThrow();
  });

  it('throws on an unmatched --through token', () => {
    expect(() => resolveFlow(manifest, 'journey', { throughPhase: 'bogus' })).toThrow(
      /no stage matches --through 'bogus'/,
    );
  });
});

/**
 * `flows.json` loader unit tests (plan §5.1/§5.3, saga-ed/soa#214).
 *
 * Covers the two layers of `core/flow/load.ts`:
 *  - `parseFlowManifest` (PURE: JSON.parse + zod validate of an in-memory string),
 *  - `loadFlowManifest` (the thin reader with an INJECTABLE `readText` seam).
 *
 * Offline + deterministic: the bundled example is read once as a fixture; every
 * other case feeds an in-memory string or a fake reader. No disk writes, no
 * network, no process — and `loadFlowManifest`'s only real-fs default is never
 * exercised here (we always inject a reader).
 */

// TEST-only fixture read (this file is excluded from the lib build via tsconfig);
// the production core code stays fs-free, which the rule below guards.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadFlowManifest, parseFlowManifest } from '../load.js';

/** The package's bundled example flows.json (the runtime/published copy). */
const EXAMPLE_PATH = fileURLToPath(
  new URL('../../../../examples/flows/saga-dash.flows.json', import.meta.url),
);
const EXAMPLE_TEXT = readFileSync(EXAMPLE_PATH, 'utf8');

/**
 * The flows the bundled example must ALWAYS carry — asserted with
 * `arrayContaining`, deliberately NOT as an exact list.
 *
 * `examples/flows/saga-dash.flows.json` is a MIRROR that legitimately gains flows
 * over time, and an exact list turns every such addition into an unrelated red
 * build in a file the author never touched. That has now bitten twice: 6b6571f
 * (patched reactively by 62977b1) and #308/fc4440c (soa#312, which left main red).
 * Pinning the literal a third time would just reset the trap.
 *
 * This still catches the regression that actually matters — a load-bearing flow
 * going MISSING from the mirror. Flow CONTENT is asserted below (journey's 8
 * ordered stages, connect-session's prerequisite), which is the real coverage.
 */
const LOAD_BEARING_FLOWS = ['journey', 'connect-session', 'connect-add-student'];

describe('parseFlowManifest — the bundled example validates', () => {
  it('parses against the zod schema and exposes the spa + bundled flows', () => {
    const m = parseFlowManifest(EXAMPLE_TEXT, EXAMPLE_PATH);
    expect(m.schemaVersion).toBe(1);
    expect(m.spa.id).toBe('saga-dash');
    expect(m.spa.system).toBe('saga-dash');
    expect(m.flows.map((f) => f.name)).toEqual(expect.arrayContaining(LOAD_BEARING_FLOWS));
  });

  it('strips unknown top-level keys (the example carries a $comment annotation)', () => {
    // zod objects are non-strict, so the doc-only "$comment" is dropped, not rejected.
    expect(EXAMPLE_TEXT).toContain('$comment');
    const m = parseFlowManifest(EXAMPLE_TEXT) as Record<string, unknown>;
    expect(m.$comment).toBeUndefined();
  });

  it('preserves the progressive journey’s 8 ordered stages and the connect prerequisite', () => {
    const m = parseFlowManifest(EXAMPLE_TEXT);
    const journey = m.flows.find((f) => f.name === 'journey');
    expect(journey?.progressive).toBe(true);
    expect(journey?.stages).toHaveLength(8);
    const connect = m.flows.find((f) => f.name === 'connect-session');
    expect(connect?.prerequisite).toEqual({ flow: 'journey', throughStage: 'schedule' });
  });
});

describe('parseFlowManifest — malformed input is rejected', () => {
  it('throws on invalid JSON, naming the source', () => {
    expect(() => parseFlowManifest('{ not json', '/tmp/flows.json')).toThrow(
      /flows\.json is not valid JSON \(\/tmp\/flows\.json\)/,
    );
  });

  it('throws on a wrong schemaVersion (literal 1 required)', () => {
    const bad = JSON.stringify({ ...JSON.parse(EXAMPLE_TEXT), schemaVersion: 2 });
    expect(() => parseFlowManifest(bad, '/tmp/flows.json')).toThrow(/failed schema validation/);
  });

  it('throws on an unknown service id in a stage’s requiredSystems (enum guard)', () => {
    const doc = JSON.parse(EXAMPLE_TEXT) as { flows: { stages: { requiredSystems: string[] }[] }[] };
    doc.flows[0].stages[0].requiredSystems = ['not-a-real-service'];
    expect(() => parseFlowManifest(JSON.stringify(doc))).toThrow(/failed schema validation/);
  });

  it('throws when a flow has zero stages (min(1) guard)', () => {
    const doc = JSON.parse(EXAMPLE_TEXT) as { flows: { stages: unknown[] }[] };
    doc.flows[0].stages = [];
    expect(() => parseFlowManifest(JSON.stringify(doc))).toThrow(/failed schema validation/);
  });

  it('throws when the required spa block is missing', () => {
    const doc = JSON.parse(EXAMPLE_TEXT) as Record<string, unknown>;
    delete doc.spa;
    expect(() => parseFlowManifest(JSON.stringify(doc))).toThrow(/failed schema validation/);
  });
});

describe('loadFlowManifest — injectable reader seam (no disk IO)', () => {
  it('reads via the injected reader and validates', () => {
    const reads: string[] = [];
    const m = loadFlowManifest('/virtual/flows.json', (p) => {
      reads.push(p);
      return EXAMPLE_TEXT;
    });
    expect(reads).toEqual(['/virtual/flows.json']);
    // This test's job is the READER SEAM (it parsed exactly what the reader
    // returned) — the mirror's flow list is incidental here, so same rule as above.
    expect(m.flows.map((f) => f.name)).toEqual(expect.arrayContaining(LOAD_BEARING_FLOWS));
  });

  it('wraps a reader error in a path-tagged message', () => {
    expect(() =>
      loadFlowManifest('/missing/flows.json', () => {
        throw new Error('ENOENT: no such file');
      }),
    ).toThrow(/could not be read at \/missing\/flows\.json: ENOENT/);
  });

  it('surfaces a schema failure from a file that DID read (malformed authoring)', () => {
    expect(() => loadFlowManifest('/bad/flows.json', () => '{"schemaVersion":1}')).toThrow(
      /failed schema validation \(\/bad\/flows\.json\)/,
    );
  });
});

describe('parseFlowManifest — multi-seed scenario/datasets in seed blocks (#221)', () => {
  type SeedBlock = Record<string, unknown>;
  const withSeed = (seed: SeedBlock): string => {
    const doc = JSON.parse(EXAMPLE_TEXT) as { flows: { seed?: SeedBlock }[] };
    doc.flows[0].seed = seed;
    return JSON.stringify(doc);
  };

  it('accepts a flow seed with a known scenario + per-system datasets', () => {
    const m = parseFlowManifest(
      withSeed({
        profile: 'full',
        scenario: 'ab-topology',
        datasets: [{ system: 'content-api', dataset: 'qtf-demo' }],
      }),
    );
    const journey = m.flows.find((f) => f.name === 'journey');
    expect(journey?.seed?.scenario).toBe('ab-topology');
    expect(journey?.seed?.datasets).toEqual([{ system: 'content-api', dataset: 'qtf-demo' }]);
  });

  it('rejects an unknown scenario name (closed enum)', () => {
    expect(() => parseFlowManifest(withSeed({ profile: 'full', scenario: 'nope' }))).toThrow(
      /failed schema validation/,
    );
  });

  it('rejects a dataset entry with an unknown system id', () => {
    expect(() =>
      parseFlowManifest(
        withSeed({ profile: 'full', datasets: [{ system: 'not-a-service', dataset: 'x' }] }),
      ),
    ).toThrow(/failed schema validation/);
  });

  it('rejects an empty dataset name (min(1))', () => {
    expect(() =>
      parseFlowManifest(
        withSeed({ profile: 'full', datasets: [{ system: 'sessions-api', dataset: '' }] }),
      ),
    ).toThrow(/failed schema validation/);
  });
});

/**
 * M14 stage checkpoints — `e2e run --snapshot-stages` (bake) + `--from`
 * (restore) integration tests (plan `11-e2e-stage-snapshots.md` §5 V1/V2's
 * hermetic half). Real oclif command, every IO seam faked (run.int.test.ts
 * harness + the snapshot.int.test.ts SnapshotIO fake); checkpoints land in a
 * temp $SAGA_MESH_SNAPSHOTS_DIR as REAL files (manifest + canned dump bytes).
 *
 * The SnapshotIO fake's readSchemaRev returns null so the schema-ahead guard
 * is inert here — it has its own hard-guard coverage in snapshot.int.test.ts;
 * these tests own the FLOW-level compat rules (prefixHash, staleness cliff,
 * baked-date reuse).
 */

import { resolve, join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { useTempSnapshotsDir } from '../../../__tests__/helpers/env.js';
import { fakeSnapshotIO, type SnapshotIOCall } from '../../../__tests__/helpers/snapshot-io.js';
import { installCoreSeams } from '../../../__tests__/helpers/seams.js';
import { Config } from '@oclif/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import type {
  CookiePoster,
  LaunchSpec,
  PostOptions,
  PostResult,
  ScriptInvocation,
  SettleBarrier,
  SettleBarrierContext,
  SnapshotIO,
} from '../../../runtime/index.js';
import E2eRun from '../run.js';
import E2eConnect from '../../develop/connect.js';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const DEV_ROOT = '/fixed/dev';

const CKPT_ROSTER = 'flow-saga-dash-journey-s1-roster';
const CKPT_PROGRAM = 'flow-saga-dash-journey-s2-program';
const CKPT_SCHEDULE = 'flow-saga-dash-journey-s5-schedule';

let DASH_ROOT: string;
let config: Config;
let launches: LaunchSpec[];
let runs: ScriptInvocation[];
const ioCalls: SnapshotIOCall[] = [];
let logged: string[];
let barrierCalls: SettleBarrierContext[];

// Hermetic per-test checkpoint root (real files land here — manifest + canned
// dump bytes), never the developer's real ~/.saga-mesh/snapshots.
const snapDir = useTempSnapshotsDir('saga-ckpt-');

/**
 * Compose the shared core-seam battery (helpers/seams.ts) + this suite's
 * SnapshotIO fake (helpers/snapshot-io.ts) on top. pidBase/prepFresh are
 * EXPLICIT at this call site by design: pids at 3000+, repos reported FRESH
 * (R1 prep build skipped) — run.int.test.ts's recipe. `playwrightFail` fails
 * Playwright children whose args include it (the RED-stage lever).
 */
function installSeams(playwrightFail?: string): void {
  const seams = installCoreSeams({ pidBase: 3000, prepFresh: true, playwrightFail });
  launches = seams.launches;
  runs = seams.runs;
  barrierCalls = seams.barrierCalls;

  // schemaRev: null ⇒ the snapshot-ahead guard is inert (covered by
  // snapshot.int.test.ts) — this suite owns the FLOW-level compat rules.
  const snapshotIO: SnapshotIO = fakeSnapshotIO({ ioCalls, schemaRev: null });
  vi.spyOn(
    BaseCommand.prototype as unknown as { getSnapshotIO: () => SnapshotIO },
    'getSnapshotIO',
  ).mockReturnValue(snapshotIO);
}

function ws(): string[] {
  return ['--saga-dash', DASH_ROOT, '--soa', SOA_ROOT, '--dev', DEV_ROOT];
}

function playwrightRuns(): ScriptInvocation[] {
  return runs.filter((r) => r.command === 'pnpm' && r.args.includes('playwright'));
}

function readCkptManifest(fixtureId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(snapDir(), fixtureId, 'manifest.json'), 'utf8')) as Record<string, unknown>;
}

function writeCkptManifest(fixtureId: string, m: Record<string, unknown>): void {
  writeFileSync(join(snapDir(), fixtureId, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
}

/** Bake checkpoints for stages 1-2 (roster, program) — the shared setup for --from tests. */
async function bakeThroughProgram(): Promise<void> {
  await E2eRun.run(['journey', '--through', 'program', '--snapshot-stages', '--headless', ...ws()], config);
}

beforeAll(() => {
  DASH_ROOT = mkdtempSync(join(tmpdir(), 'saga-dash-ckpt-'));
});
afterAll(() => {
  rmSync(DASH_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  ioCalls.length = 0;
  installSeams();
  logged = [];
  vi.spyOn(BaseCommand.prototype, 'log').mockImplementation((m?: string) => {
    logged.push(String(m ?? ''));
  });
  vi.spyOn(BaseCommand.prototype, 'warn').mockImplementation(((m: string) => m) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('--snapshot-stages (bake)', () => {
  it('spawns Playwright once per stage (--no-deps past the first) and bakes a checkpoint after each', async () => {
    await bakeThroughProgram();

    const pw = playwrightRuns();
    expect(pw).toHaveLength(2);
    // Stage 1 keeps its config deps (the stage-0-coherence gate rides along).
    expect(pw[0]!.args).toContain('stage-1-roster');
    expect(pw[0]!.args).not.toContain('--no-deps');
    // Stage 2 breaks the chain — no replay of stage 1.
    expect(pw[1]!.args).toContain('stage-2-program-creation');
    expect(pw[1]!.args).toContain('--no-deps');

    // The date env is computed ONCE for the whole ladder — every stage spawn
    // shares identical dates (an overnight bake must not split the clamp).
    for (const key of ['PLAYWRIGHT_OCCURRENCE_DATE', 'PLAYWRIGHT_TERM_START', 'PLAYWRIGHT_TERM_END']) {
      expect(pw[0]!.env?.[key]).toBeDefined();
      expect(pw[1]!.env?.[key]).toBe(pw[0]!.env?.[key]);
    }

    // Both checkpoints exist on disk with the M14 flow block.
    const roster = readCkptManifest(CKPT_ROSTER);
    const program = readCkptManifest(CKPT_PROGRAM);
    const rosterFlow = roster.flow as Record<string, unknown>;
    const programFlow = program.flow as Record<string, unknown>;
    expect(rosterFlow.stageId).toBe('roster');
    expect(programFlow.stageId).toBe('program');
    expect(rosterFlow.prefixHash).not.toBe(programFlow.prefixHash); // prefix grows per stage
    // The baked dates ARE the dates the green stage actually ran with.
    expect(rosterFlow.dates).toEqual({
      occurrenceDate: pw[0]!.env?.PLAYWRIGHT_OCCURRENCE_DATE,
      termStart: pw[0]!.env?.PLAYWRIGHT_TERM_START,
      termEnd: pw[0]!.env?.PLAYWRIGHT_TERM_END,
    });
    // Dumps happened for the closure DBs (canned bytes are real files).
    expect(ioCalls.filter((c) => c.op === 'pgDump').length).toBeGreaterThan(0);
  });

  it('--snapshot-stages requires the stack lane', async () => {
    await expect(
      E2eRun.run(['journey', '--lane', 'sandbox', '--snapshot-stages', '--headless', ...ws()], config),
    ).rejects.toThrow(/--snapshot-stages.*requires the stack lane/);
  });

  it('a RED stage bakes no checkpoint and stops the ladder', async () => {
    installSeams('stage-1-roster'); // stage-1's Playwright child exits 1
    await expect(bakeThroughProgram()).rejects.toMatchObject({ oclif: { exit: 1 } });
    expect(() => readCkptManifest(CKPT_ROSTER)).toThrow(); // nothing baked
    expect(playwrightRuns()).toHaveLength(1); // stage 2 never spawned
  });
});

describe('--from (restore)', () => {
  it('restores the predecessor checkpoint, runs ONLY the window with --no-deps, reuses the BAKED dates', async () => {
    await bakeThroughProgram();

    // Tamper the baked dates to RECENT-but-distinct values so date-reuse is
    // distinguishable from a fresh clamp (an ancient date would now trip the
    // occurrence-age staleness cliff — by design).
    const fmt = (d: Date): string =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const yesterday = fmt(new Date(Date.now() - 86_400_000));
    const inSixWeeks = fmt(new Date(Date.now() + 41 * 86_400_000));
    const m = readCkptManifest(CKPT_ROSTER);
    (m.flow as Record<string, unknown>).dates = {
      occurrenceDate: yesterday,
      termStart: yesterday,
      termEnd: inSixWeeks,
    };
    writeCkptManifest(CKPT_ROSTER, m);

    runs.length = 0;
    ioCalls.length = 0;
    logged.length = 0;
    await E2eRun.run(['journey', '--from', 'program', '--through', 'program', '--headless', ...ws()], config);

    // Restore happened (pg restores + redis flush), reset did NOT.
    expect(ioCalls.some((c) => c.op === 'pgRestore')).toBe(true);
    expect(ioCalls.some((c) => c.op === 'redisFlushdb')).toBe(true);
    expect(logged.join('\n')).toContain(`==> restore: ${CKPT_ROSTER}`);
    expect(logged.join('\n')).not.toContain('==> reset (native');

    // Exactly the window stage ran, chain broken.
    const pw = playwrightRuns();
    expect(pw).toHaveLength(1);
    expect(pw[0]!.args).toContain('stage-2-program-creation');
    expect(pw[0]!.args).toContain('--no-deps');

    // §2.2: the child env carries ALL THREE baked dates, not today's clamp.
    expect(pw[0]!.env?.PLAYWRIGHT_OCCURRENCE_DATE).toBe(yesterday);
    expect(pw[0]!.env?.PLAYWRIGHT_TERM_START).toBe(yesterday);
    expect(pw[0]!.env?.PLAYWRIGHT_TERM_END).toBe(inSixWeeks);
  });

  it('an ancient baked OCCURRENCE date is refused even with a fresh bakedAt (re-bake laundering)', async () => {
    await bakeThroughProgram();
    const m = readCkptManifest(CKPT_ROSTER);
    (m.flow as Record<string, unknown>).dates = {
      occurrenceDate: '2020-03-02',
      termStart: '2020-03-02',
      termEnd: '2020-04-13',
    };
    writeCkptManifest(CKPT_ROSTER, m); // bakedAt stays fresh — the dates alone must trip the cliff

    await expect(
      E2eRun.run(['journey', '--from', 'program', '--through', 'program', '--headless', ...ws()], config),
    ).rejects.toThrow(/days old.*oldest of bakedAt\/occurrenceDate/);
  });

  it('a checkpoint that does not COVER the window databases is refused', async () => {
    await bakeThroughProgram();
    const m = readCkptManifest(CKPT_ROSTER);
    m.databases = (m.databases as { db: string }[]).filter((d) => d.db !== 'programs');
    writeCkptManifest(CKPT_ROSTER, m);

    await expect(
      E2eRun.run(['journey', '--from', 'program', '--through', 'program', '--headless', ...ws()], config),
    ).rejects.toThrow(/does not cover the window's database\(s\): programs/);
  });

  it('a missing checkpoint is a pointed error listing what IS baked + the bake command', async () => {
    await expect(
      E2eRun.run(['journey', '--from', 'program', '--headless', ...ws()], config),
    ).rejects.toThrow(/no checkpoint 'flow-saga-dash-journey-s1-roster'.*baked stages: \(none\)[\s\S]*--snapshot-stages/);

    // With SOME stages baked, the error names them.
    await bakeThroughProgram();
    rmSync(join(snapDir(), CKPT_PROGRAM), { recursive: true, force: true });
    rmSync(join(snapDir(), CKPT_ROSTER, 'manifest.json'), { force: true }); // roster unreadable ⇒ not listed
    await expect(
      E2eRun.run(['journey', '--from', 'program', '--headless', ...ws()], config),
    ).rejects.toThrow(/baked stages: \(none\)/);
  });

  it('--dry-run --output-json carries the checkpoint + bake projections (machine shape)', async () => {
    logged.length = 0;
    await E2eRun.run(
      ['journey', '--from', 'program', '--through', 'program', '--snapshot-stages', '--dry-run', '--headless', '--output-json', ...ws()],
      config,
    );
    const jsonLine = logged.find((l) => l.trimStart().startsWith('{'));
    const desc = JSON.parse(logged.slice(logged.indexOf(jsonLine as string)).join('\n')) as Record<string, unknown>;
    expect(desc.checkpoint).toEqual({ fixtureId: CKPT_ROSTER, predecessor: 'roster' });
    expect(desc.bakeCheckpoints).toEqual([CKPT_PROGRAM]);
  });

  it('a prefixHash mismatch (upstream stage edited) refuses with a re-bake hint', async () => {
    await bakeThroughProgram();
    const m = readCkptManifest(CKPT_ROSTER);
    (m.flow as Record<string, unknown>).prefixHash = 'deadbeef';
    writeCkptManifest(CKPT_ROSTER, m);

    await expect(
      E2eRun.run(['journey', '--from', 'program', '--headless', ...ws()], config),
    ).rejects.toThrow(/prefixHash mismatch[\s\S]*re-bake/);
  });

  it('the >7-day staleness cliff refuses; --from-stale-ok downgrades to a warning', async () => {
    await bakeThroughProgram();
    const m = readCkptManifest(CKPT_ROSTER);
    (m.flow as Record<string, unknown>).bakedAt = '2020-01-01T00:00:00.000Z';
    writeCkptManifest(CKPT_ROSTER, m);

    await expect(
      E2eRun.run(['journey', '--from', 'program', '--headless', ...ws()], config),
    ).rejects.toThrow(/days old.*--from-stale-ok/);

    runs.length = 0;
    logged.length = 0;
    await E2eRun.run(
      ['journey', '--from', 'program', '--through', 'program', '--from-stale-ok', '--headless', ...ws()],
      config,
    );
    expect(logged.join('\n')).toMatch(/⚠ checkpoint: .*days old/);
    expect(playwrightRuns()).toHaveLength(1);
  });

  it('--from at the FIRST stage is a plain full run (nothing to restore)', async () => {
    await E2eRun.run(['journey', '--from', 'roster', '--through', 'roster', '--headless', ...ws()], config);
    expect(logged.join('\n')).not.toContain('==> restore:');
    const pw = playwrightRuns();
    expect(pw).toHaveLength(1);
    expect(pw[0]!.args).not.toContain('--no-deps'); // default single-spawn path
  });

  it('--from and --skip-reset are mutually exclusive', async () => {
    await expect(
      E2eRun.run(['journey', '--from', 'program', '--skip-reset', ...ws()], config),
    ).rejects.toThrow(/--from and --skip-reset are mutually exclusive/);
  });

  it('--dry-run shows the restore line + window without touching a seam', async () => {
    await E2eRun.run(['journey', '--from', 'program', '--through', 'program', '--dry-run', '--headless', ...ws()], config);
    const out = logged.join('\n');
    expect(out).toContain(`restore: ${CKPT_ROSTER}`);
    expect(out).toMatch(/stages: program$/m); // the window, not the full prefix
    expect(runs).toHaveLength(0);
    expect(launches).toHaveLength(0);
  });
});

describe('prerequisite-via-checkpoint (M14-C)', () => {
  const CKPT_SCHEDULE = 'flow-saga-dash-journey-s5-schedule';

  /** Bake journey through schedule (5 stages) so connect-session's prerequisite has a checkpoint. */
  async function bakeThroughSchedule(): Promise<void> {
    await E2eRun.run(['journey', '--through', 'schedule', '--snapshot-stages', '--headless', ...ws()], config);
  }

  it('restores the prerequisite terminal checkpoint instead of replaying — baked dates reach the PARENT env', async () => {
    await bakeThroughSchedule();
    expect(() => readCkptManifest(CKPT_SCHEDULE)).not.toThrow();

    runs.length = 0;
    ioCalls.length = 0;
    logged.length = 0;
    await E2eRun.run(['connect-session', '--headless', ...ws()], config);

    const out = logged.join('\n');
    expect(out).toContain(`==> restore: ${CKPT_SCHEDULE}`);
    expect(out).toContain('restored from checkpoint (replay skipped)');
    expect(out).not.toContain("==> prerequisite: journey (through 'schedule', headless)");

    // Exactly ONE Playwright child (the connect room) — no journey replay spawn.
    const pw = playwrightRuns();
    expect(pw).toHaveLength(1);
    expect(pw[0]!.args).toContain('interactive-connect');

    // The PARENT spawn exports the checkpoint's baked dates (they crossed the
    // frame because the restore ran in the parent, not the recursion).
    const baked = (readCkptManifest(CKPT_SCHEDULE).flow as Record<string, unknown>).dates as Record<string, string>;
    expect(pw[0]!.env?.PLAYWRIGHT_OCCURRENCE_DATE).toBe(baked.occurrenceDate);
  });

  it('falls back to the full replay when no checkpoint is baked (never hard-errors)', async () => {
    await E2eRun.run(['connect-session', '--headless', ...ws()], config);
    const out = logged.join('\n');
    expect(out).toContain('falling back to full replay');
    expect(out).toContain("==> prerequisite: journey (through 'schedule', headless)");
    // Two Playwright children: the journey replay + the connect room.
    expect(playwrightRuns()).toHaveLength(2);
  });

  it('--no-prereq-from-snapshot forces the replay even when a valid checkpoint exists', async () => {
    await bakeThroughSchedule();
    runs.length = 0;
    logged.length = 0;
    await E2eRun.run(['connect-session', '--no-prereq-from-snapshot', '--headless', ...ws()], config);
    expect(logged.join('\n')).toContain("==> prerequisite: journey (through 'schedule', headless)");
    expect(logged.join('\n')).not.toContain('restored from checkpoint');
  });

  it('an INVALID prerequisite checkpoint falls back with the violation surfaced as a warning', async () => {
    await bakeThroughSchedule();
    const m = readCkptManifest(CKPT_SCHEDULE);
    (m.flow as Record<string, unknown>).prefixHash = 'deadbeef';
    writeCkptManifest(CKPT_SCHEDULE, m);

    runs.length = 0;
    logged.length = 0;
    await E2eRun.run(['connect-session', '--headless', ...ws()], config);
    const out = logged.join('\n');
    expect(out).toMatch(/falling back to full replay[\s\S]*prefixHash mismatch/);
    expect(out).toContain("==> prerequisite: journey (through 'schedule', headless)");
  });

  it('dry-run shows the opportunistic prerequisite restore line', async () => {
    logged.length = 0;
    await E2eRun.run(['connect-session', '--dry-run', '--headless', ...ws()], config);
    expect(logged.join('\n')).toMatch(/prerequisite: .*journey.*restore flow-saga-dash-journey-s5-schedule if baked/);
  });
});

describe('list surfaces (M14-C)', () => {
  it('e2e list marks baked stages [checkpoint] and stale ones [checkpoint: re-bake]', async () => {
    await bakeThroughProgram();
    // Stale-ify the program checkpoint (ancient occurrence date).
    const m = readCkptManifest(CKPT_PROGRAM);
    (m.flow as Record<string, unknown>).dates = {
      occurrenceDate: '2020-03-02',
      termStart: '2020-03-02',
      termEnd: '2020-04-13',
    };
    writeCkptManifest(CKPT_PROGRAM, m);

    logged.length = 0;
    const { default: E2eList } = await import('../list.js');
    await E2eList.run([...ws()], config);
    const out = logged.join('\n');
    expect(out).toMatch(/1\. roster.*\[checkpoint\]/);
    expect(out).toMatch(/2\. program.*\[checkpoint: re-bake\]/);
    expect(out).not.toMatch(/3\. enrollment.*checkpoint/); // never baked
  });

  it('snapshot list renders the checkpoint flow provenance (human sub-line + porcelain field 6)', async () => {
    await bakeThroughProgram();
    logged.length = 0;
    const { default: SnapshotList } = await import('../../stack/snapshot/list.js');
    await SnapshotList.run([...ws()], config);
    expect(logged.join('\n')).toMatch(/flow: saga-dash\/journey @ roster \(s1\) — baked \d{4}-\d{2}-\d{2}, occurrence/);

    logged.length = 0;
    await SnapshotList.run(['--porcelain', ...ws()], config);
    const row = logged.find((l) => l.startsWith(CKPT_PROGRAM));
    expect(row?.split('\t')[5]).toBe('saga-dash/journey@program');
  });
});

describe('e2e connect --refresh-snapshot (bake the prerequisite fresh, then restore it)', () => {
  it('bakes journey 1..schedule (one spawn per stage), restores the fresh checkpoint, then opens interactive-connect headed', async () => {
    await E2eConnect.run(['--refresh-snapshot', ...ws()], config);

    const pw = playwrightRuns();
    // 5 bake spawns (journey stages 1..5, headless) + 1 live interactive-connect.
    expect(pw).toHaveLength(6);
    // The bake ladder: stage-1 keeps its config deps, stages 2..5 break the chain.
    expect(pw[0]!.args).toContain('stage-1-roster');
    expect(pw[4]!.args).toContain('stage-5-schedule');
    expect(pw[4]!.args).not.toContain('--headed');
    // The live session is LAST, headed, and the prerequisite was RESTORED (not
    // replayed) — so there is exactly one stage-5-schedule spawn (the bake's).
    expect(pw[5]!.args).toContain('interactive-connect');
    expect(pw[5]!.args).toContain('--headed');
    expect(pw.filter((r) => r.args.includes('stage-5-schedule'))).toHaveLength(1);

    const out = logged.join('\n');
    expect(out).toContain('refresh-snapshot: baking journey@schedule');
    expect(out).toContain('restored from checkpoint (replay skipped)');

    // The freshly baked terminal checkpoint is on disk with the right provenance.
    const schedule = readCkptManifest(CKPT_SCHEDULE);
    expect((schedule.flow as Record<string, unknown>).stageId).toBe('schedule');

    // soa#327 wiring pin: THIS bake path (develop connect --refresh-snapshot)
    // must pass the settle barrier into the bake deps — it exists precisely to
    // produce the checkpoint the tunnel session will trust. Unwiring
    // settleBarrier in connect.ts silently bakes torn iam state ⇒ red here.
    expect(barrierCalls.map((c) => c.stageId)).toEqual(['roster', 'program', 'enrollment', 'pods', 'schedule']);
    expect(barrierCalls[0]?.personas).toEqual(['alex.tutor@example.org']);
  });

  it('--refresh-snapshot --reuse is rejected (reuse strips the prerequisite there is nothing to bake)', async () => {
    await expect(E2eConnect.run(['--refresh-snapshot', '--reuse', ...ws()], config)).rejects.toThrow(
      /mutually exclusive/,
    );
  });

  it('--refresh-snapshot --no-prereq-from-snapshot is rejected (it would bake but never restore)', async () => {
    await expect(
      E2eConnect.run(['--refresh-snapshot', '--no-prereq-from-snapshot', ...ws()], config),
    ).rejects.toThrow(/needs --prereq-from-snapshot/);
  });
});

describe('tunnel fail-loud (soa#327): unusable prerequisite checkpoint under --tunnel', () => {
  function fakeMoniker(): void {
    vi.spyOn(BaseCommand.prototype as never, 'getTunnelMoniker' as never).mockReturnValue(
      (async () => 'testmoniker') as never,
    );
  }

  it('a STALE journey@schedule checkpoint hard-errors with the violation + the docs/tunnel.md recipe', async () => {
    await E2eRun.run(['journey', '--through', 'schedule', '--snapshot-stages', '--headless', ...ws()], config);
    const m = readCkptManifest(CKPT_SCHEDULE);
    (m.flow as Record<string, unknown>).bakedAt = '2020-01-01T00:00:00.000Z';
    writeCkptManifest(CKPT_SCHEDULE, m);

    runs.length = 0;
    fakeMoniker();
    await expect(E2eConnect.run(['--tunnel', ...ws()], config)).rejects.toThrow(
      /days old[\s\S]*ss stack snapshot restore tunnel-connect[\s\S]*--refresh-snapshot/,
    );
    // The gate refuses BEFORE any replay spawn — deletion of the gate makes the
    // journey replay run and these appear (the mutation signature).
    expect(playwrightRuns()).toHaveLength(0);
  });

  it('--no-prereq-from-snapshot under --tunnel refuses the replay loudly (every road into the replay is guarded)', async () => {
    // No checkpoint baked at all: the flag skips the restore attempt entirely,
    // so the ONLY protection is the guard at the replay entry itself — the
    // restore-block gate never runs (deps.checkpoints is unconstructed).
    fakeMoniker();
    await expect(E2eConnect.run(['--tunnel', '--no-prereq-from-snapshot', ...ws()], config)).rejects.toThrow(
      /refusing to fall back silently[\s\S]*--no-prereq-from-snapshot/,
    );
    // Refused BEFORE any spawn — deleting the replay-entry guard makes the
    // journey replay run over the tunnel (the WAN-starved-polls trap).
    expect(playwrightRuns()).toHaveLength(0);
  });

  it('the SAME stale checkpoint WITHOUT --tunnel keeps the local warn+replay (regression pin)', async () => {
    await E2eRun.run(['journey', '--through', 'schedule', '--snapshot-stages', '--headless', ...ws()], config);
    const m = readCkptManifest(CKPT_SCHEDULE);
    (m.flow as Record<string, unknown>).bakedAt = '2020-01-01T00:00:00.000Z';
    writeCkptManifest(CKPT_SCHEDULE, m);

    runs.length = 0;
    logged.length = 0;
    await E2eConnect.run([...ws()], config);
    expect(logged.join('\n')).toContain('falling back to full replay');
    expect(playwrightRuns().length).toBeGreaterThan(1); // journey replay + the room
  });
});

describe('bake quiescence barrier (soa#327)', () => {
  it('fires ONCE per stage BEFORE that stage’s first dump (declared personas ride the context)', async () => {
    // Recording barrier that snapshots how many pgDumps had happened at call
    // time — the ordering witness. Deleting the await (or moving it after the
    // bake) makes the second entry include its own stage's dumps ⇒ red.
    const pgDumpsAtBarrier: number[] = [];
    const fixtures: string[] = [];
    const barrier: SettleBarrier = async (ctx) => {
      pgDumpsAtBarrier.push(ioCalls.filter((c) => c.op === 'pgDump').length);
      fixtures.push(ctx.fixtureId);
      expect(ctx.personas).toEqual(['alex.tutor@example.org']);
    };
    vi.spyOn(
      BaseCommand.prototype as unknown as { getSettleBarrier: () => SettleBarrier },
      'getSettleBarrier',
    ).mockReturnValue(barrier);

    await bakeThroughProgram();

    expect(fixtures).toEqual([CKPT_ROSTER, CKPT_PROGRAM]);
    const perStage = ioCalls.filter((c) => c.op === 'pgDump').length / 2;
    expect(perStage).toBeGreaterThan(0);
    // Stage 1's barrier ran before ANY dump; stage 2's before its OWN dumps.
    expect(pgDumpsAtBarrier).toEqual([0, perStage]);
  });

  it('a barrier timeout FAILS the bake: no manifest for the stage, ladder stops', async () => {
    vi.spyOn(
      BaseCommand.prototype as unknown as { getSettleBarrier: () => SettleBarrier },
      'getSettleBarrier',
    ).mockReturnValue(async () => {
      throw new Error("settle barrier TIMED OUT before baking 'flow-saga-dash-journey-s1-roster'");
    });

    await expect(bakeThroughProgram()).rejects.toThrow(/settle barrier TIMED OUT/);
    // NOTHING was dumped or manifested for the unsettled stage — a red bake, not
    // a torn checkpoint. Stage 2 never spawned (the ladder stopped).
    expect(ioCalls.filter((c) => c.op === 'pgDump')).toHaveLength(0);
    expect(() => readCkptManifest(CKPT_ROSTER)).toThrow();
    expect(playwrightRuns()).toHaveLength(1);
  });

  it('a flow with NO settlePersonas bakes with ZERO barrier calls — and says so LOUDLY per stage', async () => {
    // Same bundled journey minus the declaration, via the --spa-path override.
    const manifest = JSON.parse(
      readFileSync(
        resolve(PKG_ROOT, 'examples', 'flows', 'saga-dash.flows.json'),
        'utf8',
      ),
    ) as { flows: Record<string, unknown>[] };
    for (const flow of manifest.flows) delete flow.settlePersonas;
    const spaPath = join(DASH_ROOT, 'no-personas.flows.json');
    writeFileSync(spaPath, JSON.stringify(manifest));

    logged.length = 0;
    await E2eRun.run(
      ['journey', '--through', 'program', '--snapshot-stages', '--headless', '--spa-path', spaPath, ...ws()],
      config,
    );
    expect(barrierCalls).toHaveLength(0);
    expect(() => readCkptManifest(CKPT_ROSTER)).not.toThrow(); // bake unaffected
    // The skip is VISIBLE: discovery prefers the SPA repo's authored flows.json,
    // so an undeclared flow baking iam state silently is the soa#327 trap.
    const warns = logged.filter((l) =>
      l.includes("bake quiescence barrier skipped: flow 'journey' declares no settlePersonas"),
    );
    expect(warns).toHaveLength(2); // once per baked stage (roster, program)
  });

  it('the default bake DOES invoke the barrier with the journey personas (gating positive)', async () => {
    await bakeThroughProgram();
    expect(barrierCalls.map((c) => c.stageId)).toEqual(['roster', 'program']);
    expect(barrierCalls[0]?.personas).toEqual(['alex.tutor@example.org']);
  });
});

describe('tunnel post-restore persona preflight (soa#327)', () => {
  let posts: { url: string; opts: PostOptions }[];
  let savedVmsBase: string | undefined;

  /** Poster answering `statuses` in order (last repeats); records every call. */
  function installPoster(statuses: number[]): void {
    posts = [];
    const poster: CookiePoster = {
      async post(url: string, opts: PostOptions): Promise<PostResult> {
        posts.push({ url, opts });
        const status = statuses[Math.min(posts.length - 1, statuses.length - 1)] ?? 0;
        return { status, ok: status >= 200 && status < 300, setCookies: [] };
      },
    };
    vi.spyOn(
      BaseCommand.prototype as unknown as { getCookiePoster: () => CookiePoster },
      'getCookiePoster',
    ).mockReturnValue(poster);
  }

  function fakeMoniker(): void {
    vi.spyOn(BaseCommand.prototype as never, 'getTunnelMoniker' as never).mockReturnValue(
      (async () => 'testmoniker') as never,
    );
  }

  beforeEach(() => {
    // Pin the tunnel base domain so the probed URL is exactly assertable.
    savedVmsBase = process.env.VMS_BASE;
    process.env.VMS_BASE = 'vms.test';
  });
  afterEach(() => {
    if (savedVmsBase === undefined) delete process.env.VMS_BASE;
    else process.env.VMS_BASE = savedVmsBase;
  });

  async function bakeSchedule(): Promise<void> {
    await E2eRun.run(['journey', '--through', 'schedule', '--snapshot-stages', '--headless', ...ws()], config);
    runs.length = 0;
    ioCalls.length = 0;
    logged.length = 0;
  }

  it('valid checkpoint + poster 200: the session proceeds; ONE devLogin against the exact tunnel iam host', async () => {
    await bakeSchedule();
    installPoster([200]);
    fakeMoniker();
    await E2eConnect.run(['--tunnel', ...ws()], config);

    // The probe drove the SAME host the room's browsers will use, with iam's own
    // origin (the origin-check is load-bearing) and the declared persona.
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe('https://iam.testmoniker.vms.test/trpc/auth.devLogin');
    expect(posts[0]!.opts.origin).toBe('https://iam.testmoniker.vms.test');
    expect(posts[0]!.opts.body).toContain('alex.tutor@example.org');
    expect(playwrightRuns().some((r) => r.args.includes('interactive-connect'))).toBe(true);
  });

  it('poster 401: TORN checkpoint — loud error naming the persona + the recipe; no browser launches', async () => {
    await bakeSchedule();
    installPoster([401]);
    fakeMoniker();
    await expect(E2eConnect.run(['--tunnel', ...ws()], config)).rejects.toThrow(
      /alex\.tutor@example\.org[\s\S]*HTTP 401[\s\S]*ss stack snapshot restore tunnel-connect/,
    );
    expect(playwrightRuns()).toHaveLength(0);
  });

  it('transport blips: status 0 twice then 200 proceeds — poster called 3x', async () => {
    await bakeSchedule();
    installPoster([0, 0, 200]);
    fakeMoniker();
    await E2eConnect.run(['--tunnel', ...ws()], config);
    expect(posts).toHaveLength(3);
    expect(playwrightRuns().some((r) => r.args.includes('interactive-connect'))).toBe(true);
  });

  it('persistently unreachable iam: capped retries then the loud torn error', async () => {
    await bakeSchedule();
    installPoster([0]);
    fakeMoniker();
    await expect(E2eConnect.run(['--tunnel', ...ws()], config)).rejects.toThrow(/no response/);
    // Literal, not the imported constant, so the cap's value stays pinned.
    expect(posts).toHaveLength(3);
    expect(playwrightRuns()).toHaveLength(0);
  });

  it('poster 403: devLogin-disabled misconfig gets its OWN message, NOT the re-bake recipe', async () => {
    await bakeSchedule();
    installPoster([403]);
    fakeMoniker();
    let message = '';
    try {
      await E2eConnect.run(['--tunnel', ...ws()], config);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/devLogin is disabled/);
    // Re-baking cannot fix an AUTH_ENABLED/origin misconfig — the recipe would
    // send the user on a wild-goose chase.
    expect(message).not.toContain('ss stack snapshot restore tunnel-connect');
    expect(playwrightRuns()).toHaveLength(0);
  });

  it('e2e run --from --tunnel fires the preflight after the --from restore too', async () => {
    await bakeThroughProgram();
    runs.length = 0;
    installPoster([200]);
    fakeMoniker();
    await E2eRun.run(['journey', '--from', 'program', '--through', 'program', '--tunnel', '--headless', ...ws()], config);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe('https://iam.testmoniker.vms.test/trpc/auth.devLogin');
    expect(playwrightRuns()).toHaveLength(1);
  });

  it('a NON-tunnel restore makes ZERO devLogin probes (local lane byte-identical)', async () => {
    await bakeSchedule();
    installPoster([200]);
    await E2eConnect.run([...ws()], config);
    expect(posts).toHaveLength(0);
    expect(playwrightRuns().some((r) => r.args.includes('interactive-connect'))).toBe(true);
  });
});

describe('M14-C review fixes', () => {
  it('--no-prereq-from-snapshot --dry-run does NOT advertise a restore the run would never attempt', async () => {
    logged.length = 0;
    const { default: Run } = await import('../run.js');
    await Run.run(['connect-session', '--no-prereq-from-snapshot', '--dry-run', '--headless', ...ws()], config);
    const out = logged.join('\n');
    expect(out).toContain('prerequisite:');
    expect(out).not.toContain('restore flow-saga-dash-journey-s5-schedule');
  });
});

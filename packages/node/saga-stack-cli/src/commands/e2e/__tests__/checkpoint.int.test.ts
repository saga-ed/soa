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
import { Config } from '@oclif/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import type {
  DashFs,
  HealthProber,
  LaunchResult,
  LaunchSpec,
  MeshExec,
  PgProbe,
  PortProbe,
  ProbeResult,
  RunResult,
  Runner,
  ScriptInvocation,
  ServiceLauncher,
  SnapshotIO,
  StopResult,
} from '../../../runtime/index.js';
import E2eRun from '../run.js';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const DEV_ROOT = '/fixed/dev';

const CKPT_ROSTER = 'flow-saga-dash-journey-s1-roster';
const CKPT_PROGRAM = 'flow-saga-dash-journey-s2-program';

let DASH_ROOT: string;
let snapDir: string;
let config: Config;
let launches: LaunchSpec[];
let runs: ScriptInvocation[];
let ioCalls: { op: string; db?: string; path?: string }[];
let logged: string[];

/** run.int.test.ts's seam recipe; `playwrightFail` fails children whose args include it. */
function installSeams(playwrightFail?: string): void {
  launches = [];
  runs = [];

  const launcher: ServiceLauncher = {
    async launch(spec: LaunchSpec): Promise<LaunchResult> {
      launches.push(spec);
      return { id: spec.id, ok: true, pid: 3000 + launches.length };
    },
    async stopServices(ids: string[]): Promise<StopResult[]> {
      return ids.map((id) => ({ id, stopped: true }));
    },
  };
  const meshExec: MeshExec = { async ready(): Promise<boolean> { return true; } };
  const portProbe: PortProbe = {
    async dockerHolder(): Promise<string | null> { return null; },
    async listening(): Promise<boolean> { return false; },
  };
  const dashFs: DashFs = { existsDir: () => true, existsFile: () => false, remove: () => {}, write: () => {} };
  const prober: HealthProber = { async probe(): Promise<ProbeResult> { return { ok: true, status: 200 }; } };
  const provisioned = new Set<string>();
  const runner: Runner = {
    async run(spec: ScriptInvocation): Promise<RunResult> {
      runs.push(spec);
      const ci = spec.args.indexOf('-c');
      if (ci >= 0) {
        const m = /CREATE DATABASE (\w+)/.exec(spec.args[ci + 1] ?? '');
        if (m) provisioned.add(m[1]);
      }
      if (playwrightFail !== undefined && spec.args.includes('playwright') && spec.args.includes(playwrightFail)) {
        return { code: 1 };
      }
      return { code: 0 };
    },
  };
  const pgProbe: PgProbe = {
    async databaseExists(_c, db): Promise<boolean> { return provisioned.has(db); },
    async hasMigrationsTable(): Promise<boolean> { return false; },
    async publicTableCount(): Promise<number> { return 0; },
    async scalar(): Promise<string> { return ''; },
  };
  const snapshotIO: SnapshotIO = {
    async pgDump(db, _c, _o, outPath) {
      ioCalls.push({ op: 'pgDump', db, path: outPath });
      writeFileSync(outPath, `PGDUMP:${db}`);
    },
    async pgRestore(db, _c, _o, inPath) {
      ioCalls.push({ op: 'pgRestore', db, path: inPath });
    },
    async mongoDump(_c, db, outPath) {
      ioCalls.push({ op: 'mongoDump', db, path: outPath });
      writeFileSync(outPath, `MONGO:${db}`);
    },
    async mongoRestore(_c, db, inPath) {
      ioCalls.push({ op: 'mongoRestore', db, path: inPath });
    },
    async assertPgRunning() { ioCalls.push({ op: 'assertPgRunning' }); },
    async assertMongoRunning() { ioCalls.push({ op: 'assertMongoRunning' }); },
    // null ⇒ the snapshot-ahead guard is inert (covered by snapshot.int.test.ts).
    async readSchemaRev() { return null; },
    async redisFlushdb() { ioCalls.push({ op: 'redisFlushdb' }); },
    async pgRestoreList() { return true; },
  };

  const proto = BaseCommand.prototype as unknown as Record<string, () => unknown>;
  vi.spyOn(proto, 'getLauncher').mockReturnValue(launcher);
  vi.spyOn(proto, 'getMeshExec').mockReturnValue(meshExec);
  vi.spyOn(proto, 'getPortProbe').mockReturnValue(portProbe);
  vi.spyOn(proto, 'getDashFs').mockReturnValue(dashFs);
  vi.spyOn(proto, 'getProber').mockReturnValue(prober);
  vi.spyOn(proto, 'getRunner').mockReturnValue(runner);
  vi.spyOn(proto, 'getPgProbe').mockReturnValue(pgProbe);
  vi.spyOn(proto, 'getPrepFreshCheck').mockReturnValue(() => true);
  vi.spyOn(proto, 'getDbGenerateScan').mockReturnValue(() => []);
  vi.spyOn(proto, 'getRepoDirCheck').mockReturnValue(() => true);
  vi.spyOn(proto as unknown as { getSnapshotIO: () => SnapshotIO }, 'getSnapshotIO').mockReturnValue(snapshotIO);
}

function ws(): string[] {
  return ['--saga-dash', DASH_ROOT, '--soa', SOA_ROOT, '--dev', DEV_ROOT];
}

function playwrightRuns(): ScriptInvocation[] {
  return runs.filter((r) => r.command === 'pnpm' && r.args.includes('playwright'));
}

function readCkptManifest(fixtureId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(snapDir, fixtureId, 'manifest.json'), 'utf8')) as Record<string, unknown>;
}

function writeCkptManifest(fixtureId: string, m: Record<string, unknown>): void {
  writeFileSync(join(snapDir, fixtureId, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
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
  snapDir = mkdtempSync(join(tmpdir(), 'saga-ckpt-'));
  process.env.SAGA_MESH_SNAPSHOTS_DIR = snapDir;
  ioCalls = [];
  installSeams();
  logged = [];
  vi.spyOn(BaseCommand.prototype, 'log').mockImplementation((m?: string) => {
    logged.push(String(m ?? ''));
  });
  vi.spyOn(BaseCommand.prototype, 'warn').mockImplementation(((m: string) => m) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(snapDir, { recursive: true, force: true });
  delete process.env.SAGA_MESH_SNAPSHOTS_DIR;
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

    // Both checkpoints exist on disk with the M14 flow block.
    const roster = readCkptManifest(CKPT_ROSTER);
    const program = readCkptManifest(CKPT_PROGRAM);
    const rosterFlow = roster.flow as Record<string, unknown>;
    const programFlow = program.flow as Record<string, unknown>;
    expect(rosterFlow.stageId).toBe('roster');
    expect(programFlow.stageId).toBe('program');
    expect(rosterFlow.prefixHash).not.toBe(programFlow.prefixHash); // prefix grows per stage
    expect((rosterFlow.dates as Record<string, string>).occurrenceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Dumps happened for the closure DBs (canned bytes are real files).
    expect(ioCalls.filter((c) => c.op === 'pgDump').length).toBeGreaterThan(0);
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

    // Tamper the baked occurrence date so date-reuse is distinguishable from
    // a fresh clamp computing the same value.
    const m = readCkptManifest(CKPT_ROSTER);
    (m.flow as Record<string, unknown>).dates = {
      occurrenceDate: '2020-03-02',
      termStart: '2020-03-02',
      termEnd: '2020-04-13',
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

    // §2.2: the child env carries the BAKED dates, not today's clamp.
    expect(pw[0]!.env?.PLAYWRIGHT_OCCURRENCE_DATE).toBe('2020-03-02');
    expect(pw[0]!.env?.PLAYWRIGHT_TERM_START).toBe('2020-03-02');
  });

  it('a missing checkpoint is a pointed error naming the bake command', async () => {
    await expect(
      E2eRun.run(['journey', '--from', 'program', '--headless', ...ws()], config),
    ).rejects.toThrow(/no checkpoint 'flow-saga-dash-journey-s1-roster'[\s\S]*--snapshot-stages/);
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

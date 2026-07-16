/**
 * `develop connect` SLOT-AWARENESS integration tests (gh_305) — the real oclif
 * command with every BaseCommand IO seam faked (e2e.int.test.ts harness). NOTHING
 * is spawned; the fake Runner/Launcher record the intended invocations.
 *
 * This suite lives beside the command (not in commands/e2e/__tests__ with the rest
 * of connect's coverage) because it owns a DIFFERENT axis: those suites assert flow
 * orchestration (prerequisite recursion, --reuse, --fake-media, checkpoint compat)
 * at slot 0 and are deliberately slot-agnostic; this one owns the slot plumbing —
 * state dir, snapshot root, offset service URLs — and mirrors coach.int.test.ts's
 * slot block.
 *
 * Every assertion here PROVES the offset (a concrete slot-2 path/port), never
 * merely that `--slot 2` failed to throw: the bug this suite guards is `--slot N`
 * silently running against slot 0, which throws nothing at all.
 */

import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { Config } from '@oclif/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import type { ScriptInvocation } from '../../../runtime/index.js';
import type { CheckpointStore } from '../../../runtime/index.js';
import { useTempSnapshotsDir } from '../../../__tests__/helpers/env.js';
import { installCoreSeams } from '../../../__tests__/helpers/seams.js';
import DevelopConnect from '../connect.js';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const DEV_ROOT = '/fixed/dev';

let DASH_ROOT: string;
let config: Config;
let runs: ScriptInvocation[];
let launcherSpy: ReturnType<typeof vi.spyOn>;

/**
 * The snapshot root observed AT CHECKPOINT-STORE CONSTRUCTION — the M2 ordering
 * probe. The store resolves `$SAGA_MESH_SNAPSHOTS_DIR` at CALL time, so the
 * invariant is that `applyInstanceEnv(profile)` precedes the first bake/restore;
 * the command satisfies it by building the store in between. Sampling the env in
 * the spy makes the ordering (not just the end state) assertable at that point.
 */
let rootAtStoreBuild: string | undefined;

// Hermetic snapshot root for the slot-0 baseline. At slot > 0 applyInstanceEnv
// legitimately OVERRIDES this with the profile's `~/.saga-mesh/snapshots-s<N>` —
// that override is the property under test, and the getCheckpointStore fake below
// means no real store ever forms, so nothing is read from or written to $HOME.
const snapDir = useTempSnapshotsDir('saga-connect-slot-');

function installSeams(): void {
  const seams = installCoreSeams({ pidBase: 2000, prepFresh: false, captureLauncherSpy: true });
  runs = seams.runs;
  launcherSpy = seams.launcherSpy as ReturnType<typeof vi.spyOn>;

  // Record the snapshot root as the store is CONSTRUCTED, then hand back a store
  // whose `load` reports "no checkpoint" so the prerequisite falls back to a normal
  // headless replay — no snapshot IO, hermetic.
  rootAtStoreBuild = undefined;
  const store: CheckpointStore = {
    load: () => null,
    bake: async () => {},
    restore: async () => {},
  };
  vi.spyOn(
    BaseCommand.prototype as unknown as { getCheckpointStore: () => CheckpointStore },
    'getCheckpointStore',
  ).mockImplementation(() => {
    rootAtStoreBuild = process.env.SAGA_MESH_SNAPSHOTS_DIR;
    return store;
  });
}

/** Workspace flags: stub saga-dash (no flows.json → bundled fallback) + real soa. */
function ws(): string[] {
  return ['--saga-dash', DASH_ROOT, '--soa', SOA_ROOT, '--dev', DEV_ROOT];
}

function playwrightRuns(): ScriptInvocation[] {
  return runs.filter((r) => r.command === 'pnpm' && r.args.includes('playwright'));
}

/** The headed live-session spawn (the flow's terminal stage). */
function liveRun(): ScriptInvocation | undefined {
  return playwrightRuns().find((r) => r.args.includes('interactive-connect'));
}

/** The state dir the command pointed the launcher at. */
function launcherStateDir(): unknown {
  return launcherSpy.mock.calls[0]?.[0];
}

beforeAll(() => {
  DASH_ROOT = mkdtempSync(join(tmpdir(), 'saga-dash-connect-slot-'));
});
afterAll(() => {
  rmSync(DASH_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  installSeams();
  vi.spyOn(BaseCommand.prototype, 'log').mockImplementation(() => {});
  vi.spyOn(BaseCommand.prototype, 'warn').mockImplementation(((m: string) => m) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('develop connect — slot awareness (slot > 0)', () => {
  it('--slot 2 targets slot 2: offset state dir, offset iam/connect URLs on the live session', async () => {
    await DevelopConnect.run(['--slot', '2', ...ws()], config);

    // The launcher gets the SLOT's pid/log dir — without it every slot collides on
    // ServiceLauncher's default /tmp/sds-synthetic pidfiles.
    expect(launcherStateDir()).toBe('/tmp/sds-synthetic-s2');

    // The headed room drives the slot-2 OFFSET services (offset = slot * 1000).
    // These come from `ports` reaching executeResolvedFlow; without them
    // playwrightEnv skips serviceUrlEnv and the specs' lane.ts silently falls back
    // to the base ports below.
    const live = liveRun();
    expect(live?.env?.PLAYWRIGHT_IAM_URL).toBe('http://localhost:5010'); // 3010 + 2000
    expect(live?.env?.PLAYWRIGHT_CONNECT_API_URL).toBe('http://localhost:8106'); // 6106 + 2000
    expect(live?.env?.PLAYWRIGHT_BASE_URL).toBe('http://localhost:10900'); // saga-dash 8900 + 2000
    // Explicitly NOT slot 0's iam — the silent-slot-0 bug's signature.
    expect(live?.env?.PLAYWRIGHT_IAM_URL).not.toBe('http://localhost:3010');
  });

  it('--slot 2 threads the offset ports into the JOURNEY PREREQUISITE too (deps ride the recursion)', async () => {
    await DevelopConnect.run(['--slot', '2', ...ws()], config);

    // The prerequisite is a separate ResolvedFlow built through `schedule`; it seeds
    // the room's data, so a slot-0 prerequisite behind a slot-2 room is a split brain.
    const prereq = playwrightRuns().find((r) => r.args.includes('stage-5-schedule'));
    expect(prereq?.env?.PLAYWRIGHT_IAM_URL).toBe('http://localhost:5010');
  });

  it('--slot 2 PROVISIONS + MIGRATES the slot-2 DBs (a fresh slot has none)', async () => {
    await DevelopConnect.run(['--slot', '2', ...ws()], config);

    // StackApi gates the whole native-prep pass on `runtime.pgProbe`; without the
    // prep seams connect silently no-ops provision + migrate. Tolerable at slot 0
    // (its DBs already exist) — fatal at a FRESH slot N, which has none.
    const creates = runs.filter((r) => JSON.stringify(r.args).includes('CREATE DATABASE'));
    expect(creates.length).toBeGreaterThan(0);
    // …and they run against the SLOT's postgres container, not the base one —
    // proving applyInstanceEnv's container-env seam reached the runtime.
    expect(creates.every((r) => r.args.includes('soa-s2-postgres-1'))).toBe(true);

    // R3 migrate targets the slot's OFFSET postgres port (5432 + 2000).
    const migrate = runs.find((r) => r.args.includes('db:deploy') && r.env?.DATABASE_URL !== undefined);
    expect(migrate?.env?.DATABASE_URL).toContain('localhost:7432');
  });

  it('--tunnel --slot 2 hard-errors (tunnel fronts fixed slot-0 ports)', async () => {
    // Never spawn the vendored tunnel.sh — inject a fixed moniker. If the guard
    // regresses, the run proceeds through this seam instead of erroring.
    const moniker = vi.fn(async () => 'testmoniker');
    vi.spyOn(BaseCommand.prototype as never, 'getTunnelMoniker' as never).mockReturnValue(moniker as never);

    await expect(DevelopConnect.run(['--tunnel', '--slot', '2', ...ws()], config)).rejects.toThrow(
      /slot 2:.*slot-0 browser ports/,
    );
    // The guard must fire BEFORE any tunnel resolution or bring-up.
    expect(moniker).not.toHaveBeenCalled();
    expect(playwrightRuns()).toHaveLength(0);
  });

  it('--tunnel --reuse at slot 0 still works (the guard is slot-scoped, not a tunnel ban)', async () => {
    vi.spyOn(BaseCommand.prototype as never, 'getTunnelMoniker' as never).mockReturnValue(
      (async () => 'testmoniker') as never,
    );
    // --reuse: the walkthrough-verified concierge path (docs/tunnel.md step 3). A bare
    // tunnel run with no baked prerequisite checkpoint now fail-louds by design
    // (soa#327, covered below); the concierge path must stay byte-identical.
    await DevelopConnect.run(['--tunnel', '--reuse', ...ws()], config);
    expect(liveRun()?.env?.PLAYWRIGHT_BASE_URL).toMatch(/^https:\/\/dash\.testmoniker\./);
  });
});

describe('develop connect — tunnel fail-loud on an unusable prerequisite checkpoint (soa#327)', () => {
  function fakeMoniker(): void {
    vi.spyOn(BaseCommand.prototype as never, 'getTunnelMoniker' as never).mockReturnValue(
      (async () => 'testmoniker') as never,
    );
  }

  it('--tunnel with NO baked checkpoint hard-errors with the docs/tunnel.md recipe — no silent WAN replay', async () => {
    fakeMoniker();
    // The seams' store fake answers load → null (no checkpoint baked).
    await expect(DevelopConnect.run(['--tunnel', ...ws()], config)).rejects.toThrow(
      /ss stack snapshot restore tunnel-connect[\s\S]*--refresh-snapshot/,
    );
    // The gate must PREVENT the replay: no Playwright child (journey stages or the
    // room) was ever spawned, and no reset/seed ran. If the gate is deleted, the
    // fallback replay runs and these invocations appear — the mutation is caught.
    expect(playwrightRuns()).toHaveLength(0);
    expect(runs.some((r) => r.args.includes('db:seed'))).toBe(false);
  });

  it('the loud error embeds the ORIGINAL violation so the remediation is exact', async () => {
    fakeMoniker();
    await expect(DevelopConnect.run(['--tunnel', ...ws()], config)).rejects.toThrow(/no checkpoint 'flow-saga-dash-journey-s5-schedule'/);
  });

  it('WITHOUT --tunnel the same missing checkpoint still falls back to the full replay (local lane pinned)', async () => {
    // Regression twin of checkpoint.int.test.ts "falls back … never hard-errors":
    // the gate is tunnel-scoped, the local lane keeps the silent replay.
    await DevelopConnect.run([...ws()], config);
    // Replay signature: the journey prerequisite spawned before the live room.
    expect(playwrightRuns().length).toBeGreaterThan(1);
    expect(liveRun()).toBeDefined();
  });
});

describe('develop connect — per-slot checkpoint root (the cross-slot corruption guard)', () => {
  it('builds the checkpoint store in the SLOT-2 snapshot root (applyInstanceEnv must run FIRST)', async () => {
    await DevelopConnect.run(['--slot', '2', ...ws()], config);

    // The journey@schedule checkpoint --prereq-from-snapshot bakes/restores MUST live
    // under the slot's own root. Shared, two concurrent slots read/write the SAME
    // on-disk checkpoint — data corruption, not a port clash. The store resolves that
    // root at CALL time, so the real invariant is `applyInstanceEnv` before the first
    // bake/restore. Sampling the env at construction is a PROXY for that (the store is
    // built between the two), and it is deliberately STRICTER than the invariant: a
    // hoist above `applyInstanceEnv` fails here without being corrupting on its own.
    // What it does catch is the mutation that matters — `applyInstanceEnv` dropped or
    // moved after the flow — since then the env is never the slot's root at all.
    expect(rootAtStoreBuild).toBe(join(homedir(), '.saga-mesh', 'snapshots-s2'));
    expect(rootAtStoreBuild).not.toBe(snapDir()); // not the base/shared root
  });

  it('--refresh-snapshot bakes into the slot-2 root, off the slot-2 stack', async () => {
    await DevelopConnect.run(['--refresh-snapshot', '--slot', '2', ...ws()], config);
    expect(rootAtStoreBuild).toBe(join(homedir(), '.saga-mesh', 'snapshots-s2'));

    // The bake is its OWN executeResolvedFlow call (a stage-by-stage headless replay,
    // so stage-1-roster appears only here — the main run's prerequisite enters at
    // stage-5). It needs the offset ports independently of the main run: a bake driven
    // against the base iam would bake slot-0 data INTO the slot-2 checkpoint root.
    const bake = playwrightRuns().find((r) => r.args.includes('stage-1-roster'));
    expect(bake).toBeDefined();
    expect(bake?.env?.PLAYWRIGHT_IAM_URL).toBe('http://localhost:5010');
  });

  it('two slots resolve DIFFERENT checkpoint roots (the concurrency invariant, stated directly)', async () => {
    await DevelopConnect.run(['--slot', '2', ...ws()], config);
    const s2 = rootAtStoreBuild;
    vi.restoreAllMocks();
    installSeams();
    vi.spyOn(BaseCommand.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(BaseCommand.prototype, 'warn').mockImplementation(((m: string) => m) as never);

    await DevelopConnect.run(['--slot', '3', ...ws()], config);
    expect(rootAtStoreBuild).toBe(join(homedir(), '.saga-mesh', 'snapshots-s3'));
    expect(rootAtStoreBuild).not.toBe(s2);
  });
});

describe('develop connect — slot 0 is UNCHANGED (regression)', () => {
  it('uses the base state dir, the base service URLs, and the ambient snapshot root', async () => {
    await DevelopConnect.run([...ws()], config);

    // deriveInstance({slot:0}) is the no-offset default: same state dir as before.
    expect(launcherStateDir()).toBe('/tmp/sds-synthetic');

    // Base (un-offset) service URLs.
    const live = liveRun();
    expect(live?.env?.PLAYWRIGHT_IAM_URL).toBe('http://localhost:3010');
    expect(live?.env?.PLAYWRIGHT_BASE_URL).toBe('http://localhost:8900');

    // Slot 0 carries an undefined snapshotsDir ⇒ applyInstanceEnv is a NO-OP and the
    // ambient $SAGA_MESH_SNAPSHOTS_DIR (here: the temp root) still wins.
    expect(rootAtStoreBuild).toBe(snapDir());
  });

  it('--state-dir still overrides the slot default', async () => {
    await DevelopConnect.run(['--state-dir', '/tmp/pinned', '--slot', '2', ...ws()], config);
    expect(launcherStateDir()).toBe('/tmp/pinned');
  });
});

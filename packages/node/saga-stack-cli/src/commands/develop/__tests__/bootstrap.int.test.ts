/**
 * `develop connect --tunnel --bootstrap` integration tests (soa#329) — the real
 * oclif command with every BaseCommand IO seam faked (connect.int.test.ts
 * harness) AND the four phase sub-commands (`stack down/up`, `snapshot
 * store/restore`) mocked at their static `run` so this suite owns exactly the
 * SEQUENCER axis: flag rejections, the fixture fast path, ledger resume/clear,
 * the foreign hard stop, the persona preflight verdicts, and the retry-once
 * prerequisite. The sub-commands' own behavior has its own suites
 * (up-native.int / snapshot.int); the prerequisite step is NOT mocked — it
 * drives the real in-process orchestrator against the fake seams.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Config } from '@oclif/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import type { SnapshotManifest } from '../../../core/snapshot/index.js';
import type { CheckpointStore, Runner, ScriptInvocation } from '../../../runtime/index.js';
import { useTempSnapshotsDir } from '../../../__tests__/helpers/env.js';
import { installCoreSeams } from '../../../__tests__/helpers/seams.js';
import type { CoreSeams } from '../../../__tests__/helpers/seams.js';
import StackDown from '../../stack/down.js';
import StackUp from '../../stack/up.js';
import SnapshotRestore from '../../stack/snapshot/restore.js';
import SnapshotStore from '../../stack/snapshot/store.js';
import DevelopConnect from '../connect.js';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const DEV_ROOT = '/fixed/dev';

let DASH_ROOT: string;
let STATE_DIR: string;
let config: Config;
let runs: ScriptInvocation[];
let barrierCalls: CoreSeams['barrierCalls'];
let posterCalls: string[];
let posterStatus: number;
let downSpy: ReturnType<typeof vi.spyOn>;
let upSpy: ReturnType<typeof vi.spyOn>;
let snapStoreSpy: ReturnType<typeof vi.spyOn>;
let snapRestoreSpy: ReturnType<typeof vi.spyOn>;

useTempSnapshotsDir('saga-connect-bootstrap-');

/** A fresh/stale tunnel-connect fixture manifest (only createdAt is consulted). */
function fixtureAgedDays(days: number): SnapshotManifest {
  return { createdAt: new Date(Date.now() - days * 86_400_000).toISOString() } as unknown as SnapshotManifest;
}

function installSeams(opts: { fixture?: SnapshotManifest | null; playwrightFail?: string } = {}): void {
  const seams = installCoreSeams({
    pidBase: 2000,
    prepFresh: false,
    ...(opts.playwrightFail !== undefined ? { playwrightFail: opts.playwrightFail } : {}),
  });
  runs = seams.runs;
  barrierCalls = seams.barrierCalls;

  const proto = BaseCommand.prototype as unknown as Record<string, () => unknown>;

  // Checkpoint store fake: `load('tunnel-connect')` answers the FAST-PATH fixture
  // (or null); every stage-checkpoint id answers null so the phase-1 prerequisite
  // falls back to the local headless replay — hermetic, no snapshot IO.
  const store: CheckpointStore = {
    load: (id: string) => (id === 'tunnel-connect' ? (opts.fixture ?? null) : null),
    bake: async () => {},
    restore: async () => {},
  };
  vi.spyOn(proto, 'getCheckpointStore').mockReturnValue(store);

  // Never spawn the vendored tunnel.sh.
  vi.spyOn(proto, 'getTunnelMoniker').mockReturnValue(async () => 'testmoniker');

  // The persona-preflight devLogin poster (soa#331). `posterStatus` scripts the verdict.
  posterCalls = [];
  posterStatus = 200;
  vi.spyOn(proto, 'getCookiePoster').mockReturnValue({
    post: async (url: string) => {
      posterCalls.push(url);
      return { status: posterStatus, ok: posterStatus === 200, setCookies: [] };
    },
  });

  // The four phase sub-commands, mocked at their static run (argv recorded).
  downSpy = vi.spyOn(StackDown, 'run').mockResolvedValue(undefined as never) as never;
  upSpy = vi.spyOn(StackUp, 'run').mockResolvedValue(undefined as never) as never;
  snapStoreSpy = vi.spyOn(SnapshotStore, 'run').mockResolvedValue(undefined as never) as never;
  snapRestoreSpy = vi.spyOn(SnapshotRestore, 'run').mockResolvedValue(undefined as never) as never;
}

function ws(): string[] {
  return ['--saga-dash', DASH_ROOT, '--soa', SOA_ROOT, '--dev', DEV_ROOT, '--state-dir', STATE_DIR];
}

function playwrightRuns(): ScriptInvocation[] {
  return runs.filter((r) => r.command === 'pnpm' && r.args.includes('playwright'));
}

/** The phase-1 journey replay spawns (terminal project stage-5-schedule). */
function journeyRuns(): ScriptInvocation[] {
  return playwrightRuns().filter((r) => r.args.includes('stage-5-schedule'));
}

/** The headed live-session spawn (the hand-off's terminal stage). */
function liveRun(): ScriptInvocation | undefined {
  return playwrightRuns().find((r) => r.args.includes('interactive-connect'));
}

function ledgerPath(): string {
  return join(STATE_DIR, 'bootstrap.json');
}

function ledgerCompleted(): string[] {
  return (JSON.parse(readFileSync(ledgerPath(), 'utf8')) as { completed: string[] }).completed;
}

/** argv of the i-th recorded call of a mocked sub-command run. */
function argvOf(spy: ReturnType<typeof vi.spyOn>, i: number): string[] {
  return spy.mock.calls[i]?.[0] as unknown as string[];
}

beforeAll(() => {
  DASH_ROOT = mkdtempSync(join(tmpdir(), 'saga-dash-bootstrap-'));
});
afterAll(() => {
  rmSync(DASH_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  STATE_DIR = mkdtempSync(join(tmpdir(), 'saga-bootstrap-state-'));
  installSeams();
  vi.spyOn(BaseCommand.prototype, 'log').mockImplementation(() => {});
  vi.spyOn(BaseCommand.prototype, 'warn').mockImplementation(((m: string) => m) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(STATE_DIR, { recursive: true, force: true });
});

describe('develop connect --bootstrap — flag rejections (FIRST, before any IO)', () => {
  async function expectRejected(argv: string[], re: RegExp): Promise<void> {
    await expect(DevelopConnect.run([...argv, ...ws()], config)).rejects.toThrow(re);
    // Rejected BEFORE any phase/bring-up work.
    expect(downSpy).not.toHaveBeenCalled();
    expect(upSpy).not.toHaveBeenCalled();
    expect(snapStoreSpy).not.toHaveBeenCalled();
    expect(playwrightRuns()).toHaveLength(0);
  }

  it('--bootstrap without --tunnel', async () => {
    await expectRejected(['--bootstrap'], /--bootstrap.*two-phase tunnel bridge.*--tunnel/is);
  });

  it('--bootstrap --tunnel --slot 2 (bootstrap-specific message, not the generic tunnel guard)', async () => {
    await expectRejected(['--bootstrap', '--tunnel', '--slot', '2'], /slot 2: --bootstrap.*peer slot/s);
  });

  it('--bootstrap --tunnel --no-prereq-from-snapshot', async () => {
    await expectRejected(
      ['--bootstrap', '--tunnel', '--no-prereq-from-snapshot'],
      /--bootstrap owns the prerequisite strategy/,
    );
  });

  it('--rebuild without --bootstrap', async () => {
    await expectRejected(['--rebuild', '--tunnel'], /--rebuild only modifies --bootstrap/);
  });

  it('--bootstrap --tunnel --refresh-snapshot', async () => {
    await expectRejected(
      ['--bootstrap', '--tunnel', '--refresh-snapshot'],
      /--bootstrap and --refresh-snapshot are mutually exclusive/,
    );
  });

  it('--set (connect is not set-aware; the central parse guard rejects)', async () => {
    await expectRejected(['--bootstrap', '--tunnel', '--set', 'foo'], /--set is not supported/);
  });
});

describe('develop connect --bootstrap — full two-phase run (no fixture)', () => {
  it('runs phase 1 + phase 2 in order, then hands off to the reuse live session', async () => {
    await DevelopConnect.run(['--tunnel', '--bootstrap', ...ws()], config);

    // Phase sub-commands: down×2, up×2 (local then tunnel), store, restore.
    expect(downSpy).toHaveBeenCalledTimes(2);
    expect(upSpy).toHaveBeenCalledTimes(2);
    const upLocal = argvOf(upSpy, 0);
    expect(upLocal).toEqual(expect.arrayContaining(['--seed', 'full', '--reset']));
    expect(upLocal).not.toContain('--tunnel');
    const upTunnel = argvOf(upSpy, 1);
    expect(upTunnel).toEqual(expect.arrayContaining(['--tunnel', '--reset', '--forbid-foreign']));
    expect(argvOf(snapStoreSpy, 0)).toEqual(
      expect.arrayContaining(['--fixture-id', 'tunnel-connect', '--force']),
    );
    expect(argvOf(snapRestoreSpy, 0)[0]).toBe('tunnel-connect');

    // Workspace forwarding: the sub-commands resolve the SAME checkouts + state dir.
    for (const argv of [upLocal, upTunnel, argvOf(downSpy, 0), argvOf(snapStoreSpy, 0), argvOf(snapRestoreSpy, 0)]) {
      expect(argv).toEqual(expect.arrayContaining(['--saga-dash', DASH_ROOT, '--state-dir', STATE_DIR]));
    }

    // Order: local-down → local-up → snapshot-store → tunnel-down → tunnel-up → restore.
    const order = [
      downSpy.mock.invocationCallOrder[0],
      upSpy.mock.invocationCallOrder[0],
      snapStoreSpy.mock.invocationCallOrder[0],
      downSpy.mock.invocationCallOrder[1],
      upSpy.mock.invocationCallOrder[1],
      snapRestoreSpy.mock.invocationCallOrder[0],
    ];
    expect([...order].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(order);

    // The prerequisite ran LOCALLY (localhost iam, never the tunnel host) exactly once.
    const journeys = journeyRuns();
    expect(journeys).toHaveLength(1);
    expect(journeys[0]?.env?.PLAYWRIGHT_IAM_URL).toBe('http://localhost:3010');

    // Settle barrier gated the snapshot (soa#327): one call, the journey personas.
    expect(barrierCalls).toHaveLength(1);
    expect(barrierCalls[0]).toMatchObject({
      fixtureId: 'tunnel-connect',
      stageId: 'schedule',
      personas: ['alex.tutor@example.org'],
    });

    // Persona preflight probed devLogin over the TUNNEL iam host (soa#331).
    expect(posterCalls).toHaveLength(1);
    expect(posterCalls[0]).toMatch(/^https:\/\/iam\.testmoniker\./);

    // Success clears the ledger.
    expect(existsSync(ledgerPath())).toBe(false);

    // Hand-off: the headed room drives the tunnel hosts, with NO second journey
    // replay (--bootstrap implies --reuse — the restored fixture must survive).
    expect(liveRun()?.env?.PLAYWRIGHT_BASE_URL).toMatch(/^https:\/\/dash\.testmoniker\./);
    expect(journeyRuns()).toHaveLength(1);
  });
});

describe('develop connect --bootstrap — fixture fast path', () => {
  it('a fresh (<7d) tunnel-connect fixture skips phase 1 entirely', async () => {
    vi.restoreAllMocks();
    installSeams({ fixture: fixtureAgedDays(1) });
    vi.spyOn(BaseCommand.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(BaseCommand.prototype, 'warn').mockImplementation(((m: string) => m) as never);

    await DevelopConnect.run(['--tunnel', '--bootstrap', ...ws()], config);

    // Only the tunnel phase: one down, one (tunnel) up, NO store, restore still runs.
    expect(downSpy).toHaveBeenCalledTimes(1);
    expect(upSpy).toHaveBeenCalledTimes(1);
    expect(argvOf(upSpy, 0)).toEqual(expect.arrayContaining(['--tunnel', '--forbid-foreign']));
    expect(snapStoreSpy).not.toHaveBeenCalled();
    expect(snapRestoreSpy).toHaveBeenCalledTimes(1);
    // No local rebuild: no journey replay, no settle barrier.
    expect(journeyRuns()).toHaveLength(0);
    expect(barrierCalls).toHaveLength(0);
    expect(liveRun()).toBeDefined();
  });

  it('--rebuild forces the full phase-1 rebuild past a fresh fixture', async () => {
    vi.restoreAllMocks();
    installSeams({ fixture: fixtureAgedDays(1) });
    vi.spyOn(BaseCommand.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(BaseCommand.prototype, 'warn').mockImplementation(((m: string) => m) as never);

    await DevelopConnect.run(['--tunnel', '--bootstrap', '--rebuild', ...ws()], config);

    expect(upSpy).toHaveBeenCalledTimes(2);
    expect(snapStoreSpy).toHaveBeenCalledTimes(1);
    expect(journeyRuns()).toHaveLength(1);
  });

  it('a stale (>7d) fixture does NOT take the fast path', async () => {
    vi.restoreAllMocks();
    installSeams({ fixture: fixtureAgedDays(8) });
    vi.spyOn(BaseCommand.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(BaseCommand.prototype, 'warn').mockImplementation(((m: string) => m) as never);

    await DevelopConnect.run(['--tunnel', '--bootstrap', ...ws()], config);

    expect(upSpy).toHaveBeenCalledTimes(2);
    expect(snapStoreSpy).toHaveBeenCalledTimes(1);
  });
});

describe('develop connect --bootstrap — ledger: failure stops, re-run resumes, success clears', () => {
  it('a failed step keeps the ledger + prints the resume command; the re-run resumes AT that step', async () => {
    (snapStoreSpy as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      new Error('pg_dump exploded'),
    );

    await expect(DevelopConnect.run(['--tunnel', '--bootstrap', ...ws()], config)).rejects.toThrow(
      /bootstrap FAILED at step 'snapshot-store'[\s\S]*pg_dump exploded[\s\S]*ss develop connect --tunnel --bootstrap/,
    );

    // Everything BEFORE the failed step is recorded; nothing was torn down and
    // phase 2 never started.
    expect(ledgerCompleted()).toEqual(['local-down', 'local-up', 'prerequisite', 'settle']);
    expect(downSpy).toHaveBeenCalledTimes(1);
    expect(snapRestoreSpy).not.toHaveBeenCalled();

    // ── RE-RUN: resumes at snapshot-store; phase-1 down/up/prerequisite are SKIPPED. ──
    downSpy.mockClear();
    upSpy.mockClear();
    snapStoreSpy.mockClear();
    snapRestoreSpy.mockClear();
    const journeysBefore = journeyRuns().length;

    await DevelopConnect.run(['--tunnel', '--bootstrap', ...ws()], config);

    expect(snapStoreSpy).toHaveBeenCalledTimes(1); // the failed step re-ran
    expect(upSpy).toHaveBeenCalledTimes(1); // ONLY the tunnel up — local-up was skipped
    expect(argvOf(upSpy, 0)).toContain('--tunnel');
    expect(downSpy).toHaveBeenCalledTimes(1); // only tunnel-down
    expect(journeyRuns().length).toBe(journeysBefore); // prerequisite NOT replayed
    expect(existsSync(ledgerPath())).toBe(false); // success clears
    expect(liveRun()).toBeDefined();
  });

  it('phase-2 ids from a failed FAST-PATH run do NOT skip tunnel-down/tunnel-up in a --rebuild re-run', async () => {
    // Run 1: fresh fixture ⇒ fast path (phase 2 only); restore fails, leaving
    // 'tunnel-down'/'tunnel-up' in the ledger. Run 2 (--rebuild) executes
    // phase 1 (localhost env) UNDER those recorded completions — honoring them
    // would bypass the --forbid-foreign hard stop and declare the bridge up on
    // a localhost-mode stack.
    vi.restoreAllMocks();
    installSeams({ fixture: fixtureAgedDays(1) });
    vi.spyOn(BaseCommand.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(BaseCommand.prototype, 'warn').mockImplementation(((m: string) => m) as never);

    (snapRestoreSpy as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      new Error('fixture torn'),
    );
    await expect(DevelopConnect.run(['--tunnel', '--bootstrap', ...ws()], config)).rejects.toThrow(
      /bootstrap FAILED at step 'snapshot-restore'/,
    );
    expect(ledgerCompleted()).toEqual(['tunnel-down', 'tunnel-up']);

    // ── Run 2: the natural remediation `--bootstrap --rebuild`. ──
    downSpy.mockClear();
    upSpy.mockClear();
    snapStoreSpy.mockClear();
    snapRestoreSpy.mockClear();

    await DevelopConnect.run(['--tunnel', '--bootstrap', '--rebuild', ...ws()], config);

    // BOTH phases ran: local down/up AND tunnel down/up (with the hard stop).
    expect(downSpy).toHaveBeenCalledTimes(2);
    expect(upSpy).toHaveBeenCalledTimes(2);
    expect(argvOf(upSpy, 0)).toEqual(expect.arrayContaining(['--seed', 'full', '--reset']));
    expect(argvOf(upSpy, 0)).not.toContain('--tunnel');
    expect(argvOf(upSpy, 1)).toEqual(expect.arrayContaining(['--tunnel', '--reset', '--forbid-foreign']));
    expect(snapStoreSpy).toHaveBeenCalledTimes(1);
    expect(snapRestoreSpy).toHaveBeenCalledTimes(1);
    expect(existsSync(ledgerPath())).toBe(false);
    expect(liveRun()).toBeDefined();
  });

  it('a failed --rebuild prints a resume command carrying --rebuild + pins; even a bare re-run resumes the rebuild', async () => {
    // Run 1: fresh-but-bad fixture ⇒ --rebuild; the journey replay fails both
    // attempts, stopping phase 1 at 'prerequisite'. Without the run-shaped
    // resume command AND the in-flight-ledger fast-path override, the re-run
    // would fast-path (fixture still fresh), restore the OLD fixture the user
    // asked to replace, and clear the ledger as "success".
    vi.restoreAllMocks();
    installSeams({ fixture: fixtureAgedDays(1), playwrightFail: 'stage-5-schedule' });
    vi.spyOn(BaseCommand.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(BaseCommand.prototype, 'warn').mockImplementation(((m: string) => m) as never);

    const err = await DevelopConnect.run(['--tunnel', '--bootstrap', '--rebuild', ...ws()], config).catch(
      (e: Error) => e,
    );
    expect((err as Error).message).toMatch(/bootstrap FAILED at step 'prerequisite'/);
    expect((err as Error).message).toContain('ss develop connect --tunnel --bootstrap --rebuild');
    expect((err as Error).message).toContain(`--state-dir ${STATE_DIR}`);
    expect(ledgerCompleted()).toEqual(['local-down', 'local-up']);

    // ── Run 2: the BARE command (shell-history hazard). Must resume phase 1. ──
    vi.restoreAllMocks();
    installSeams({ fixture: fixtureAgedDays(1) }); // journeys green now
    vi.spyOn(BaseCommand.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(BaseCommand.prototype, 'warn').mockImplementation(((m: string) => m) as never);

    await DevelopConnect.run(['--tunnel', '--bootstrap', ...ws()], config);

    expect(journeyRuns()).toHaveLength(1); // prerequisite resumed (fresh runs array)
    expect(snapStoreSpy).toHaveBeenCalledTimes(1); // the rebuild's NEW fixture stored
    expect(upSpy).toHaveBeenCalledTimes(1); // local-up skipped via ledger; only tunnel up ran
    expect(argvOf(upSpy, 0)).toContain('--tunnel');
    expect(existsSync(ledgerPath())).toBe(false);
    expect(liveRun()).toBeDefined();
  });
});

describe('develop connect --bootstrap — phase-2 foreign hard stop', () => {
  it('an up --forbid-foreign abort stops the bridge before the restore, ledger kept', async () => {
    (upSpy as unknown as { mockImplementation: (fn: (argv: string[]) => Promise<void>) => void }).mockImplementation(
      async (argv: string[]) => {
        if (argv.includes('--forbid-foreign')) {
          throw new Error(
            '--forbid-foreign: adopted 1 process(es) NOT launched by this CLI (already up, no pidfile — env unverifiable):\n  ✗ programs-api (port 4011)',
          );
        }
      },
    );

    await expect(DevelopConnect.run(['--tunnel', '--bootstrap', ...ws()], config)).rejects.toThrow(
      /bootstrap FAILED at step 'tunnel-up'[\s\S]*NOT launched by this CLI/,
    );

    // Aborted BEFORE the restore/preflight; the ledger records through tunnel-down.
    expect(snapRestoreSpy).not.toHaveBeenCalled();
    expect(posterCalls).toHaveLength(0);
    expect(ledgerCompleted()).toEqual([
      'local-down',
      'local-up',
      'prerequisite',
      'settle',
      'snapshot-store',
      'tunnel-down',
    ]);
  });
});

describe('develop connect --bootstrap — persona preflight verdicts (soa#331)', () => {
  it('devLogin 401 after the restore fails the bridge as a TORN checkpoint, ledger kept', async () => {
    posterStatus = 401;

    await expect(DevelopConnect.run(['--tunnel', '--bootstrap', ...ws()], config)).rejects.toThrow(
      /bootstrap FAILED at step 'persona-preflight'[\s\S]*TORN/,
    );

    // The restore itself completed; only the preflight is outstanding.
    expect(ledgerCompleted()).toContain('snapshot-restore');
    expect(ledgerCompleted()).not.toContain('persona-preflight');
    // The room never opened.
    expect(liveRun()).toBeUndefined();
  });
});

describe('develop connect --bootstrap — prerequisite retry-once (stage-flake class)', () => {
  function failJourneyTimes(n: number): void {
    // Wrap the battery runner: the first `n` journey spawns exit 1, later ones 0.
    const proto = BaseCommand.prototype as unknown as { getRunner: () => Runner };
    const base = proto.getRunner();
    let left = n;
    vi.spyOn(proto as unknown as Record<string, () => unknown>, 'getRunner').mockReturnValue({
      run: async (spec: ScriptInvocation) => {
        const res = await base.run(spec);
        if (left > 0 && spec.args.includes('playwright') && spec.args.includes('stage-5-schedule')) {
          left -= 1;
          return { code: 1 };
        }
        return res;
      },
    } satisfies Runner);
  }

  it('one failed journey replay is retried once and the bridge completes', async () => {
    failJourneyTimes(1);

    await DevelopConnect.run(['--tunnel', '--bootstrap', ...ws()], config);

    expect(journeyRuns()).toHaveLength(2); // fail + green retry
    expect(existsSync(ledgerPath())).toBe(false);
    expect(liveRun()).toBeDefined();
  });

  it('a second failure is NOT a flake: the step fails after exactly one retry', async () => {
    failJourneyTimes(99);

    await expect(DevelopConnect.run(['--tunnel', '--bootstrap', ...ws()], config)).rejects.toThrow(
      /bootstrap FAILED at step 'prerequisite'/,
    );

    expect(journeyRuns()).toHaveLength(2); // one retry, then stop — never a loop
    expect(ledgerCompleted()).toEqual(['local-down', 'local-up']);
    expect(snapStoreSpy).not.toHaveBeenCalled();
  });
});

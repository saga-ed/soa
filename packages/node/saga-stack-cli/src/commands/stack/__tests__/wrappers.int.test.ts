/**
 * Wrapper command integration tests — the M1 process seam (plan §7.2).
 *
 * These drive the REAL oclif commands end-to-end (parse argv → flag-map →
 * `runScript` → Runner), but REPLACE the injectable Runner with a fake that
 * records the `ScriptInvocation` and returns a canned exit code. NOTHING is
 * spawned: up.sh / verify.sh / docker / pnpm are never executed.
 *
 * The seam is `BaseCommand.prototype.getRunner` (see base-command.ts) — we spy
 * it on the prototype so every command instance gets the fake. We then assert
 * the command handed the Runner the EXACT spec: cwd = the synthetic-dev dir,
 * command = the absolute up.sh/verify.sh path, the parity argv from the
 * flag-map, and the env (repo-path overrides UNDER the subcommand's own env).
 *
 * Path resolution is deterministic: every invocation passes `--soa <real soa>`
 * and `--dev <fixed>` so `resolveScript` finds the real (READ-ONLY, never run)
 * up.sh/verify.sh and the asserted DEV/SOA env is stable regardless of the
 * ambient `$DEV`/`$HOME` in the test environment. The soa root is derived from
 * this package's location (…/soa/packages/node/saga-stack-cli) so the test is
 * not tied to any one developer's checkout path.
 */

import { resolve } from 'node:path';
import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import { foreignCheckTargets } from '../../../core/foreign-procs.js';
import { manifest } from '../../../core/manifest/index.js';
import type {
  FindForeignOptions,
  ForeignProc,
  ReapedProc,
  RunResult,
  ScriptInvocation,
  StopServiceResult,
} from '../../../runtime/index.js';
import StackUp from '../up.js';
import StackDown from '../down.js';
import StackOverlay from '../overlay.js';
import StackTunnel from '../tunnel.js';

// Package root = vitest cwd; soa root is three dirs up (packages/node/<pkg>).
const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const SYNTH_DIR = resolve(SOA_ROOT, 'tools', 'synthetic-dev');
const UP_SH = resolve(SYNTH_DIR, 'up.sh'); // up.sh is STILL wrapped (Phase 2 owns --sandbox/--workspace/--record).
// Phase 1 DECOUPLING (saga-ed/soa#214): tunnel.sh + refresh-suite.sh are now the CLI's
// VENDORED copies under <pkg>/vendor, NOT soa's tools/synthetic-dev.
const VENDOR_DIR = resolve(PKG_ROOT, 'vendor');
const REFRESH_SH = resolve(VENDOR_DIR, 'refresh-suite.sh');
const TUNNEL_SH = resolve(VENDOR_DIR, 'tunnel.sh');
const DEV_ROOT = '/fixed/dev';

let config: Config;
let calls: ScriptInvocation[];
let cannedCode: number;

/** Install the fake Runner on the BaseCommand prototype; record every spec. */
function installFakeRunner(code = 0): void {
  cannedCode = code;
  calls = [];
  vi.spyOn(BaseCommand.prototype as unknown as { getRunner: () => unknown }, 'getRunner').mockReturnValue(
    {
      async run(spec: ScriptInvocation): Promise<RunResult> {
        calls.push(spec);
        return { code: cannedCode };
      },
    },
  );
}

/**
 * Install a fake native service-stopper on the BaseCommand prototype (M7 Phase 3).
 * Records the state dir each `down --slot N` drives it against and returns a canned
 * teardown result — so NO real process/fs is touched.
 */
function installFakeStopper(result: StopServiceResult[]): { stopCalls: string[] } {
  const stopCalls: string[] = [];
  vi.spyOn(
    BaseCommand.prototype as unknown as { getServiceStopper: () => unknown },
    'getServiceStopper',
  ).mockReturnValue(async (stateDir: string) => {
    stopCalls.push(stateDir);
    return result;
  });
  return { stopCalls };
}

/**
 * Install a fake post-down foreign-process reap (saga-ed/soa#249, soa#361) on the
 * BaseCommand prototype: `find` records each call's options (the resolved band is
 * `foreignCheckTargets(manifest, opts.services, opts.portOverrides)`) and returns the
 * canned survivors; `reap` records what it was asked to kill and reports each
 * `killed` per the predicate. No real `lsof`/`ss`/`ps`/kill ever runs under test.
 */
function installFakeForeignProcs(
  survivors: ForeignProc[],
  killed: (f: ForeignProc) => boolean = () => true,
): { findOpts: FindForeignOptions[]; reapCalls: ForeignProc[][] } {
  const findOpts: FindForeignOptions[] = [];
  const reapCalls: ForeignProc[][] = [];
  vi.spyOn(
    BaseCommand.prototype as unknown as { getForeignProcs: () => unknown },
    'getForeignProcs',
  ).mockReturnValue({
    async find(opts: FindForeignOptions): Promise<ForeignProc[]> {
      findOpts.push(opts);
      return survivors;
    },
    async reap(foreign: ForeignProc[]): Promise<ReapedProc[]> {
      reapCalls.push(foreign);
      return foreign.map((f) => ({ ...f, killed: killed(f) }));
    },
  });
  return { findOpts, reapCalls };
}

/** The resolved port band a recorded `find` scanned (services × slot port overrides). */
function bandOf(opts: FindForeignOptions): number[] {
  return foreignCheckTargets(manifest, opts.services, opts.portOverrides).map((t) => t.port);
}

/** Capture (and suppress) every `this.log` line — the audit warnings assert on these. */
function captureLog(): string[] {
  const out: string[] = [];
  vi.spyOn(
    BaseCommand.prototype as unknown as { log: (msg?: string) => void },
    'log',
  ).mockImplementation((msg?: string) => {
    out.push(String(msg ?? ''));
  });
  return out;
}

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  installFakeRunner(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The workspace flags every case shares for deterministic path/env resolution. */
const WS = ['--soa', SOA_ROOT, '--dev', DEV_ROOT];

describe('stack up — FULLY NATIVE (Phase 2: --sandbox/--tunnel/--record/--workspace no longer wrap up.sh)', () => {
  it('--dry-run does NOT invoke the Runner (planner-only path)', async () => {
    await StackUp.run(['--dry-run', '--only', 'scheduling-api,sessions-api', ...WS], config);
    expect(calls).toHaveLength(0);
  });

  // Phase 2 (saga-ed/soa#214): --sandbox/--tunnel/--record/--workspace are all NATIVE now —
  // the `up` command has NO up.sh wrapper (`needsUpSh`/`runWrapped`/`flagMap.up` removed).
  // The native bring-up assertions (sandbox_env / tunnel_env overlays, the record plan,
  // the workspace parse) live in up-native.int.test.ts, which fakes EVERY native seam.
  // This file only mocks getRunner, so it can only prove the NEGATIVE here: a
  // guard-rejected invocation never reaches (and never shells) up.sh.
  it('--sandbox without --only/--with hard-errors (never shells up.sh)', async () => {
    await expect(StackUp.run(['--sandbox', 'demo', ...WS], config)).rejects.toMatchObject({
      message: expect.stringContaining('--sandbox <name> requires --only'),
    });
    expect(calls.some((c) => c.command === UP_SH)).toBe(false);
  });

  it('--tunnel at slot > 0 hard-errors (fixed slot-0 browser ports; never shells up.sh)', async () => {
    await expect(StackUp.run(['--tunnel', '--slot', '1', ...WS], config)).rejects.toMatchObject({
      message: expect.stringContaining('--tunnel fronts the FIXED slot-0 browser ports'),
    });
    expect(calls.some((c) => c.command === UP_SH)).toBe(false);
  });

  it('--workspace + --only hard-errors (mutually exclusive; never shells up.sh)', async () => {
    await expect(
      StackUp.run(['--workspace', '/tmp/ws.json', '--only', 'iam-api', ...WS], config),
    ).rejects.toMatchObject({ message: expect.stringContaining('--workspace cannot be combined') });
    expect(calls.some((c) => c.command === UP_SH)).toBe(false);
  });
});

describe('stack down — native slot-safe teardown at every slot (no up.sh)', () => {
  const INFRA_DIR = resolve(SOA_ROOT, 'infra');

  // Every down run performs the post-down orphan reap (saga-ed/soa#249, soa#361);
  // fake it CLEAN by default so no real `lsof`/`ss`/`ps`/kill runs. The survivor
  // cases below re-spy with canned foreign procs (re-vi.spyOn replaces cleanly).
  beforeEach(() => {
    installFakeForeignProcs([]);
  });

  it('slot 0 (bare) stops services NATIVELY against /tmp/sds-synthetic (never up.sh)', async () => {
    const { stopCalls } = installFakeStopper([{ id: 'iam-api', pid: 200, outcome: 'term' }]);

    await StackDown.run([...WS], config);

    // no up.sh service-stop — the native kill-by-pidfile replaces the old up.sh --down.
    expect(calls.some((c) => c.command.endsWith('up.sh'))).toBe(false);
    // no mesh teardown without --mesh.
    expect(calls).toHaveLength(0);
    // native stopper driven against slot 0's state dir.
    expect(stopCalls).toEqual(['/tmp/sds-synthetic']);
  });

  it('slot 0 --mesh: native service-stop THEN make down for the default project (no up.sh)', async () => {
    const { stopCalls } = installFakeStopper([{ id: 'iam-api', pid: 200, outcome: 'term' }]);

    await StackDown.run(['--mesh', ...WS], config);

    // never up.sh.
    expect(calls.some((c) => c.command.endsWith('up.sh'))).toBe(false);
    expect(stopCalls).toEqual(['/tmp/sds-synthetic']);
    // exactly one Runner call: make down for the DEFAULT project (no COMPOSE_PROJECT_NAME).
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('make');
    expect(calls[0].cwd).toBe(INFRA_DIR);
    expect(calls[0].args).toEqual(['down', 'PROJECT=saga-mesh']);
    expect(calls[0].env).toEqual({});
  });

  it('slot > 0 stops the slot NATIVELY against its state dir (never up.sh)', async () => {
    const { stopCalls } = installFakeStopper([
      { id: 'iam-api', pid: 200, outcome: 'term' },
      { id: 'rtsm-api', pid: 201, outcome: 'kill' },
    ]);

    await StackDown.run(['--slot', '1', ...WS], config);

    // no up.sh service-stop at all — its pkill/slot-0 STATE would kill slot 0.
    expect(calls.some((c) => c.command.endsWith('up.sh'))).toBe(false);
    // no mesh teardown without --mesh.
    expect(calls).toHaveLength(0);
    // the native stopper was driven against THIS slot's state dir (Phase 3).
    expect(stopCalls).toEqual(['/tmp/sds-synthetic-s1']);
  });

  it('slot > 0 honours --state-dir (mirrors `up`) — stops against the custom dir, not the slot default', async () => {
    const { stopCalls } = installFakeStopper([{ id: 'iam-api', pid: 200, outcome: 'term' }]);

    // `up --slot 1 --state-dir /custom` records pids under /custom; `down` MUST
    // enumerate /custom too or it leaks every slot-1 server.
    await StackDown.run(['--slot', '1', '--state-dir', '/custom', ...WS], config);

    expect(calls).toHaveLength(0); // still native — never up.sh.
    expect(stopCalls).toEqual(['/custom']); // NOT /tmp/sds-synthetic-s1.
  });

  it('slot > 0 tolerates stale/absent pidfiles (nothing running)', async () => {
    const { stopCalls } = installFakeStopper([]); // no pidfiles under the slot dir

    await StackDown.run(['--slot', '2', ...WS], config);

    expect(calls).toHaveLength(0);
    expect(stopCalls).toEqual(['/tmp/sds-synthetic-s2']);
  });

  it('slot > 0 --mesh: native service-stop THEN the slot-project mesh teardown (no up.sh)', async () => {
    const { stopCalls } = installFakeStopper([{ id: 'iam-api', pid: 200, outcome: 'term' }]);

    await StackDown.run(['--slot', '1', '--mesh', ...WS], config);

    // never the host-global up.sh --down.
    expect(calls.some((c) => c.command.endsWith('up.sh'))).toBe(false);
    // native stop ran against the slot's state dir first.
    expect(stopCalls).toEqual(['/tmp/sds-synthetic-s1']);
    // exactly one Runner call: make down for THIS slot's project.
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('make');
    expect(calls[0].cwd).toBe(INFRA_DIR);
    expect(calls[0].args).toEqual(['down', 'COMPOSE_PROJECT_NAME=soa-s1', 'PROJECT=saga-mesh']);
    expect(calls[0].env).toEqual({ COMPOSE_PROJECT_NAME: 'soa-s1' });
  });

  // ── post-down orphan REAP (saga-ed/soa#249, soa#361) ──

  it('post-down REAPS survivors on the slot band by live pgid (not just warns)', async () => {
    installFakeStopper([{ id: 'programs-api', pid: 200, outcome: 'term' }]);
    const foreign: ForeignProc[] = [
      // the issue's exact scenario: a vite/tsup watch child that outlived its leader.
      { id: 'programs-api', port: 4006, pid: 873122, pgid: 873100, command: 'node vite.js dev' },
      { id: 'iam-api', port: 4010, pid: 873200, pgid: 873150, command: 'node dist/main.js' },
    ];
    const { findOpts, reapCalls } = installFakeForeignProcs(foreign);
    const out = captureLog();

    await StackDown.run(['--slot', '1', ...WS], config);

    // The scanned band is slot 1's RESOLVED service ports (base + 1000) for every
    // service the slot could launch: programs-api 3006→4006, iam-api 3010→4010,
    // connect-api 6106→7106 AND connect-web 6210→7210 — all slottable as of soa#271.
    // (Only the literal-port playback trio stays out of the slot band.)
    expect(findOpts).toHaveLength(1);
    expect(bandOf(findOpts[0])).toEqual(expect.arrayContaining([4006, 4010, 7106, 7210]));
    expect(findOpts[0].stateDir).toBe('/tmp/sds-synthetic-s1');

    // The whole point of soa#361: the survivors are REAPED, not merely reported.
    expect(reapCalls).toEqual([foreign]);

    const warnings = out.filter((l) => l.startsWith('⚠'));
    expect(warnings[0]).toContain("2 orphan(s) still held slot 1's service ports");
    expect(out.some((l) => l.includes('programs-api :4006 pid 873122 (pgid 873100)'))).toBe(true);
    expect(out.some((l) => l.startsWith('✓ reaped 2 orphan(s)'))).toBe(true);
  });

  it('post-down reap reports a survivor it could NOT kill (permission / already gone)', async () => {
    installFakeStopper([{ id: 'programs-api', pid: 200, outcome: 'term' }]);
    const foreign: ForeignProc[] = [
      { id: 'programs-api', port: 4006, pid: 873122, pgid: 873100, command: 'node' },
    ];
    installFakeForeignProcs(foreign, () => false); // kill does not confirm
    const out = captureLog();

    await StackDown.run(['--slot', '1', ...WS], config);

    expect(out.some((l) => l.includes('4006') && l.includes('STILL ALIVE'))).toBe(true);
    expect(out.some((l) => l.startsWith('⚠ 1 orphan(s) could not be killed'))).toBe(true);
    expect(out.some((l) => l.startsWith('✓ reaped'))).toBe(false);
  });

  it('post-down reap is SILENT when the band is clean (slot 0 scans base ports)', async () => {
    installFakeStopper([{ id: 'iam-api', pid: 200, outcome: 'term' }]);
    const { findOpts, reapCalls } = installFakeForeignProcs([]);
    const out = captureLog();

    await StackDown.run([...WS], config);

    // The scan RAN — against slot 0's base ports (offset 0; nothing excluded at slot 0)…
    expect(findOpts).toHaveLength(1);
    expect(bandOf(findOpts[0])).toEqual(expect.arrayContaining([3006, 6106]));
    // …found nothing, so reap was never called and no lines were emitted.
    expect(reapCalls).toEqual([]);
    expect(out.some((l) => l.startsWith('⚠') || l.startsWith('✓ reaped'))).toBe(false);
  });
});

// NOTE: `stack seed` and `stack reset` are NO LONGER shell-out wrappers — they are
// fully NATIVE (FLIP 2 / M8 R4). Their coverage lives in seed-native.int.test.ts and
// stack-api.unit.test.ts respectively.

// NOTE: `stack status` and `stack verify` are NO LONGER shell-out wrappers — M2
// re-implemented them natively (manifest-derived health probes via the injectable
// HealthProber). Their tests moved to `status-verify.int.test.ts`, which mocks
// `getProber` instead of `getRunner`. (verify --full still delegates to verify.sh
// and is covered there.)

// NOTE (M10): `overlay apply|list|reset` are NO LONGER shell-out wrappers — the git
// engine is native (see overlay-native.int.test.ts, which mocks the git/gh/overlay-fs
// seams). `compose-rest` (the cloud orchestrator, sole implementation) remains a
// ScriptPlan wrapper over refresh-suite.sh — the still-wrapped cases live here.
describe('stack overlay compose-rest — still wraps refresh-suite.sh (sole implementation)', () => {
  it('rejects apply with positional repos but no --prs (would silently drop them)', async () => {
    await expect(
      StackOverlay.run(['apply', 'saga-dash', ...WS], config),
    ).rejects.toMatchObject({ message: expect.stringContaining('ignores positional repos unless --prs') });
    expect(calls).toHaveLength(0);
  });

  it('compose-rest <name> → --compose-rest <name>; knobs become env', async () => {
    await StackOverlay.run(
      ['compose-rest', 'dev', '--ttl-hours', '6', '--seed-profile', 'canonical', ...WS],
      config,
    );
    expect(calls[0].command).toBe(REFRESH_SH);
    // decoupled: the VENDORED refresh-suite.sh, NOT soa's tools/synthetic-dev copy.
    expect(calls[0].command).not.toContain('tools/synthetic-dev');
    expect(calls[0].command).toContain('vendor');
    expect(calls[0].cwd).toBe(VENDOR_DIR);
    expect(calls[0].args).toEqual(['--compose-rest', 'dev']);
    expect(calls[0].env).toEqual({
      DEV: DEV_ROOT,
      SOA: SOA_ROOT,
      SANDBOX_TTL_HOURS: '6',
      SANDBOX_SEED_PROFILE: 'canonical',
      // B1: the VENDORED refresh-suite.sh has no pin manifest next to it, so the CLI
      // points it at the dev's REAL soa pin file (the same one apply/list/reset read)
      // — else PINS is empty and compose-rest composes every managed repo.
      OVERLAY_FILE: resolve(SYNTH_DIR, 'integration-suite.local.tsv'),
      OVERLAY_EXAMPLE_FILE: resolve(SYNTH_DIR, 'integration-suite.example.tsv'),
    });
  });

  it('preserves compose-rest exit 2 ("spec printed, composed nothing") via exit-code propagation', async () => {
    installFakeRunner(2);
    await expect(StackOverlay.run(['compose-rest', 'dev', ...WS], config)).rejects.toMatchObject({
      oclif: { exit: 2 },
    });
    expect(calls).toHaveLength(1);
  });

  it('rejects compose-rest with no sandbox name (before spawning)', async () => {
    await expect(StackOverlay.run(['compose-rest', ...WS], config)).rejects.toMatchObject({
      message: expect.stringContaining('exactly one sandbox name'),
    });
    expect(calls).toHaveLength(0);
  });
});

describe('stack tunnel — runs the VENDORED tunnel.sh (Phase 1 decoupling)', () => {
  it('up → vendor/tunnel.sh up (cwd = the vendor dir, NOT tools/synthetic-dev)', async () => {
    await StackTunnel.run(['up', ...WS], config);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      cwd: VENDOR_DIR,
      command: TUNNEL_SH,
      args: ['up'],
      env: { DEV: DEV_ROOT, SOA: SOA_ROOT },
      stdio: 'inherit',
    });
    // decoupled: it is NOT soa's tools/synthetic-dev/tunnel.sh.
    expect(calls[0].command).not.toContain('tools/synthetic-dev');
    expect(calls[0].command).toContain('vendor');
  });

  it('moniker is the dispatch VERB (never a flag value); --vms-base → env VMS_BASE', async () => {
    await StackTunnel.run(['moniker', '--vms-base', 'vms.example.com', ...WS], config);
    expect(calls[0].command).toBe(TUNNEL_SH);
    expect(calls[0].args).toEqual(['moniker']);
    expect(calls[0].env).toEqual({
      DEV: DEV_ROOT,
      SOA: SOA_ROOT,
      VMS_BASE: 'vms.example.com',
    });
  });
});

// NOTE: `stack bootstrap` is NATIVE-BY-DEFAULT (ensure-repos → overlay → up → verify)
// with no shell-out wrapper remaining. Its coverage lives in bootstrap-native.int.test.ts.

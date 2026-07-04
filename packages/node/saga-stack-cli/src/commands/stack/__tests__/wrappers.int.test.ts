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
import type { RunResult, ScriptInvocation, StopServiceResult } from '../../../runtime/index.js';
import StackUp from '../up.js';
import StackDown from '../down.js';
import StackSeed from '../seed.js';
import StackReset from '../reset.js';
import StackOverlay from '../overlay.js';
import StackTunnel from '../tunnel.js';
import StackBootstrap from '../bootstrap.js';

// Package root = vitest cwd; soa root is three dirs up (packages/node/<pkg>).
const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const SYNTH_DIR = resolve(SOA_ROOT, 'tools', 'synthetic-dev');
const UP_SH = resolve(SYNTH_DIR, 'up.sh');
const REFRESH_SH = resolve(SYNTH_DIR, 'refresh-suite.sh');
const TUNNEL_SH = resolve(SYNTH_DIR, 'tunnel.sh');
const BOOTSTRAP_SH = resolve(SYNTH_DIR, 'bootstrap.sh');
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

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  installFakeRunner(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The workspace flags every case shares for deterministic path/env resolution. */
const WS = ['--soa', SOA_ROOT, '--dev', DEV_ROOT];

describe('stack up --legacy — the up.sh escape (FLIP 1: bare up is native-by-default)', () => {
  it('maps flags to the exact up.sh ScriptInvocation and never spawns', async () => {
    // FLIP 1: bare `stack up` now goes native; `--legacy` is the up.sh escape whose
    // flag→argv mapping this pins.
    await StackUp.run(['--legacy', '--reset', '--seed', 'roster', '--login', ...WS], config);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      cwd: SYNTH_DIR,
      command: UP_SH,
      args: ['up', '--reset', '--seed', 'roster', '--login'],
      env: { DEV: DEV_ROOT, SOA: SOA_ROOT },
      stdio: 'inherit',
    });
  });

  it('--no-auto-pull / --skip-prep still map to env under --legacy (M9: native by default, but the wrapper mapping is intact)', async () => {
    // M9: a BARE `--no-auto-pull` / `--skip-prep` now runs NATIVELY (they select the
    // auto-pull mode / skip R1). The flag→env mapping is preserved for `--legacy`.
    await StackUp.run(['--legacy', '--no-auto-pull', '--skip-prep', ...WS], config);

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['up']);
    expect(calls[0].env).toEqual({
      DEV: DEV_ROOT,
      SOA: SOA_ROOT,
      NO_AUTO_PULL: '1',
      SKIP_PREP: '1',
    });
  });

  it('per-repo overrides (--rostering / --program-hub) become up.sh repo env vars', async () => {
    await StackUp.run(
      ['--legacy', '--rostering', '/x/rostering', '--program-hub', '/y/ph', ...WS],
      config,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].env).toEqual({
      DEV: DEV_ROOT,
      SOA: SOA_ROOT,
      ROSTERING: '/x/rostering',
      PROGRAM_HUB: '/y/ph',
    });
  });

  it('--dry-run does NOT invoke the Runner (planner-only path)', async () => {
    await StackUp.run(['--dry-run', '--only', 'scheduling-api,sessions-api', ...WS], config);
    expect(calls).toHaveLength(0);
  });

  // M4: a comma-list --only boots the closure NATIVELY (covered in
  // up-native.int.test.ts). Combined with a flag the native path can't honour
  // (here --tunnel) there is no single-service up.sh fallback, so it's rejected.
  it('rejects a comma-list --only + native-unsupported flag (--tunnel)', async () => {
    await expect(
      StackUp.run(['--only', 'scheduling-api,sessions-api', '--tunnel', ...WS], config),
    ).rejects.toMatchObject({ message: expect.stringContaining('boots the closure NATIVELY') });
    expect(calls).toHaveLength(0);
  });

  // A SINGLE-service --only with a native-unsupported flag (--sandbox) still
  // falls back to the up.sh wrapper (preserves the M1 --sandbox behaviour).
  it('single-service --only + --sandbox falls back to the up.sh wrapper', async () => {
    await StackUp.run(['--only', 'scheduling-api', '--sandbox', 'demo', ...WS], config);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['up', '--only', 'scheduling-api', '--sandbox', 'demo']);
  });

  it('propagates a non-zero up.sh exit code via this.exit()', async () => {
    installFakeRunner(3);
    // oclif's this.exit(code) throws an ExitError carrying `oclif.exit === code`.
    await expect(StackUp.run(['--legacy', ...WS], config)).rejects.toMatchObject({ oclif: { exit: 3 } });
    expect(calls).toHaveLength(1);
  });
});

describe('stack down — slot-safe teardown (M7 BLOCKER-2)', () => {
  const INFRA_DIR = resolve(SOA_ROOT, 'infra');

  it('slot 0 (bare) wraps up.sh --down (unchanged M1 behaviour)', async () => {
    await StackDown.run([...WS], config);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(UP_SH);
    expect(calls[0].args).toEqual(['--down']);
  });

  it('slot 0 --mesh: up.sh --down THEN make down for the default project', async () => {
    await StackDown.run(['--mesh', ...WS], config);
    expect(calls).toHaveLength(2);
    expect(calls[0].command).toBe(UP_SH);
    expect(calls[0].args).toEqual(['--down']);
    // mesh teardown targets the DEFAULT project (no COMPOSE_PROJECT_NAME arg/env).
    expect(calls[1].command).toBe('make');
    expect(calls[1].cwd).toBe(INFRA_DIR);
    expect(calls[1].args).toEqual(['down', 'PROJECT=saga-mesh']);
    expect(calls[1].env).toEqual({});
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
});

describe('stack seed --legacy — --with bundles map to up.sh seed add-ons (FLIP 2: seed is native-by-default)', () => {
  // FLIP 2: bare `stack seed` now seeds NATIVELY (covered in seed-native.int.test.ts);
  // `--legacy` is the up.sh escape whose flag→argv mapping these pin.
  it('bare --legacy → up.sh --seed roster (no add-ons)', async () => {
    await StackSeed.run(['--legacy', ...WS], config);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(UP_SH);
    expect(calls[0].args).toEqual(['--seed', 'roster']);
  });

  it('--legacy full --with playback → --seed full --with-playback (== the old --with-playback)', async () => {
    await StackSeed.run(['--legacy', 'full', '--with', 'playback', ...WS], config);
    expect(calls[0].args).toEqual(['--seed', 'full', '--with-playback']);
  });

  it('--legacy --with playback --with qtf → both add-on flags (registry order)', async () => {
    await StackSeed.run(['--legacy', '--with', 'playback', '--with', 'qtf', ...WS], config);
    expect(calls[0].args).toEqual(['--seed', 'roster', '--with-playback', '--with-qtf-demo']);
  });

  it('--legacy --with qtf → up.sh --with-qtf-demo (bash flag emitted by the mapper)', async () => {
    await StackSeed.run(['--legacy', '--with', 'qtf', ...WS], config);
    expect(calls[0].args).toEqual(['--seed', 'roster', '--with-qtf-demo']);
  });

  it('--legacy a bundle with no seed add-on (--with coach) is a no-op', async () => {
    await StackSeed.run(['--legacy', '--with', 'coach', ...WS], config);
    expect(calls[0].args).toEqual(['--seed', 'roster']);
  });
});

describe('stack reset --legacy — wraps up.sh --reset (the non-destructive escape)', () => {
  // The default `stack reset` is now NATIVE (M8 R4 — asserted in stack-api.unit);
  // the up.sh mapping lives behind `--legacy`.
  it('bare --legacy → up.sh --reset', async () => {
    await StackReset.run(['--legacy', ...WS], config);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(UP_SH);
    expect(calls[0].args).toEqual(['--reset']);
  });

  it('--legacy --with playback → --reset --with-playback (== the old --with-playback)', async () => {
    await StackReset.run(['--legacy', '--with', 'playback', ...WS], config);
    expect(calls[0].args).toEqual(['--reset', '--with-playback']);
  });

  it('--legacy with a bundle already in the default reset set (--with coach) is a no-op', async () => {
    await StackReset.run(['--legacy', '--with', 'coach', ...WS], config);
    expect(calls[0].args).toEqual(['--reset']);
  });
});

// NOTE: `stack status` and `stack verify` are NO LONGER shell-out wrappers — M2
// re-implemented them natively (manifest-derived health probes via the injectable
// HealthProber). Their tests moved to `status-verify.int.test.ts`, which mocks
// `getProber` instead of `getRunner`. (verify --full still delegates to verify.sh
// and is covered there.)

// NOTE (M10): `overlay apply|list|reset` are NO LONGER shell-out wrappers — the git
// engine is native (see overlay-native.int.test.ts, which mocks the git/gh/overlay-fs
// seams). `compose-rest` (cloud orchestrator) and `--legacy` (whole-verb escape) remain
// ScriptPlan wrappers over refresh-suite.sh — the still-wrapped cases live here.
describe('stack overlay — compose-rest + --legacy still wrap refresh-suite.sh', () => {
  it('rejects apply with positional repos but no --prs (would silently drop them)', async () => {
    await expect(
      StackOverlay.run(['apply', 'saga-dash', ...WS], config),
    ).rejects.toMatchObject({ message: expect.stringContaining('ignores positional repos unless --prs') });
    expect(calls).toHaveLength(0);
  });

  it('--legacy apply → refresh-suite.sh ScriptPlan (the whole-verb escape)', async () => {
    await StackOverlay.run(['apply', '--legacy', ...WS], config);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      cwd: SYNTH_DIR,
      command: REFRESH_SH,
      args: [],
      env: { DEV: DEV_ROOT, SOA: SOA_ROOT },
      stdio: 'inherit',
    });
  });

  it('--legacy apply --prs <set> <repo…> → ad-hoc overlay argv (repos read off positionals)', async () => {
    await StackOverlay.run(['apply', '--legacy', '--prs', '165', 'saga-dash', ...WS], config);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(REFRESH_SH);
    expect(calls[0].args).toEqual(['--prs', '165', 'saga-dash']);
  });

  it('--legacy reset <repo…> → --reset <repo…>', async () => {
    await StackOverlay.run(['reset', '--legacy', 'rostering', ...WS], config);
    expect(calls[0].command).toBe(REFRESH_SH);
    expect(calls[0].args).toEqual(['--reset', 'rostering']);
  });

  it('compose-rest <name> → --compose-rest <name>; knobs become env', async () => {
    await StackOverlay.run(
      ['compose-rest', 'dev', '--ttl-hours', '6', '--seed-profile', 'canonical', ...WS],
      config,
    );
    expect(calls[0].args).toEqual(['--compose-rest', 'dev']);
    expect(calls[0].env).toEqual({
      DEV: DEV_ROOT,
      SOA: SOA_ROOT,
      SANDBOX_TTL_HOURS: '6',
      SANDBOX_SEED_PROFILE: 'canonical',
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

describe('stack tunnel — wraps tunnel.sh', () => {
  it('up → tunnel.sh up', async () => {
    await StackTunnel.run(['up', ...WS], config);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      cwd: SYNTH_DIR,
      command: TUNNEL_SH,
      args: ['up'],
      env: { DEV: DEV_ROOT, SOA: SOA_ROOT },
      stdio: 'inherit',
    });
  });

  it('moniker is the dispatch VERB (never a flag value); --vms-base → env VMS_BASE', async () => {
    await StackTunnel.run(['moniker', '--vms-base', 'vms.example.com', ...WS], config);
    expect(calls[0].args).toEqual(['moniker']);
    expect(calls[0].env).toEqual({
      DEV: DEV_ROOT,
      SOA: SOA_ROOT,
      VMS_BASE: 'vms.example.com',
    });
  });
});

// M11: bootstrap is NATIVE-BY-DEFAULT (ensure-repos → overlay → up → verify); only
// `--legacy` routes the whole chain to bootstrap.sh. The native path is covered in
// bootstrap-native.int.test.ts; here we only assert the --legacy wrap + its exact argv.
describe('stack bootstrap --legacy — wraps bootstrap.sh', () => {
  it('--legacy → bootstrap.sh --seed roster (the flag default)', async () => {
    await StackBootstrap.run(['--legacy', ...WS], config);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      cwd: SYNTH_DIR,
      command: BOOTSTRAP_SH,
      args: ['--seed', 'roster'],
      env: { DEV: DEV_ROOT, SOA: SOA_ROOT },
      stdio: 'inherit',
    });
  });

  it('--legacy --no-refresh --seed full → bootstrap.sh --no-refresh --seed full', async () => {
    await StackBootstrap.run(['--legacy', '--no-refresh', '--seed', 'full', ...WS], config);
    expect(calls[0].args).toEqual(['--no-refresh', '--seed', 'full']);
  });

  it('--legacy --yes is rejected (bootstrap.sh has no non-interactive antecedent) and never spawns', async () => {
    await expect(StackBootstrap.run(['--legacy', '--yes', ...WS], config)).rejects.toMatchObject({
      message: expect.stringContaining('bootstrap --yes is not available'),
    });
    expect(calls).toHaveLength(0);
  });
});

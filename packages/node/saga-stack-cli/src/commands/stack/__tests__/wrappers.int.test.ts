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

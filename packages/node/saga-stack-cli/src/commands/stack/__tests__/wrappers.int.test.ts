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
import type { RunResult, ScriptInvocation } from '../../../runtime/index.js';
import StackUp from '../up.js';
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

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  installFakeRunner(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The workspace flags every case shares for deterministic path/env resolution. */
const WS = ['--soa', SOA_ROOT, '--dev', DEV_ROOT];

describe('stack up — real path (no --dry-run) wraps up.sh', () => {
  it('maps flags to the exact up.sh ScriptInvocation and never spawns', async () => {
    await StackUp.run(['--reset', '--seed', 'roster', '--login', ...WS], config);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      cwd: SYNTH_DIR,
      command: UP_SH,
      args: ['up', '--reset', '--seed', 'roster', '--login'],
      env: { DEV: DEV_ROOT, SOA: SOA_ROOT },
      stdio: 'inherit',
    });
  });

  it('--no-auto-pull / --skip-prep surface as env on the invocation (under the repo env)', async () => {
    await StackUp.run(['--no-auto-pull', '--skip-prep', ...WS], config);

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
      ['--rostering', '/x/rostering', '--program-hub', '/y/ph', ...WS],
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
    await expect(StackUp.run([...WS], config)).rejects.toMatchObject({ oclif: { exit: 3 } });
    expect(calls).toHaveLength(1);
  });
});

describe('stack seed — --with bundles map to up.sh seed add-ons', () => {
  it('bare → up.sh --seed roster (no add-ons)', async () => {
    await StackSeed.run([...WS], config);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(UP_SH);
    expect(calls[0].args).toEqual(['--seed', 'roster']);
  });

  it('full --with playback → --seed full --with-playback (== the old --with-playback)', async () => {
    await StackSeed.run(['full', '--with', 'playback', ...WS], config);
    expect(calls[0].args).toEqual(['--seed', 'full', '--with-playback']);
  });

  it('--with playback --with qtf → both add-on flags (registry order)', async () => {
    await StackSeed.run(['--with', 'playback', '--with', 'qtf', ...WS], config);
    expect(calls[0].args).toEqual(['--seed', 'roster', '--with-playback', '--with-qtf-demo']);
  });

  it('--with qtf → up.sh --with-qtf-demo (bash flag emitted by the mapper)', async () => {
    await StackSeed.run(['--with', 'qtf', ...WS], config);
    expect(calls[0].args).toEqual(['--seed', 'roster', '--with-qtf-demo']);
  });

  it('a bundle with no seed add-on (--with coach) is a no-op', async () => {
    await StackSeed.run(['--with', 'coach', ...WS], config);
    expect(calls[0].args).toEqual(['--seed', 'roster']);
  });
});

describe('stack reset — --with playback also truncates the playback DBs', () => {
  it('bare → up.sh --reset', async () => {
    await StackReset.run([...WS], config);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(UP_SH);
    expect(calls[0].args).toEqual(['--reset']);
  });

  it('--with playback → --reset --with-playback (== the old --with-playback)', async () => {
    await StackReset.run(['--with', 'playback', ...WS], config);
    expect(calls[0].args).toEqual(['--reset', '--with-playback']);
  });

  it('a bundle already in the default reset set (--with coach) is a no-op', async () => {
    await StackReset.run(['--with', 'coach', ...WS], config);
    expect(calls[0].args).toEqual(['--reset']);
  });
});

// NOTE: `stack status` and `stack verify` are NO LONGER shell-out wrappers — M2
// re-implemented them natively (manifest-derived health probes via the injectable
// HealthProber). Their tests moved to `status-verify.int.test.ts`, which mocks
// `getProber` instead of `getRunner`. (verify --full still delegates to verify.sh
// and is covered there.)

describe('stack overlay — wraps refresh-suite.sh', () => {
  it('apply (bare) → refresh-suite.sh with no argv (file-driven)', async () => {
    await StackOverlay.run(['apply', ...WS], config);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      cwd: SYNTH_DIR,
      command: REFRESH_SH,
      args: [],
      env: { DEV: DEV_ROOT, SOA: SOA_ROOT },
      stdio: 'inherit',
    });
  });

  it('apply --prs <set> <repo…> → ad-hoc overlay argv (repos read off positionals)', async () => {
    await StackOverlay.run(['apply', '--prs', '165', 'saga-dash', ...WS], config);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(REFRESH_SH);
    expect(calls[0].args).toEqual(['--prs', '165', 'saga-dash']);
  });

  it('rejects apply with positional repos but no --prs (would silently drop them)', async () => {
    await expect(
      StackOverlay.run(['apply', 'saga-dash', ...WS], config),
    ).rejects.toMatchObject({ message: expect.stringContaining('ignores positional repos unless --prs') });
    expect(calls).toHaveLength(0);
  });

  it('list → --list', async () => {
    await StackOverlay.run(['list', ...WS], config);
    expect(calls[0].args).toEqual(['--list']);
  });

  it('reset <repo…> → --reset <repo…>', async () => {
    await StackOverlay.run(['reset', 'rostering', ...WS], config);
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

describe('stack bootstrap — wraps bootstrap.sh', () => {
  it('default → bootstrap.sh --seed roster (the flag default)', async () => {
    await StackBootstrap.run([...WS], config);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      cwd: SYNTH_DIR,
      command: BOOTSTRAP_SH,
      args: ['--seed', 'roster'],
      env: { DEV: DEV_ROOT, SOA: SOA_ROOT },
      stdio: 'inherit',
    });
  });

  it('--no-refresh --seed full → bootstrap.sh --no-refresh --seed full', async () => {
    await StackBootstrap.run(['--no-refresh', '--seed', 'full', ...WS], config);
    expect(calls[0].args).toEqual(['--no-refresh', '--seed', 'full']);
  });

  it('--yes is rejected with a clear message and never spawns', async () => {
    await expect(StackBootstrap.run(['--yes', ...WS], config)).rejects.toMatchObject({
      message: expect.stringContaining('bootstrap --yes is not available'),
    });
    expect(calls).toHaveLength(0);
  });
});

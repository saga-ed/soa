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
import StackVerify from '../verify.js';
import StackStatus from '../status.js';

// Package root = vitest cwd; soa root is three dirs up (packages/node/<pkg>).
const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const SYNTH_DIR = resolve(SOA_ROOT, 'tools', 'synthetic-dev');
const UP_SH = resolve(SYNTH_DIR, 'up.sh');
const VERIFY_SH = resolve(SYNTH_DIR, 'verify.sh');
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

  it('rejects a comma-list --only on the real path (closure is --dry-run/M4 only)', async () => {
    await expect(
      StackUp.run(['--only', 'scheduling-api,sessions-api', ...WS], config),
    ).rejects.toMatchObject({ message: expect.stringContaining('comma-separated --only') });
    expect(calls).toHaveLength(0);
  });

  it('passes a SINGLE-service --only through to up.sh on the real path', async () => {
    await StackUp.run(['--only', 'scheduling-api', ...WS], config);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['up', '--only', 'scheduling-api']);
  });

  it('propagates a non-zero up.sh exit code via this.exit()', async () => {
    installFakeRunner(3);
    // oclif's this.exit(code) throws an ExitError carrying `oclif.exit === code`.
    await expect(StackUp.run([...WS], config)).rejects.toMatchObject({ oclif: { exit: 3 } });
    expect(calls).toHaveLength(1);
  });
});

describe('stack verify — wraps verify.sh', () => {
  it('default → verify.sh with no argv and no extra env beyond repo paths', async () => {
    await StackVerify.run([...WS], config);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      cwd: SYNTH_DIR,
      command: VERIFY_SH,
      args: [],
      env: { DEV: DEV_ROOT, SOA: SOA_ROOT },
      stdio: 'inherit',
    });
  });

  it('--health-only adds VERIFY_HEALTH_ONLY=1 to the env (still no argv)', async () => {
    await StackVerify.run(['--health-only', ...WS], config);

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(VERIFY_SH);
    expect(calls[0].args).toEqual([]);
    expect(calls[0].env).toEqual({
      DEV: DEV_ROOT,
      SOA: SOA_ROOT,
      VERIFY_HEALTH_ONLY: '1',
    });
  });
});

describe('stack status — wraps up.sh --status, read-only', () => {
  it('hands the Runner up.sh --status', async () => {
    await StackStatus.run([...WS], config);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      cwd: SYNTH_DIR,
      command: UP_SH,
      args: ['--status'],
      env: { DEV: DEV_ROOT, SOA: SOA_ROOT },
      stdio: 'inherit',
    });
  });

  it('does NOT propagate a non-zero exit (status is read-only; never fails on its own)', async () => {
    installFakeRunner(1);
    // No throw: propagateExit:false means a degraded stack is reported, not an error.
    await expect(StackStatus.run([...WS], config)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

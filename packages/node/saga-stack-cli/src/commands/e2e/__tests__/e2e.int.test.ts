/**
 * e2e topic integration tests — the process seam for the saga-dash e2e wrappers.
 *
 * Drives the real oclif `e2e run/list/connect` commands end-to-end (parse →
 * e2e-map → runScript → Runner) with the Runner REPLACED by a fake that records
 * the ScriptInvocation. NOTHING is spawned: check-e2e.sh / connect-session.sh /
 * playwright are never executed.
 *
 * The e2e scripts live in the SAGA_DASH repo, which may not be checked out
 * alongside soa in CI — so instead of resolving the real saga-dash, we build a
 * THROWAWAY stub tree (empty `check-e2e.sh` / `connect-session.sh`) in a temp dir
 * and pin it with `--saga-dash`. `resolveScript`'s existence guard is satisfied
 * by the stubs; the fake Runner means they are never run. This keeps the suite
 * portable and hermetic.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Config } from '@oclif/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import type { RunResult, ScriptInvocation } from '../../../runtime/index.js';
import E2eRun from '../run.js';
import E2eList from '../list.js';
import E2eConnect from '../connect.js';

const PKG_ROOT = process.cwd();
const DEV_ROOT = '/fixed/dev';

let DASH_ROOT: string;
let E2E_DIR: string;
let CHECK_SH: string;
let CONNECT_SH: string;

let config: Config;
let calls: ScriptInvocation[];
let cannedCode: number;

function installFakeRunner(code = 0): void {
  cannedCode = code;
  calls = [];
  vi.spyOn(
    BaseCommand.prototype as unknown as { getRunner: () => unknown },
    'getRunner',
  ).mockReturnValue({
    async run(spec: ScriptInvocation): Promise<RunResult> {
      calls.push(spec);
      return { code: cannedCode };
    },
  });
}

beforeAll(() => {
  DASH_ROOT = mkdtempSync(join(tmpdir(), 'saga-dash-stub-'));
  E2E_DIR = join(DASH_ROOT, 'apps', 'web', 'dash', 'e2e');
  mkdirSync(E2E_DIR, { recursive: true });
  CHECK_SH = join(E2E_DIR, 'check-e2e.sh');
  CONNECT_SH = join(E2E_DIR, 'connect-session.sh');
  for (const f of [CHECK_SH, CONNECT_SH]) writeFileSync(f, '#!/usr/bin/env bash\n');
});

afterAll(() => {
  rmSync(DASH_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  installFakeRunner(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Workspace flags pinning the stub saga-dash checkout. */
function ws(): string[] {
  return ['--saga-dash', DASH_ROOT, '--dev', DEV_ROOT];
}

describe('e2e run — wraps check-e2e.sh', () => {
  it('--phase 2 --headless → check-e2e.sh --phase 2 --headless', async () => {
    await E2eRun.run(['--phase', '2', '--headless', ...ws()], config);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      cwd: E2E_DIR,
      command: CHECK_SH,
      args: ['--phase', '2', '--headless'],
      env: { DEV: DEV_ROOT, SAGA_DASH: DASH_ROOT },
      stdio: 'inherit',
    });
  });

  it('lifecycle knobs become env; playwright passthrough (after --) is appended to argv', async () => {
    await E2eRun.run(['--skip-reset', '--pause-at-end', ...ws(), '--', '--debug'], config);
    expect(calls[0].args).toEqual(['--debug']);
    expect(calls[0].env).toEqual({
      DEV: DEV_ROOT,
      SAGA_DASH: DASH_ROOT,
      SKIP_RESET: '1',
      PAUSE_AT_END: '1',
    });
  });

  it('--through is an alias of --phase', async () => {
    await E2eRun.run(['--through', 'program', ...ws()], config);
    expect(calls[0].args).toEqual(['--phase', 'program']);
  });

  it('--inspect + --no-inspect is rejected before spawning', async () => {
    await expect(
      E2eRun.run(['--inspect', '--no-inspect', ...ws()], config),
    ).rejects.toMatchObject({ message: expect.stringContaining('mutually exclusive') });
    expect(calls).toHaveLength(0);
  });
});

describe('e2e list — wraps check-e2e.sh --help', () => {
  it('hands the Runner check-e2e.sh --help and never fails on its own', async () => {
    installFakeRunner(1); // even a non-zero exit must not throw (read-only listing)
    await expect(E2eList.run([...ws()], config)).resolves.toBeUndefined();
    expect(calls[0].command).toBe(CHECK_SH);
    expect(calls[0].args).toEqual(['--help']);
  });
});

describe('e2e connect — wraps connect-session.sh (foreground)', () => {
  it('bare → connect-session.sh with no args', async () => {
    await E2eConnect.run([...ws()], config);
    expect(calls[0]).toEqual({
      cwd: E2E_DIR,
      command: CONNECT_SH,
      args: [],
      env: { DEV: DEV_ROOT, SAGA_DASH: DASH_ROOT },
      stdio: 'inherit',
    });
  });

  it('--reuse and playwright passthrough → --reuse then the passthrough args', async () => {
    await E2eConnect.run(['--reuse', ...ws(), '--', '--debug'], config);
    expect(calls[0].args).toEqual(['--reuse', '--debug']);
  });
});

/**
 * `stack bootstrap` NATIVE orchestration integration tests (M11 ITEM A).
 *
 * bootstrap is native-by-default: ensure-repos → overlay → up --reset --seed → verify.
 * These drive the REAL StackBootstrap command but REPLACE:
 *   - `getGitRunner` (clone) / `getConfirm` / `getRepoDirCheck` — the ensure-repos seams.
 *   - StackOverlay.run / StackUp.run / StackVerify.run — the delegated native steps,
 *     spied to record ORDER + argv (so we assert the chain without booting a real stack).
 *
 * Focus: the ensure-repos DELTA + the STAGED fail-before-up ordering (an ensure/clone
 * failure aborts BEFORE the up step). `stack bootstrap` is fully native — no bash wrap.
 */

import { resolve } from 'node:path';
import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import type { ConfirmSeam, GitRunner } from '../../../runtime/index.js';
import StackBootstrap from '../bootstrap.js';
import StackOverlay from '../overlay.js';
import StackUp from '../up.js';
import StackVerify from '../verify.js';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const DEV_ROOT = '/fixed/dev';
const WS = ['--soa', SOA_ROOT, '--dev', DEV_ROOT];

let config: Config;
let steps: string[];
let clones: string[];
let logged: string[];

/** Spy the three delegated native steps; record call order + argv. */
function installStepSpies(): void {
  steps = [];
  vi.spyOn(StackOverlay, 'run').mockImplementation(async (argv?: string[]) => {
    steps.push(`overlay ${(argv ?? []).slice(0, 1).join(' ')}`);
  });
  vi.spyOn(StackUp, 'run').mockImplementation(async (argv?: string[]) => {
    steps.push(`up ${(argv ?? []).filter((a) => a === '--reset' || a === '--seed' || a === 'roster' || a === 'full').join(' ')}`);
  });
  vi.spyOn(StackVerify, 'run').mockImplementation(async () => {
    steps.push('verify');
  });
}

/** Fake ensure-repos seams: a clone-recording git + a confirm seam + a `.git` predicate. */
function installEnsureSeams(opts: { present: boolean; isTTY?: boolean; answer?: boolean; cloneOk?: boolean }): void {
  clones = [];
  const git = {
    async clone(url: string, dir: string): Promise<boolean> {
      clones.push(`${url} → ${dir}`);
      return opts.cloneOk ?? true;
    },
  } as unknown as GitRunner;
  vi.spyOn(BaseCommand.prototype as unknown as { getGitRunner: () => unknown }, 'getGitRunner').mockReturnValue(git);

  const confirm: ConfirmSeam = {
    isTTY: () => opts.isTTY ?? false,
    async prompt(): Promise<boolean> {
      return opts.answer ?? false;
    },
  };
  vi.spyOn(BaseCommand.prototype as unknown as { getConfirm: () => unknown }, 'getConfirm').mockReturnValue(confirm);

  vi.spyOn(
    BaseCommand.prototype as unknown as { getRepoDirCheck: () => unknown },
    'getRepoDirCheck',
  ).mockReturnValue(() => opts.present);
}

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  logged = [];
  vi.spyOn(BaseCommand.prototype as unknown as { log: (m?: string) => void }, 'log').mockImplementation(
    (m?: string) => {
      logged.push(m ?? '');
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stack bootstrap — native chain', () => {
  it('all repos present ⇒ NO clone, then overlay → up --reset --seed roster → verify (in order)', async () => {
    installEnsureSeams({ present: true });
    installStepSpies();

    await StackBootstrap.run([...WS], config);

    expect(clones).toHaveLength(0);
    expect(steps).toEqual(['overlay apply', 'up --reset --seed roster', 'verify']);
  });

  it('--no-refresh SKIPS the overlay step (ensure → up → verify)', async () => {
    installEnsureSeams({ present: true });
    installStepSpies();

    await StackBootstrap.run(['--no-refresh', '--seed', 'full', ...WS], config);

    expect(steps).toEqual(['up --reset --seed full', 'verify']);
  });

  it('missing repos + --yes ⇒ CLONES all 7 required, then runs the chain', async () => {
    installEnsureSeams({ present: false, cloneOk: true });
    installStepSpies();

    await StackBootstrap.run(['--yes', ...WS], config);

    // the 7 required siblings cloned from saga-ed (coach/fleek excluded).
    expect(clones).toHaveLength(7);
    expect(clones.some((c) => c.includes('saga-ed/student-data-system.git → /fixed/dev/student-data-system'))).toBe(
      true,
    );
    expect(clones.some((c) => c.includes('coach'))).toBe(false);
    expect(clones.some((c) => c.includes('fleek'))).toBe(false);
    expect(steps).toEqual(['overlay apply', 'up --reset --seed roster', 'verify']);
  });

  it('STAGED fail-before-up: missing repos + NO TTY + no --yes ⇒ ABORT before up (never clones, up not called)', async () => {
    installEnsureSeams({ present: false, isTTY: false });
    installStepSpies();

    await expect(StackBootstrap.run([...WS], config)).rejects.toBeTruthy();

    expect(clones).toHaveLength(0); // never cloned unprompted
    expect(steps).toEqual([]); // overlay/up/verify NEVER reached (staged fail-before-up)
  });

  it('a clone FAILURE aborts before up', async () => {
    installEnsureSeams({ present: false, cloneOk: false });
    installStepSpies();

    await expect(StackBootstrap.run(['--yes', ...WS], config)).rejects.toBeTruthy();

    expect(steps).toEqual([]); // up never reached
  });
});

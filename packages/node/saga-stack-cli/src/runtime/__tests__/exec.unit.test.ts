/**
 * Runtime exec seam — contract coverage (plan §7.2 M1).
 *
 * The whole reason `Runner` exists is so M1's golden tests can assert the exact
 * `ScriptInvocation` a wrapper hands to up.sh/verify.sh WITHOUT launching a real
 * process. This suite pins that contract: a fake Runner records the spec and
 * returns a canned code, and `makeRealRunner()` produces a Runner-shaped object.
 *
 * Per the package's hard constraint, NO real process is spawned here — the real
 * runner is only checked for shape, never invoked.
 */

import { describe, expect, it } from 'vitest';
import { makeRealRunner } from '../exec.js';
import type { Runner, RunResult, ScriptInvocation } from '../exec.js';

/** A fake Runner that records every spec it is handed and returns a canned code. */
function makeFakeRunner(code = 0): { runner: Runner; calls: ScriptInvocation[] } {
  const calls: ScriptInvocation[] = [];
  const runner: Runner = {
    async run(spec: ScriptInvocation): Promise<RunResult> {
      calls.push(spec);
      return { code };
    },
  };
  return { runner, calls };
}

describe('Runner contract (fake)', () => {
  it('records the exact ScriptInvocation and returns the canned code', async () => {
    const { runner, calls } = makeFakeRunner(0);
    const spec: ScriptInvocation = {
      cwd: '/home/me/dev/soa/tools/synthetic-dev',
      command: '/home/me/dev/soa/tools/synthetic-dev/up.sh',
      args: ['--seed', 'journey', '--login'],
      env: { DEV: '/home/me/dev', ROSTERING: '/alt/rostering' },
      stdio: 'inherit',
    };

    const result = await runner.run(spec);

    expect(result).toEqual({ code: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(spec);
  });

  it('propagates a non-zero exit code', async () => {
    const { runner } = makeFakeRunner(2);
    const result = await runner.run({
      cwd: '/x',
      command: '/x/verify.sh',
      args: [],
      env: {},
    });
    expect(result.code).toBe(2);
  });
});

describe('makeRealRunner', () => {
  it('returns a Runner with a run() method (not invoked here)', () => {
    const runner = makeRealRunner();
    expect(typeof runner.run).toBe('function');
  });
});

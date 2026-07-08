/**
 * host-reinstall unit tests — cold-start's INLINE reinstall of the host repo
 * (soa) after `--reinstall` wipes its `node_modules` (soa#cold-start).
 *
 * Inject a fake Runner and assert the executed PLAN: one `pnpm install` in the
 * host root; a CodeArtifact 401 forces a single `pnpm co:login` + retry; a
 * non-401 failure never retries. NO real pnpm.
 */

import { describe, expect, it } from 'vitest';
import type { RunResult, Runner, ScriptInvocation } from '../exec.js';
import { HOST_CLI_PACKAGE, rebuildHostCli, reinstallHostRepo } from '../host-reinstall.js';

const ROOT = '/dev/soa';

/** A runner that answers each successive call from a queue of exit results. */
function scriptedRunner(results: RunResult[]): { runner: Runner; calls: ScriptInvocation[] } {
  const calls: ScriptInvocation[] = [];
  const queue = [...results];
  const runner: Runner = {
    async run(spec): Promise<RunResult> {
      calls.push(spec);
      return queue.shift() ?? { code: 0 };
    },
  };
  return { runner, calls };
}

describe('reinstallHostRepo — inline host-repo pnpm install', () => {
  it('runs a single `pnpm install` in the host root and reports ok', async () => {
    const { runner, calls } = scriptedRunner([{ code: 0 }]);

    const result = await reinstallHostRepo(ROOT, { runner });

    expect(result).toEqual({ ok: true, reloggedIn: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ cwd: ROOT, command: 'pnpm', args: ['install'], detectUnauthorized: true });
  });

  it('on a CodeArtifact 401, refreshes via `pnpm co:login` and retries install once (success)', async () => {
    // install #1 → 401, co:login → ok, install #2 → ok.
    const { runner, calls } = scriptedRunner([{ code: 1, unauthorized: true }, { code: 0 }, { code: 0 }]);

    const result = await reinstallHostRepo(ROOT, { runner });

    expect(result).toEqual({ ok: true, reloggedIn: true });
    expect(calls.map((c) => c.args)).toEqual([['install'], ['co:login'], ['install']]);
    expect(calls.every((c) => c.cwd === ROOT)).toBe(true);
  });

  it('on a 401 whose retry still fails, reports not-ok (relogin attempted)', async () => {
    const { runner, calls } = scriptedRunner([{ code: 1, unauthorized: true }, { code: 0 }, { code: 1, unauthorized: true }]);

    const result = await reinstallHostRepo(ROOT, { runner });

    expect(result).toEqual({ ok: false, reloggedIn: true });
    expect(calls.map((c) => c.args)).toEqual([['install'], ['co:login'], ['install']]);
  });

  it('a NON-401 install failure never triggers a co:login retry', async () => {
    const { runner, calls } = scriptedRunner([{ code: 1 }]);

    const result = await reinstallHostRepo(ROOT, { runner });

    expect(result).toEqual({ ok: false, reloggedIn: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['install']);
  });

  it('notifies only when a relogin+retry happens', async () => {
    const notifiedOk: string[] = [];
    await reinstallHostRepo(ROOT, { runner: scriptedRunner([{ code: 0 }]).runner, notify: (m) => notifiedOk.push(m) });
    expect(notifiedOk).toEqual([]);

    const notified401: string[] = [];
    await reinstallHostRepo(ROOT, {
      runner: scriptedRunner([{ code: 1, unauthorized: true }, { code: 0 }, { code: 0 }]).runner,
      notify: (m) => notified401.push(m),
    });
    expect(notified401).toHaveLength(1);
    expect(notified401[0]).toMatch(/co:login/);
  });
});

describe('rebuildHostCli — inline host-CLI dist rebuild', () => {
  it('runs `turbo run build --filter=<cli>` in the host root and reports ok', async () => {
    const { runner, calls } = scriptedRunner([{ code: 0 }]);

    const result = await rebuildHostCli(ROOT, { runner });

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      cwd: ROOT,
      command: 'pnpm',
      args: ['turbo', 'run', 'build', `--filter=${HOST_CLI_PACKAGE}`],
    });
  });

  it('reports not-ok when the build exits non-zero', async () => {
    const { runner, calls } = scriptedRunner([{ code: 1 }]);

    const result = await rebuildHostCli(ROOT, { runner });

    expect(result).toEqual({ ok: false });
    expect(calls).toHaveLength(1);
  });

  it('targets the saga-stack-cli package (the dist the ss binary loads)', () => {
    expect(HOST_CLI_PACKAGE).toBe('@saga-ed/saga-stack-cli');
  });
});

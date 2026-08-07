/**
 * `makeRealForeignIo().killGroup` against a REAL process — the one part of the
 * foreign reap that cannot be asserted with a fake, because the bug it now
 * guards against lives in the timing of a real SIGKILL.
 *
 * THE RACE: SIGKILL is asynchronous. The kernel has not necessarily torn the
 * group down by the time the next statement runs, and a killed child that its
 * parent has not yet reaped lingers as a ZOMBIE — which still answers signal 0
 * without ESRCH. An immediate `!pidAlive(pid)` therefore reports a perfectly
 * successful reap as a survivor.
 *
 * Measured 2026-08-05: `stack restart` reaped a foreign coach-web and printed
 * "SURVIVED the reap — restart will serve stale code"; both pids were confirmed
 * dead a moment later and a fresh server already held the port. A guardrail that
 * cries wolf on every success is a guardrail that gets ignored.
 *
 * The spawned child is detached so it leads its own process group, which is what
 * `killGroup(-pgid)` targets — the same shape as a launcher-spawned service.
 */

import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { makeRealForeignIo } from '../foreign-procs.js';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

describe('makeRealForeignIo.killGroup — real process, real SIGKILL', () => {
  it('reports killed:true for a group it actually killed', async () => {
    // `sleep` is POSIX-portable and does nothing but exist.
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    const pid = child.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) return;

    // Detached ⇒ the child leads its own group, so pgid === pid.
    const killed = await makeRealForeignIo().killGroup(pid, pid);

    // The assertion that regressed: BEFORE the poll was added this returned
    // false, because the child was still an unreaped zombie at that instant.
    expect(killed).toBe(true);
    expect(alive(pid)).toBe(false);
  });

  it('reports killed:true for a pid that was already gone', async () => {
    const child = spawn('sleep', ['0'], { detached: true, stdio: 'ignore' });
    const pid = child.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) return;

    await new Promise((r) => child.on('exit', r));

    // An ESRCH on the signal is not a failure — the port is free either way.
    expect(await makeRealForeignIo().killGroup(pid, pid)).toBe(true);
  });
});

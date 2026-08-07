/**
 * Capture-path identity guard. Every seam is injected, so no service is signalled.
 *
 * The port answering is not proof the TARGET answered: `inspector.open()` on a
 * taken port logs `address already in use` and returns, leaving the loser running
 * with no inspector while the first service's inspector keeps serving /json/list.
 * /json/list carries no pid, so these pin the port-owner check that stands between
 * a concurrent profile and a successful capture of the wrong process.
 */

import { describe, expect, it } from 'vitest';
import { captureCpuProfile, type CdpSession, type ProfilerDeps } from '../profiler.js';

const PROFILE = { nodes: [{ id: 1 }], samples: [1], timeDeltas: [0] };

/** A CDP session that yields a minimal valid profile. */
function fakeSession(): CdpSession {
  return {
    send: async (method: string) => (method === 'Profiler.stop' ? { profile: PROFILE } : {}),
    close: () => {},
  };
}

/** Deps whose every seam is faked; `over` supplies the case under test. */
function deps(over: Partial<ProfilerDeps> = {}): ProfilerDeps {
  return {
    signal: () => {},
    fetchJson: async () => [{ webSocketDebuggerUrl: 'ws://127.0.0.1:9229/x', type: 'node' }],
    connect: async () => fakeSession(),
    sleep: async () => {},
    writeFile: () => {},
    portOwner: async () => 4242,
    ...over,
  };
}

const request = { pid: 4242, port: 9229, durationMs: 1, outPath: '/tmp/x.cpuprofile' };

describe('captureCpuProfile — inspector port identity', () => {
  it('captures when the port owner IS the signalled pid', async () => {
    const result = await captureCpuProfile(request, deps());
    expect(result).toMatchObject({ ok: true, outPath: '/tmp/x.cpuprofile' });
  });

  it('REFUSES when the port is owned by a different pid', async () => {
    // The concurrent-profile case: another service's inspector is still open here,
    // and /json/list would answer for it under our pid's name.
    const result = await captureCpuProfile(request, deps({ portOwner: async () => 9999 }));
    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error('expected refusal');
    expect(result.reason).toMatch(/held by pid 9999, not 4242/);
  });

  it('REFUSES when the owner cannot be resolved — unknown is not permission', async () => {
    const result = await captureCpuProfile(request, deps({ portOwner: async () => null }));
    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error('expected refusal');
    expect(result.reason).toMatch(/unidentifiable process/);
  });

  it('still checks identity on the re-attach path, which skips SIGUSR1', async () => {
    let signalled = false;
    const over = { signal: () => { signalled = true; } };
    const ok = await captureCpuProfile({ ...request, alreadyOpen: true }, deps(over));
    expect(ok).toMatchObject({ ok: true });
    expect(signalled).toBe(false);

    const stolen = await captureCpuProfile(
      { ...request, alreadyOpen: true },
      deps({ ...over, portOwner: async () => 9999 }),
    );
    expect(stolen).toMatchObject({ ok: false });
  });

  it('reports the inspector-never-answered case rather than capturing nothing', async () => {
    const result = await captureCpuProfile(
      request,
      deps({ fetchJson: async () => [], attempts: 2 }),
    );
    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error('expected refusal');
    expect(result.reason).toMatch(/never came up/);
  });

  it('surfaces a write failure without claiming the profiling failed', async () => {
    const result = await captureCpuProfile(
      request,
      deps({
        writeFile: () => {
          throw new Error('ENOENT');
        },
      }),
    );
    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error('expected refusal');
    expect(result.reason).toMatch(/captured OK but could not write/);
  });
});

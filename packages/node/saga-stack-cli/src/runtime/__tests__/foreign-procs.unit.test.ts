/**
 * Foreign-process IO wiring — `makeRealForeignProcs` over a FAKE `ForeignIo`, so
 * `find`/`reap` are asserted with no sockets, no `ps`, and no real `kill`. The
 * production `ForeignIo` (lsof/ss/ps/kill) is the thin shell it delegates to; the
 * logic worth testing is: find = (port→pid) ∘ (pid→pgid) ∘ pidfiles ∘ classify,
 * and reap = group-kill each finding, reporting per-pid liveness.
 */

import { describe, expect, it, vi } from 'vitest';
import { makeRealForeignProcs } from '../foreign-procs.js';
import type { ForeignIo } from '../foreign-procs.js';
import { manifest } from '../../core/manifest/index.js';

/** A fake ForeignIo: port→pid, pid→(pgid,command), owned pgids, and a kill spy. */
function fakeIo(over: Partial<ForeignIo> = {}): ForeignIo {
  return {
    async pidOnPort() {
      return null;
    },
    async procInfo() {
      return null;
    },
    ownedPgids() {
      return [];
    },
    killGroup() {
      return true;
    },
    ...over,
  };
}

describe('makeRealForeignProcs.find — wiring', () => {
  it('reports a foreign listener (pgid not in the pidfiles)', async () => {
    const io = fakeIo({
      pidOnPort: async (port) => (port === 3010 ? 3537029 : null),
      procInfo: async (pid) => (pid === 3537029 ? { pgid: 576078, command: 'node dist/main.js' } : null),
      ownedPgids: () => [12345], // ss owns some OTHER pgid
    });
    const found = await makeRealForeignProcs(io).find({
      manifest,
      services: ['iam-api'],
      stateDir: '/tmp/sds-synthetic',
    });
    expect(found).toEqual([
      { id: 'iam-api', port: 3010, pid: 3537029, pgid: 576078, command: 'node dist/main.js' },
    ]);
  });

  it('does NOT report an ss-owned listener (its pgid is a pidfile pid)', async () => {
    const io = fakeIo({
      pidOnPort: async (port) => (port === 3010 ? 3537029 : null),
      procInfo: async () => ({ pgid: 3537000, command: 'node dist/main.js' }),
      ownedPgids: () => [3537000], // recorded pidfile == the pgid leader
    });
    const found = await makeRealForeignProcs(io).find({ manifest, services: ['iam-api'], stateDir: '/x' });
    expect(found).toEqual([]);
  });

  it('treats a port with no listener as down (not foreign)', async () => {
    const io = fakeIo({ pidOnPort: async () => null, ownedPgids: () => [] });
    const found = await makeRealForeignProcs(io).find({ manifest, services: ['iam-api'], stateDir: '/x' });
    expect(found).toEqual([]);
  });

  it('drops a pid that vanishes between the port and proc probes', async () => {
    const io = fakeIo({
      pidOnPort: async () => 4242,
      procInfo: async () => null, // gone before we could read its pgid
      ownedPgids: () => [],
    });
    const found = await makeRealForeignProcs(io).find({ manifest, services: ['iam-api'], stateDir: '/x' });
    expect(found).toEqual([]);
  });
});

describe('makeRealForeignProcs.reap — group-kill + report', () => {
  it('group-kills each finding and reports the killed flag', async () => {
    const killGroup = vi.fn((_pgid: number, _pid: number) => true);
    const procs = makeRealForeignProcs(fakeIo({ killGroup }));
    const reaped = await procs.reap([
      { id: 'iam-api', port: 3010, pid: 3537029, pgid: 576078, command: 'node dist/main.js' },
    ]);
    expect(killGroup).toHaveBeenCalledWith(576078, 3537029);
    expect(reaped).toEqual([
      { id: 'iam-api', port: 3010, pid: 3537029, pgid: 576078, command: 'node dist/main.js', killed: true },
    ]);
  });

  it('marks a survivor killed:false (e.g. EPERM) without throwing', async () => {
    const procs = makeRealForeignProcs(fakeIo({ killGroup: () => false }));
    const reaped = await procs.reap([
      { id: 'sis-api', port: 3100, pid: 5, pgid: 5, command: 'node dist/main.js' },
    ]);
    expect(reaped[0]?.killed).toBe(false);
  });

  it('signals once per finding even when two share a pgid', async () => {
    const killGroup = vi.fn(() => true);
    const procs = makeRealForeignProcs(fakeIo({ killGroup }));
    await procs.reap([
      { id: 'iam-api', port: 3010, pid: 100, pgid: 900, command: 'x' },
      { id: 'sis-api', port: 3100, pid: 101, pgid: 900, command: 'y' },
    ]);
    expect(killGroup).toHaveBeenCalledTimes(2);
  });
});

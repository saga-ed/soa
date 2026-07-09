/**
 * Foreign-process classification — PURE ownership logic (no /proc, no lsof, no
 * spawn). The ownership rule under test: a stack port is FOREIGN iff its
 * listener's pgid is NOT one of the current `ss` pidfile pids (which, because
 * services are spawned `detached:true`, ARE the pgid leaders). A port with
 * nothing listening is "down", not foreign; an ss-owned pgid is skipped.
 */

import { describe, expect, it } from 'vitest';
import { classifyForeign, foreignCheckTargets } from '../foreign-procs.js';
import type { PortListener } from '../foreign-procs.js';
import { manifest } from '../manifest/index.js';
import type { ServiceId } from '../manifest/index.js';

function listener(port: number, pid: number, pgid: number, command = 'node dist/main.js'): PortListener {
  return { port, pid, pgid, command };
}

describe('foreignCheckTargets — which (id, port) pairs to check', () => {
  it('defaults to every NON-optional service, at base ports', () => {
    const targets = foreignCheckTargets(manifest);
    const byId = Object.fromEntries(targets.map((t) => [t.id, t.port]));
    // Non-optional services are covered (api + web)…
    expect(byId['iam-api']).toBe(3010);
    expect(byId['saga-dash']).toBe(8900);
    expect(byId['connect-web']).toBe(6210);
    expect(byId['coach-web']).toBe(8800);
    // …optional playback/authz services are NOT.
    expect(byId['transcripts-api']).toBeUndefined();
    expect(byId['authz-sync']).toBeUndefined();
  });

  it('restricts to a given subset, preserving order', () => {
    const ids: ServiceId[] = ['sis-api', 'iam-api'];
    expect(foreignCheckTargets(manifest, ids)).toEqual([
      { id: 'sis-api', port: 3100 },
      { id: 'iam-api', port: 3010 },
    ]);
  });

  it('applies slot portOverrides to the checked port', () => {
    const targets = foreignCheckTargets(manifest, ['iam-api'], { 'iam-api': 4010 });
    expect(targets).toEqual([{ id: 'iam-api', port: 4010 }]);
  });

  it('throws on an unknown service id', () => {
    expect(() => foreignCheckTargets(manifest, ['nope' as ServiceId])).toThrow(/unknown service id/);
  });
});

describe('classifyForeign — owned-pgid vs foreign', () => {
  const targets = [
    { id: 'iam-api' as ServiceId, port: 3010 },
    { id: 'sis-api' as ServiceId, port: 3100 },
  ];

  it('flags a port whose listener pgid is NOT an ss pidfile pid', () => {
    const listeners = new Map([[3010, listener(3010, 999, 576078, 'node dist/main.js')]]);
    const foreign = classifyForeign(targets, listeners, new Set([12345]));
    expect(foreign).toEqual([
      { id: 'iam-api', port: 3010, pid: 999, pgid: 576078, command: 'node dist/main.js' },
    ]);
  });

  it('skips an ss-OWNED listener (pgid == a pidfile pid, even as a grandchild)', () => {
    // detached:true ⇒ the grandchild listener (pid 3537029) inherits the leader's
    // pgid (3537000), which is the recorded pidfile pid ⇒ owned, not foreign.
    const listeners = new Map([[3010, listener(3010, 3537029, 3537000)]]);
    expect(classifyForeign(targets, listeners, new Set([3537000]))).toEqual([]);
  });

  it('skips a port with nothing listening (down, not foreign)', () => {
    expect(classifyForeign(targets, new Map(), new Set([1]))).toEqual([]);
  });

  it('classifies each target independently and preserves order', () => {
    const listeners = new Map([
      [3010, listener(3010, 111, 700)], // foreign
      [3100, listener(3100, 222, 800)], // owned
    ]);
    const foreign = classifyForeign(targets, listeners, new Set([800]));
    expect(foreign.map((f) => f.id)).toEqual(['iam-api']);
  });
});

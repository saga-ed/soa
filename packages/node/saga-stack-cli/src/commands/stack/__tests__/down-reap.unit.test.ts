/**
 * `down`'s post-teardown orphan-reap helpers (soa#361) — the PURE pieces behind
 * `reapOrphans`: which services' ports get scanned (`reapScanServices`) and how the
 * reap outcome is reported (`describeReap`). The find→reap wiring itself is covered
 * in wrappers.int.test.ts (fakes `getForeignProcs`) and foreign-procs.unit.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { deriveInstance } from '../../../core/derive-instance.js';
import type { ReapedProc } from '../../../runtime/index.js';
import { describeReap, reapScanServices } from '../down.js';

describe('reapScanServices — the scanned service band', () => {
  it('slot 0: every port-mapped service, nothing excluded (base ports)', () => {
    const services = reapScanServices(deriveInstance({ slot: 0 }));
    expect(services).toContain('iam-api');
    expect(services).toContain('connect-api');
    // slot 0 excludes nothing, so the scan set == the port-override keys.
    expect(services).toEqual(Object.keys(deriveInstance({ slot: 0 }).portOverrides));
  });

  it('slot N: drops the slot\'s excludedServices (e.g. the literal-port playback trio)', () => {
    const profile = deriveInstance({ slot: 1 });
    const services = reapScanServices(profile);
    for (const ex of profile.excludedServices) {
      expect(services).not.toContain(ex);
    }
    // iam-api is slottable, so it stays in the band.
    expect(services).toContain('iam-api');
  });
});

describe('describeReap — the reap report', () => {
  const proc = (over: Partial<ReapedProc>): ReapedProc => ({
    id: 'coach-web',
    port: 8800,
    pid: 3286182,
    pgid: 3286181,
    command: 'node vite.js dev',
    killed: true,
    ...over,
  });

  it('empty in ⇒ empty out (a clean teardown stays silent)', () => {
    expect(describeReap([], 0)).toEqual([]);
  });

  it('all killed ⇒ header + per-orphan line + ✓ summary', () => {
    const lines = describeReap([proc({})], 0);
    expect(lines[0]).toContain("1 orphan(s) still held slot 0's service ports");
    expect(lines[1]).toContain('coach-web :8800 pid 3286182 (pgid 3286181)');
    expect(lines[1]).not.toContain('STILL ALIVE');
    expect(lines[2]).toBe('✓ reaped 1 orphan(s) — the next up starts clean');
  });

  it('a survivor ⇒ its line is flagged STILL ALIVE and the summary is a ⚠, not a ✓', () => {
    const lines = describeReap([proc({ killed: false })], 1);
    expect(lines[1]).toContain('STILL ALIVE');
    expect(lines[2]).toBe('⚠ 1 orphan(s) could not be killed (already gone, or not permitted): coach-web(pid 3286182)');
    expect(lines.some((l) => l.startsWith('✓'))).toBe(false);
  });

  it('clips an over-long command label', () => {
    const long = 'node '.repeat(40);
    const lines = describeReap([proc({ command: long })], 0);
    expect(lines[1]).toContain('…');
    expect(lines[1].length).toBeLessThan(long.length + 40);
  });
});

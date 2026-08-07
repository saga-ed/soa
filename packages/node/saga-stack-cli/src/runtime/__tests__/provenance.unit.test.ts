/**
 * Listener-provenance IO — the wiring, driven entirely through fakes: no
 * sockets, no `/proc`, no `ps`, no git. Asserts that `makeRealProvenance`
 * resolves listeners through the SHARED `ForeignIo` (so ownership and
 * provenance can never disagree about what is listening), canonicalises the
 * expected roots before comparing, and stats each distinct root only once.
 *
 * `checkoutRootOf` is covered directly, because "which checkout is this?" is the
 * single most load-bearing decision in the module: a linked worktree's `.git` is
 * a FILE inside the primary checkout, so a path-prefix test would call it a
 * match when it is precisely the mismatch we are hunting.
 */

import { describe, expect, it, vi } from 'vitest';
import { checkoutRootOf, makeRealProvenance, type ProvenanceIo } from '../provenance.js';
import type { ForeignIo } from '../foreign-procs.js';
import type { ProcOrigin } from '../../core/provenance.js';
import { manifest } from '../../core/manifest/index.js';
import type { ServiceId } from '../../core/manifest/index.js';

const COACH_WEB: ServiceId = 'coach-web';
const T0 = Date.parse('2026-08-05T10:00:00Z');

describe('checkoutRootOf', () => {
  it('returns the nearest ancestor holding a .git entry', () => {
    const present = new Set(['/dev/coach/.git']);
    expect(checkoutRootOf('/dev/coach/apps/web/coach-web', (p) => present.has(p))).toBe('/dev/coach');
  });

  it('stops at a linked WORKTREE inside the primary checkout, not at the primary', () => {
    // A worktree's `.git` is a file, and it lives UNDER the primary checkout —
    // the exact shape a `startsWith(expectedRoot)` test gets backwards.
    const present = new Set([
      '/dev/coach/.git',
      '/dev/coach/.claude/worktrees/pr332/.git',
    ]);
    expect(
      checkoutRootOf('/dev/coach/.claude/worktrees/pr332/apps/web/coach-web', (p) => present.has(p)),
    ).toBe('/dev/coach/.claude/worktrees/pr332');
  });

  it('returns the directory itself when it is the checkout root', () => {
    expect(checkoutRootOf('/dev/coach', (p) => p === '/dev/coach/.git')).toBe('/dev/coach');
  });

  it('returns null when no ancestor is a checkout', () => {
    expect(checkoutRootOf('/tmp/scratch', () => false)).toBeNull();
  });
});

/** A ForeignIo whose listeners come from a port→pid map. */
function fakeForeignIo(listeners: Record<number, number>): ForeignIo {
  return {
    pidOnPort: async (port) => listeners[port] ?? null,
    procInfo: async (pid) => ({ pgid: pid, command: 'node vite.js dev' }),
    ownedPgids: () => [],
    killGroup: () => true,
  };
}

/** A ProvenanceIo whose origins come from a pid→origin map. */
function fakeProvenanceIo(
  origins: Record<number, ProcOrigin | null>,
  refMoved: Record<string, number | null> = {},
  canonical: (p: string) => string = (p) => p,
): ProvenanceIo {
  return {
    procOrigin: async (pid) => origins[pid] ?? null,
    refMovedAt: (root) => refMoved[root] ?? null,
    canonical,
  };
}

describe('makeRealProvenance.assess', () => {
  const opts = {
    manifest,
    services: [COACH_WEB],
    expectedRoots: new Map<ServiceId, string>([[COACH_WEB, '/dev/coach']]),
  };

  it('reports ok for a listener in the right checkout, started after HEAD moved', async () => {
    const p = makeRealProvenance(
      fakeProvenanceIo(
        { 42: { pid: 42, checkoutRoot: '/dev/coach', startedAtMs: T0 } },
        { '/dev/coach': T0 - 60_000 },
      ),
      fakeForeignIo({ 8800: 42 }),
    );
    const [row] = await p.assess(opts);
    expect(row?.verdict).toBe('ok');
    expect(row?.pid).toBe(42);
    expect(row?.port).toBe(8800);
  });

  it('reports stale for an owned listener that predates the checkout', async () => {
    const p = makeRealProvenance(
      fakeProvenanceIo(
        { 42: { pid: 42, checkoutRoot: '/dev/coach', startedAtMs: T0 - 6 * 86_400_000 } },
        { '/dev/coach': T0 },
      ),
      fakeForeignIo({ 8800: 42 }),
    );
    const [row] = await p.assess(opts);
    expect(row?.verdict).toBe('stale');
  });

  it('canonicalises the expected root before comparing it to the resolved cwd', async () => {
    // `resolveRepoRoot` may hand back a symlinked path; the process's cwd is
    // realpath'd. Without canonicalising the expectation these never match and
    // every service would be reported wrong-checkout.
    const p = makeRealProvenance(
      fakeProvenanceIo(
        { 42: { pid: 42, checkoutRoot: '/real/coach', startedAtMs: T0 } },
        { '/real/coach': T0 - 60_000 },
        (path) => (path === '/dev/coach' ? '/real/coach' : path),
      ),
      fakeForeignIo({ 8800: 42 }),
    );
    const [row] = await p.assess(opts);
    expect(row?.verdict).toBe('ok');
    expect(row?.expectedRoot).toBe('/real/coach');
  });

  it('treats a service with nothing listening as down, without probing its origin', async () => {
    const io = fakeProvenanceIo({});
    const spy = vi.spyOn(io, 'procOrigin');
    const p = makeRealProvenance(io, fakeForeignIo({}));
    const [row] = await p.assess(opts);
    expect(row?.verdict).toBe('down');
    expect(spy).not.toHaveBeenCalled();
  });

  it('treats a process that vanishes between probes as down', async () => {
    const foreign: ForeignIo = { ...fakeForeignIo({ 8800: 42 }), procInfo: async () => null };
    const p = makeRealProvenance(fakeProvenanceIo({}), foreign);
    const [row] = await p.assess(opts);
    expect(row?.verdict).toBe('down');
  });

  it('stats each distinct checkout root only once across services', async () => {
    const io = fakeProvenanceIo(
      {
        1: { pid: 1, checkoutRoot: '/dev/coach', startedAtMs: T0 },
        2: { pid: 2, checkoutRoot: '/dev/coach', startedAtMs: T0 },
      },
      { '/dev/coach': T0 - 60_000 },
    );
    const spy = vi.spyOn(io, 'refMovedAt');
    const p = makeRealProvenance(io, fakeForeignIo({ 8800: 1, 6105: 2 }));
    await p.assess({
      manifest,
      services: [COACH_WEB, 'coach-api' as ServiceId],
      expectedRoots: new Map<ServiceId, string>([
        [COACH_WEB, '/dev/coach'],
        ['coach-api' as ServiceId, '/dev/coach'],
      ]),
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

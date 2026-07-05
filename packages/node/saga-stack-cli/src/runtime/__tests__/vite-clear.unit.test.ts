/**
 * vite-clear unit tests (M9; up.sh `nuke_vite`).
 *
 * Assert the derived path list is byte-faithful to `nuke_vite` and that the real
 * clear removes the explicit caches + every `.vite` dir found under the scan roots
 * (WITHOUT descending into a matched `.vite`, mirroring `find … -prune`) — all with a
 * fake fs (no real rm).
 */

import { describe, expect, it } from 'vitest';
import { makeRealViteClear, viteCachePaths } from '../vite-clear.js';

describe('viteCachePaths — byte-faithful to nuke_vite', () => {
  it('derives the two explicit node_modules/.vite caches + the two dash scan roots', () => {
    const p = viteCachePaths({ sagaDashRoot: '/dev/saga-dash', qboardRoot: '/dev/qboard' });
    expect(p.explicit).toEqual([
      '/dev/saga-dash/apps/web/dash/node_modules/.vite',
      '/dev/qboard/apps/web/connectv3/node_modules/.vite',
    ]);
    expect(p.scanRoots).toEqual(['/dev/saga-dash/apps', '/dev/saga-dash/packages']);
  });

  it('tolerates trailing slashes on the roots', () => {
    const p = viteCachePaths({ sagaDashRoot: '/dev/saga-dash/', qboardRoot: '/dev/qboard/' });
    expect(p.explicit[0]).toBe('/dev/saga-dash/apps/web/dash/node_modules/.vite');
    expect(p.explicit[1]).toBe('/dev/qboard/apps/web/connectv3/node_modules/.vite');
  });
});

describe('makeRealViteClear — fake-fs removal', () => {
  it('removes the explicit caches that exist + scanned `.vite` dirs, de-duped, and prunes inside a match', async () => {
    // A tiny in-memory dir tree.
    const dirs = new Set<string>([
      '/dev/saga-dash/apps',
      '/dev/saga-dash/apps/web',
      '/dev/saga-dash/apps/web/dash',
      '/dev/saga-dash/apps/web/dash/node_modules',
      '/dev/saga-dash/apps/web/dash/node_modules/.vite',
      '/dev/saga-dash/apps/web/dash/node_modules/.vite/deps', // must be pruned (inside a match)
      '/dev/saga-dash/packages',
      '/dev/saga-dash/packages/ui',
      '/dev/saga-dash/packages/ui/.vite',
      '/dev/qboard/apps/web/connectv3/node_modules/.vite',
    ]);
    const children: Record<string, string[]> = {
      '/dev/saga-dash/apps': ['web'],
      '/dev/saga-dash/apps/web': ['dash'],
      '/dev/saga-dash/apps/web/dash': ['node_modules'],
      '/dev/saga-dash/apps/web/dash/node_modules': ['.vite'],
      '/dev/saga-dash/apps/web/dash/node_modules/.vite': ['deps'],
      '/dev/saga-dash/packages': ['ui'],
      '/dev/saga-dash/packages/ui': ['.vite'],
    };
    const removed: string[] = [];
    const clear = makeRealViteClear({
      exists: (p) => dirs.has(p),
      isDir: (p) => dirs.has(p),
      listDir: (p) => children[p] ?? [],
      remove: (p) => removed.push(p),
    });

    const res = await clear.clear(
      viteCachePaths({ sagaDashRoot: '/dev/saga-dash', qboardRoot: '/dev/qboard' }),
    );

    // The dash node_modules/.vite is both an explicit path AND found by the apps scan —
    // removed exactly once (de-dup). The package-level .vite and qboard connectv3 cache too.
    expect(res.removed).toEqual(removed);
    expect(new Set(removed)).toEqual(
      new Set([
        '/dev/saga-dash/apps/web/dash/node_modules/.vite',
        '/dev/saga-dash/packages/ui/.vite',
        '/dev/qboard/apps/web/connectv3/node_modules/.vite',
      ]),
    );
    // Prune: the `deps` dir INSIDE a matched .vite was never independently removed.
    expect(removed).not.toContain('/dev/saga-dash/apps/web/dash/node_modules/.vite/deps');
  });

  it('a missing explicit cache is simply not removed (best-effort)', async () => {
    const removed: string[] = [];
    const clear = makeRealViteClear({
      exists: () => false,
      isDir: () => false,
      listDir: () => [],
      remove: (p) => removed.push(p),
    });
    const res = await clear.clear({ explicit: ['/nope/.vite'], scanRoots: ['/also/nope'] });
    expect(res.removed).toEqual([]);
    expect(removed).toEqual([]);
  });
});

/**
 * build-clean unit tests (cold-start).
 *
 * Pure path builders + fake-fs removal. Cover: dist under both node-workspace roots is removed;
 * a package with no dist is skipped; node_modules only removed under `--reinstall`.
 */

import { describe, expect, it } from 'vitest';
import {
  distScanRoots,
  makeRealBuildCleaner,
  reinstallTargets,
} from '../build-clean.js';

describe('pure path builders', () => {
  it('distScanRoots = packages/node + apps/node under the repo', () => {
    expect(distScanRoots('/dev/rostering')).toEqual([
      '/dev/rostering/packages/node',
      '/dev/rostering/apps/node',
    ]);
  });
  it('tolerates a trailing slash', () => {
    expect(distScanRoots('/dev/rostering/')[0]).toBe('/dev/rostering/packages/node');
  });
  it('reinstallTargets = repo-root node_modules', () => {
    expect(reinstallTargets('/dev/rostering')).toEqual(['/dev/rostering/node_modules']);
  });
});

describe('makeRealBuildCleaner — fake-fs removal', () => {
  // in-memory tree: two node pkgs with dist, one without; a root node_modules.
  const dirs = new Set<string>([
    '/dev/r/packages/node',
    '/dev/r/packages/node/iam-db',
    '/dev/r/packages/node/iam-db/dist',
    '/dev/r/packages/node/no-build',
    '/dev/r/apps/node',
    '/dev/r/apps/node/iam-api',
    '/dev/r/apps/node/iam-api/dist',
    '/dev/r/node_modules',
  ]);
  const children: Record<string, string[]> = {
    '/dev/r/packages/node': ['iam-db', 'no-build'],
    '/dev/r/apps/node': ['iam-api'],
  };
  const makeCleaner = (removed: string[]) =>
    makeRealBuildCleaner({
      listDir: (p) => children[p] ?? [],
      isDir: (p) => dirs.has(p),
      remove: (p) => removed.push(p),
    });

  it('removes every existing dist, skips the pkg without one, leaves node_modules by default', async () => {
    const removed: string[] = [];
    const res = await makeCleaner(removed).clean('/dev/r', { reinstall: false });
    expect(new Set(res.removedDist)).toEqual(
      new Set(['/dev/r/packages/node/iam-db/dist', '/dev/r/apps/node/iam-api/dist']),
    );
    expect(res.removedModules).toEqual([]);
    expect(removed).not.toContain('/dev/r/node_modules');
  });

  it('--reinstall also removes the repo-root node_modules', async () => {
    const removed: string[] = [];
    const res = await makeCleaner(removed).clean('/dev/r', { reinstall: true });
    expect(res.removedModules).toEqual(['/dev/r/node_modules']);
    expect(removed).toContain('/dev/r/node_modules');
  });
});

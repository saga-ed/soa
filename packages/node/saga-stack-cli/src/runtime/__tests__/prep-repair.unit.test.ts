/**
 * soa#260 prep-repair unit tests. Real tmpdir fixtures (no mocks) exercise the
 * corruption detector + the node_modules wipe:
 *   - nodeModulesDirs finds root + workspace-pkg node_modules, excludes `.worktrees`.
 *   - hasStaleBinShim flags a dangling `.bin` symlink AND a shell shim referencing a
 *     `.pnpm/<pkg>@<ver>` dir that is gone; false when every ref resolves.
 *   - wipeNodeModules removes them all, `.worktrees` preserved.
 *   - repairStaleDeps wipes+true on the signature, false (and leaves the tree) otherwise.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasStaleBinShim, nodeModulesDirs, repairStaleDeps, wipeNodeModules } from '../prep-repair.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'prep-repair-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** mkdir -p a repo-relative dir. */
function mkdir(rel: string): string {
  const abs = join(root, rel);
  mkdirSync(abs, { recursive: true });
  return abs;
}
/** Write a repo-relative file, creating parents. */
function put(rel: string, contents: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, contents);
}

describe('nodeModulesDirs — root + workspace pkgs, .worktrees excluded', () => {
  it('finds every node_modules but never descends into one or into .worktrees', () => {
    mkdir('node_modules/.pnpm/foo@1.0.0'); // nested node_modules must NOT be walked into
    mkdir('apps/node/programs-api/node_modules');
    mkdir('packages/core/seed-ids/node_modules');
    mkdir('.worktrees/fix-1/node_modules'); // a sibling worktree — must be excluded
    const found = nodeModulesDirs(root).map((p) => p.replace(`${root}/`, '')).sort();
    expect(found).toEqual([
      'apps/node/programs-api/node_modules',
      'node_modules',
      'packages/core/seed-ids/node_modules',
    ]);
  });
});

describe('hasStaleBinShim — the corruption detector', () => {
  it('flags a DANGLING .bin symlink (its .pnpm target is gone)', () => {
    mkdir('node_modules/.bin');
    symlinkSync(join(root, 'node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc.js'),
      join(root, 'node_modules/.bin/tsc')); // target does not exist ⇒ dangling
    expect(hasStaleBinShim(root)).toBe(true);
  });

  it('flags a shell SHIM referencing a .pnpm/<pkg>@<ver> dir that no longer exists (program-hub#335)', () => {
    mkdir('node_modules/.pnpm/typescript@6.0.3'); // the version actually present
    put('apps/node/programs-api/node_modules/.bin/tsc',
      `#!/bin/sh\nexport NODE_PATH="${root}/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/node_modules"\nexec node ...\n`);
    expect(hasStaleBinShim(root)).toBe(true); // 5.9.3 dir is absent
  });

  it('is false when every .bin shim resolves to a present .pnpm dir', () => {
    mkdir('node_modules/.pnpm/typescript@6.0.3');
    put('node_modules/.bin/tsc',
      `#!/bin/sh\nexport NODE_PATH="${root}/node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/node_modules"\nexec node ...\n`);
    expect(hasStaleBinShim(root)).toBe(false);
  });

  it('is false for a repo with no .bin dirs at all', () => {
    mkdir('node_modules');
    expect(hasStaleBinShim(root)).toBe(false);
  });
});

describe('wipeNodeModules — thorough, .worktrees preserved', () => {
  it('removes root + workspace node_modules but leaves .worktrees intact', () => {
    mkdir('node_modules/.pnpm');
    mkdir('apps/node/programs-api/node_modules/.bin');
    mkdir('.worktrees/fix-1/node_modules');
    wipeNodeModules(root);
    expect(existsSync(join(root, 'node_modules'))).toBe(false);
    expect(existsSync(join(root, 'apps/node/programs-api/node_modules'))).toBe(false);
    expect(existsSync(join(root, '.worktrees/fix-1/node_modules'))).toBe(true); // preserved
  });
});

describe('repairStaleDeps — the prep seam', () => {
  it('wipes and returns true on the stale-shim signature', () => {
    mkdir('node_modules/.bin');
    symlinkSync(join(root, 'node_modules/.pnpm/gone@1.0.0/x'), join(root, 'node_modules/.bin/tsc'));
    expect(repairStaleDeps(root)).toBe(true);
    expect(existsSync(join(root, 'node_modules'))).toBe(false); // wiped
  });

  it('returns false and leaves node_modules when nothing is repairable', () => {
    mkdir('node_modules/.pnpm/typescript@6.0.3');
    put('node_modules/.bin/tsc', `#!/bin/sh\nexec node ${root}/node_modules/.pnpm/typescript@6.0.3/x\n`);
    expect(repairStaleDeps(root)).toBe(false);
    expect(existsSync(join(root, 'node_modules'))).toBe(true); // untouched
  });
});

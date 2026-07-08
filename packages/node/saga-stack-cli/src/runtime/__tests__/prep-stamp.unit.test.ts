/**
 * R1 prep freshness STAMP unit tests (soa#256).
 *
 * Real mkdtemp dirs stand in for repo checkouts so the git-layout resolution
 * (`.git/HEAD` ref file / detached / packed-refs / worktree `.git` FILE / no-git)
 * and the lockfile hashing exercise actual fs reads — no git spawn, no mocks. The
 * stamp read/write/compare round-trips through the same helpers production uses.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeFreshness,
  computeLockHash,
  readStamp,
  resolveHeadSha,
  stampMatches,
  writeStamp,
} from '../prep-stamp.js';

const SHA_A = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const SHA_B = '0987654321fedcba0987654321fedcba09876543';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'prep-stamp-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a file, creating parent dirs. */
function put(rel: string, contents: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, contents);
}

/** A `.git` directory whose HEAD points at a loose branch ref file. */
function gitDirWithBranch(branch: string, sha: string): void {
  put('.git/HEAD', `ref: refs/heads/${branch}\n`);
  put(`.git/refs/heads/${branch}`, `${sha}\n`);
}

describe('resolveHeadSha — HEAD resolution without spawning git', () => {
  it('reads a loose branch ref file (`ref: refs/heads/…` → refs/heads/…)', () => {
    gitDirWithBranch('main', SHA_A);
    expect(resolveHeadSha(root)).toBe(SHA_A);
  });

  it('reads a detached HEAD (raw sha in .git/HEAD)', () => {
    put('.git/HEAD', `${SHA_A}\n`);
    expect(resolveHeadSha(root)).toBe(SHA_A);
  });

  it('falls back to packed-refs when the loose ref file is absent', () => {
    put('.git/HEAD', 'ref: refs/heads/main\n');
    put(
      '.git/packed-refs',
      `# pack-refs with: peeled fully-peeled sorted\n${SHA_B} refs/heads/main\n${SHA_A} refs/tags/v1\n^${SHA_A}\n`,
    );
    expect(resolveHeadSha(root)).toBe(SHA_B);
  });

  it('resolves a linked worktree (.git is a FILE → gitdir → commondir refs)', () => {
    // Simulate `<main>/.git` as the commondir and a worktree gitdir under it.
    const commonDir = join(root, '.git');
    const wtGitDir = join(commonDir, 'worktrees', 'wt1');
    mkdirSync(wtGitDir, { recursive: true });
    // The worktree's checkout root has a `.git` FILE pointing at its gitdir.
    const wtRoot = mkdtempSync(join(tmpdir(), 'prep-stamp-wt-'));
    try {
      writeFileSync(join(wtRoot, '.git'), `gitdir: ${wtGitDir}\n`);
      writeFileSync(join(wtGitDir, 'HEAD'), 'ref: refs/heads/feature\n');
      writeFileSync(join(wtGitDir, 'commondir'), '../..\n'); // → <root>/.git
      // The branch ref lives in the COMMONDIR (shared refs), not the worktree gitdir.
      mkdirSync(join(commonDir, 'refs', 'heads'), { recursive: true });
      writeFileSync(join(commonDir, 'refs', 'heads', 'feature'), `${SHA_B}\n`);
      expect(resolveHeadSha(wtRoot)).toBe(SHA_B);
    } finally {
      rmSync(wtRoot, { recursive: true, force: true });
    }
  });

  it('worktree HEAD resolves via the commondir packed-refs when no loose ref', () => {
    const commonDir = join(root, '.git');
    const wtGitDir = join(commonDir, 'worktrees', 'wt1');
    mkdirSync(wtGitDir, { recursive: true });
    const wtRoot = mkdtempSync(join(tmpdir(), 'prep-stamp-wt-'));
    try {
      writeFileSync(join(wtRoot, '.git'), `gitdir: ${wtGitDir}\n`);
      writeFileSync(join(wtGitDir, 'HEAD'), 'ref: refs/heads/feature\n');
      writeFileSync(join(wtGitDir, 'commondir'), '../..\n');
      writeFileSync(join(commonDir, 'packed-refs'), `${SHA_A} refs/heads/feature\n`);
      expect(resolveHeadSha(wtRoot)).toBe(SHA_A);
    } finally {
      rmSync(wtRoot, { recursive: true, force: true });
    }
  });

  it('is `\'\'` when the dir is not a checkout (no .git)', () => {
    expect(resolveHeadSha(root)).toBe('');
  });

  it('is `\'\'` on an unrecognised .git file / unresolvable ref', () => {
    writeFileSync(join(root, '.git'), 'garbage not a gitdir line\n');
    expect(resolveHeadSha(root)).toBe('');
  });
});

describe('computeLockHash — sha256 of pnpm-lock.yaml', () => {
  it('hashes present lockfile content', () => {
    put('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    const expected = createHash('sha256').update('lockfileVersion: 9\n').digest('hex');
    expect(computeLockHash(root)).toBe(expected);
  });

  it('is `\'\'` when the lockfile is absent', () => {
    expect(computeLockHash(root)).toBe('');
  });

  it('changes when the lockfile content changes', () => {
    put('pnpm-lock.yaml', 'a\n');
    const before = computeLockHash(root);
    put('pnpm-lock.yaml', 'b\n');
    expect(computeLockHash(root)).not.toBe(before);
  });
});

describe('stamp read / write / compare', () => {
  it('writeStamp records the current { headSha, lockHash } and stampMatches confirms it', () => {
    gitDirWithBranch('main', SHA_A);
    put('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    mkdirSync(join(root, 'node_modules'), { recursive: true });

    writeStamp(root);

    const stamp = readStamp(root);
    expect(stamp).toEqual(computeFreshness(root));
    expect(stamp).toEqual({ headSha: SHA_A, lockHash: computeLockHash(root) });
    expect(stampMatches(root)).toBe(true);
  });

  it('stampMatches is false when the lockfile changes after stamping (case 3)', () => {
    gitDirWithBranch('main', SHA_A);
    put('pnpm-lock.yaml', 'old\n');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeStamp(root);
    expect(stampMatches(root)).toBe(true);

    put('pnpm-lock.yaml', 'new deps added\n'); // saga-dash / program-hub lockfile move
    expect(stampMatches(root)).toBe(false);
  });

  it('stampMatches is false when HEAD moves after stamping (case 1)', () => {
    gitDirWithBranch('main', SHA_A);
    put('pnpm-lock.yaml', 'lock\n');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeStamp(root);
    expect(stampMatches(root)).toBe(true);

    put('.git/refs/heads/main', `${SHA_B}\n`); // git pull moved HEAD (rostering)
    expect(stampMatches(root)).toBe(false);
  });

  it('stampMatches is false when the stamp is missing', () => {
    gitDirWithBranch('main', SHA_A);
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    expect(stampMatches(root)).toBe(false);
  });

  it('readStamp is null for an unparseable stamp (⇒ stampMatches false)', () => {
    gitDirWithBranch('main', SHA_A);
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.saga-stack-prep-stamp'), '{ not json');
    expect(readStamp(root)).toBeNull();
    expect(stampMatches(root)).toBe(false);
  });

  it('readStamp is null when a field is missing/non-string', () => {
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.saga-stack-prep-stamp'), JSON.stringify({ headSha: SHA_A }));
    expect(readStamp(root)).toBeNull();
  });

  it('writeStamp is a no-op when node_modules is absent (nothing installed)', () => {
    gitDirWithBranch('main', SHA_A);
    put('pnpm-lock.yaml', 'lock\n');
    writeStamp(root); // node_modules missing
    expect(readStamp(root)).toBeNull();
  });

  it('an unresolvable HEAD (headSha \'\') never self-matches ⇒ not fresh (soa#256 guard)', () => {
    // writeStamp still records headSha:'' when HEAD is unresolvable, but stampMatches must
    // REFUSE to treat an empty current HEAD as fresh — otherwise a stored '' would blindly
    // self-match and the HEAD dimension would go dark. In production stampMatches is reached
    // only for a checkout (isRepoBuilt short-circuits a true non-checkout to fresh before
    // consulting it), so this guards the exotic/corrupt-`.git` case where HEAD won't resolve.
    put('pnpm-lock.yaml', 'lock\n');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeStamp(root);
    expect(readStamp(root)?.headSha).toBe('');
    expect(stampMatches(root)).toBe(false);
  });

  it('worktree round-trip: stamp then advance the branch ref ⇒ flips true→false (soa#256)', () => {
    // A linked worktree (`.git` is a FILE) — the parallel-dev layout the fix must protect.
    // Bake a stamp, then advance the shared branch ref (a pull/ff) and assert it goes stale.
    // Also asserts the stamp records a REAL sha (not ''), catching a regression where
    // worktree stamping silently writes headSha='' and then always self-matches.
    const commonDir = join(root, '.git');
    const wtGitDir = join(commonDir, 'worktrees', 'wt1');
    mkdirSync(wtGitDir, { recursive: true });
    const wtRoot = mkdtempSync(join(tmpdir(), 'prep-stamp-wtrt-'));
    try {
      writeFileSync(join(wtRoot, '.git'), `gitdir: ${wtGitDir}\n`);
      writeFileSync(join(wtGitDir, 'HEAD'), 'ref: refs/heads/feature\n');
      writeFileSync(join(wtGitDir, 'commondir'), '../..\n'); // → <root>/.git
      mkdirSync(join(commonDir, 'refs', 'heads'), { recursive: true });
      writeFileSync(join(commonDir, 'refs', 'heads', 'feature'), `${SHA_A}\n`);
      writeFileSync(join(wtRoot, 'pnpm-lock.yaml'), 'lock\n');
      mkdirSync(join(wtRoot, 'node_modules'), { recursive: true });

      writeStamp(wtRoot);
      expect(readStamp(wtRoot)?.headSha).toBe(SHA_A); // resolved a real sha, not ''
      expect(stampMatches(wtRoot)).toBe(true);

      writeFileSync(join(commonDir, 'refs', 'heads', 'feature'), `${SHA_B}\n`); // ff advanced HEAD
      expect(stampMatches(wtRoot)).toBe(false);
    } finally {
      rmSync(wtRoot, { recursive: true, force: true });
    }
  });
});

/**
 * R1 fresh-skip GATE tests (soa#256) — the production `isRepoBuilt` predicate as
 * exposed by `BaseCommand.getPrepFreshCheck()`, run against real mkdtemp repo
 * layouts. "Built" now means artifacts present AND (soa#256) the repo is CURRENT:
 * a stamp whose { headSha, lockHash } matches the checkout's HEAD + lockfile. This
 * file is also the issue's mechanical VALIDATION — build a repo, move its HEAD /
 * lockfile, assert the predicate flips to false ⇒ prep re-runs.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BaseCommand } from '../base-command.js';
import { writeStamp } from '../runtime/prep-stamp.js';

const SHA_A = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const SHA_B = '0987654321fedcba0987654321fedcba09876543';

// `getPrepFreshCheck` returns `(root) => isRepoBuilt(root)` and never touches
// `this`, so calling it off the prototype exercises the real production predicate.
const isRepoBuilt = (
  BaseCommand.prototype as unknown as { getPrepFreshCheck(): (root: string) => boolean }
).getPrepFreshCheck();

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'prep-gate-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(rel: string, contents: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, contents);
}

/** A built node-workspace repo: node_modules + one package `dist/` + a checkout + lockfile. */
function buildNodeRepo(branch = 'main', sha = SHA_A): void {
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  mkdirSync(join(root, 'packages', 'node', 'foo', 'dist'), { recursive: true });
  put('.git/HEAD', `ref: refs/heads/${branch}\n`);
  put(`.git/refs/heads/${branch}`, `${sha}\n`);
  put('pnpm-lock.yaml', 'lockfileVersion: 9\n');
}

describe('isRepoBuilt — presence + soa#256 staleness gate', () => {
  it('built + matching stamp ⇒ fresh', () => {
    buildNodeRepo();
    writeStamp(root);
    expect(isRepoBuilt(root)).toBe(true);
  });

  it('missing dist (never built) ⇒ not fresh (presence fails first)', () => {
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    mkdirSync(join(root, 'packages', 'node', 'foo'), { recursive: true }); // workspace, no dist
    put('.git/HEAD', `ref: refs/heads/main\n`);
    put('.git/refs/heads/main', `${SHA_A}\n`);
    writeStamp(root);
    expect(isRepoBuilt(root)).toBe(false);
  });

  it('changed lockfile after build ⇒ stale ⇒ not fresh (the case-3 mechanical validation)', () => {
    buildNodeRepo();
    writeStamp(root);
    expect(isRepoBuilt(root)).toBe(true); // steady state
    put('pnpm-lock.yaml', 'lockfileVersion: 9\ndeps: added\n'); // git pull moved the lockfile
    expect(isRepoBuilt(root)).toBe(false); // prep re-runs
  });

  it('moved HEAD after build ⇒ stale ⇒ not fresh (the case-1 mechanical validation)', () => {
    buildNodeRepo();
    writeStamp(root);
    expect(isRepoBuilt(root)).toBe(true);
    put('.git/refs/heads/main', `${SHA_B}\n`); // git pull advanced HEAD
    expect(isRepoBuilt(root)).toBe(false);
  });

  it('missing stamp (first run after upgrade) ⇒ not fresh', () => {
    buildNodeRepo(); // artifacts present, but never stamped
    expect(isRepoBuilt(root)).toBe(false);
  });

  it('non-checkout (no .git) ⇒ presence-only fallback ⇒ fresh with no stamp', () => {
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    mkdirSync(join(root, 'packages', 'node', 'foo', 'dist'), { recursive: true });
    // no .git, no stamp — a deployed/tarball tree stays fresh on presence alone.
    expect(isRepoBuilt(root)).toBe(true);
  });

  it('frontend (no node workspace, no dist) ⇒ install + stamp ⇒ fresh', () => {
    // saga-dash shape: node_modules only, no packages/node|apps/node, so no dist.
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    put('.git/HEAD', `ref: refs/heads/main\n`);
    put('.git/refs/heads/main', `${SHA_A}\n`);
    put('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    expect(isRepoBuilt(root)).toBe(false); // installed but unstamped ⇒ not fresh yet
    writeStamp(root);
    expect(isRepoBuilt(root)).toBe(true); // stamped ⇒ fresh
  });
});

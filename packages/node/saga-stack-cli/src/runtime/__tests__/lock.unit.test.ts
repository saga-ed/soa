/**
 * M13-B realpath-keyed prep lock: exclusive acquire, who-holds-it failure,
 * stale-lock reaping, and release. Lock files land in the real tmpdir keyed by
 * a mkdtemp-unique repo path, so tests are hermetic per run.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeRealPrepLock, prepLockPath } from '../lock.js';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'lock-repo-'));
});

afterEach(() => {
  rmSync(prepLockPath(repo), { force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe('makeRealPrepLock', () => {
  it('acquires, writes the lock file, and release removes it', () => {
    const lock = makeRealPrepLock(1);
    const res = lock.acquire(repo);
    expect(res.ok).toBe(true);
    expect(existsSync(prepLockPath(repo))).toBe(true);
    if (res.ok) res.release();
    expect(existsSync(prepLockPath(repo))).toBe(false);
  });

  it('a second acquire fails fast with who-holds-it (live holder)', () => {
    const first = makeRealPrepLock(1).acquire(repo);
    expect(first.ok).toBe(true);
    const second = makeRealPrepLock(2).acquire(repo);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.holder).toMatch(new RegExp(`pid ${process.pid} \\(slot 1\\)`));
      expect(second.holder).toContain(repo);
    }
    if (first.ok) first.release();
  });

  it('a STALE lock (dead holder pid) is reaped and retaken', () => {
    // pid 2^22-ish beyond typical max: process.kill throws ESRCH ⇒ dead.
    writeFileSync(
      prepLockPath(repo),
      JSON.stringify({ pid: 3999999, slot: 3, root: repo, at: 'past' }),
    );
    const res = makeRealPrepLock(1).acquire(repo);
    expect(res.ok).toBe(true);
    if (res.ok) res.release();
  });

  it('an unreadable lock file counts as stale', () => {
    writeFileSync(prepLockPath(repo), '{corrupt');
    const res = makeRealPrepLock(1).acquire(repo);
    expect(res.ok).toBe(true);
    if (res.ok) res.release();
  });
});

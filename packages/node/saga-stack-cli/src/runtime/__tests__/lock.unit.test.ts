/**
 * M13-B realpath-keyed prep lock: exclusive acquire, who-holds-it failure,
 * stale-lock reaping, and release. Lock files land in the real tmpdir keyed by
 * a mkdtemp-unique repo path, so tests are hermetic per run.
 *
 * soa#266 follow-up: the abandoned-(STOPPED)-holder reclaim path — detection via
 * an injected `procState`, the kill+reclaim decision via `reclaimStopped`, and the
 * SIGKILL via an injected `killGroup` — so no real pids are signalled in tests.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRealPrepLock, prepLockPath } from '../lock.js';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'lock-repo-'));
});

afterEach(() => {
  rmSync(prepLockPath(repo), { force: true });
  rmSync(repo, { recursive: true, force: true });
});

/** Write a held lock owned by THIS process (so `pidAlive` is true) for the reclaim tests. */
function writeLiveHeldLock(): void {
  writeFileSync(
    prepLockPath(repo),
    JSON.stringify({ pid: process.pid, slot: 7, root: repo, at: '2026-07-08T14:52:52.673Z' }),
  );
}

describe('makeRealPrepLock', () => {
  it('acquires, writes the lock file, and release removes it', async () => {
    const lock = makeRealPrepLock(1);
    const res = await lock.acquire(repo);
    expect(res.ok).toBe(true);
    expect(existsSync(prepLockPath(repo))).toBe(true);
    if (res.ok) res.release();
    expect(existsSync(prepLockPath(repo))).toBe(false);
  });

  it('a second acquire fails fast with who-holds-it (live holder)', async () => {
    const first = await makeRealPrepLock(1).acquire(repo);
    expect(first.ok).toBe(true);
    const second = await makeRealPrepLock(2).acquire(repo);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.holder).toMatch(new RegExp(`pid ${process.pid} \\(slot 1\\)`));
      expect(second.holder).toContain(repo);
    }
    if (first.ok) first.release();
  });

  it('a STALE lock (dead holder pid) is reaped and retaken', async () => {
    // pid 2^22-ish beyond typical max: process.kill throws ESRCH ⇒ dead.
    writeFileSync(prepLockPath(repo), JSON.stringify({ pid: 3999999, slot: 3, root: repo, at: 'past' }));
    const res = await makeRealPrepLock(1).acquire(repo);
    expect(res.ok).toBe(true);
    if (res.ok) res.release();
  });

  it('an unreadable lock file counts as stale', async () => {
    writeFileSync(prepLockPath(repo), '{corrupt');
    const res = await makeRealPrepLock(1).acquire(repo);
    expect(res.ok).toBe(true);
    if (res.ok) res.release();
  });

  describe('abandoned (STOPPED) holder reclaim (soa#266)', () => {
    it('kills the stopped holder group and retakes when reclaimStopped approves', async () => {
      writeLiveHeldLock();
      const killGroup = vi.fn();
      const reclaimStopped = vi.fn(() => true);
      const res = await makeRealPrepLock(1, {
        procState: () => ({ state: 'T', pgid: 4242 }),
        reclaimStopped,
        killGroup,
      }).acquire(repo);

      expect(reclaimStopped).toHaveBeenCalledOnce();
      expect(killGroup).toHaveBeenCalledWith(4242, process.pid);
      expect(res.ok).toBe(true);
      if (res.ok) res.release();
    });

    it('awaits an async reclaimStopped decision', async () => {
      writeLiveHeldLock();
      const killGroup = vi.fn();
      const res = await makeRealPrepLock(1, {
        procState: () => ({ state: 'T', pgid: 4242 }),
        reclaimStopped: async () => true,
        killGroup,
      }).acquire(repo);
      expect(killGroup).toHaveBeenCalledOnce();
      expect(res.ok).toBe(true);
      if (res.ok) res.release();
    });

    it('does NOT kill when reclaimStopped declines — fails fast with a STOPPED-tagged message', async () => {
      writeLiveHeldLock();
      const killGroup = vi.fn();
      const res = await makeRealPrepLock(1, {
        procState: () => ({ state: 'T', pgid: 4242 }),
        reclaimStopped: () => false,
        killGroup,
      }).acquire(repo);

      expect(killGroup).not.toHaveBeenCalled();
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.holder).toMatch(/STOPPED\/abandoned/);
        expect(res.holder).toContain('kill -9 -4242');
      }
    });

    it('never offers a RUNNING holder for reclaim — fails fast, unchanged', async () => {
      writeLiveHeldLock();
      const reclaimStopped = vi.fn(() => true);
      const killGroup = vi.fn();
      const res = await makeRealPrepLock(1, {
        procState: () => ({ state: 'R', pgid: 4242 }),
        reclaimStopped,
        killGroup,
      }).acquire(repo);

      expect(reclaimStopped).not.toHaveBeenCalled();
      expect(killGroup).not.toHaveBeenCalled();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.holder).not.toMatch(/STOPPED/);
    });

    it('with no reclaim policy, a stopped holder still fails fast (no auto-kill)', async () => {
      writeLiveHeldLock();
      const killGroup = vi.fn();
      const res = await makeRealPrepLock(1, {
        procState: () => ({ state: 'T', pgid: 4242 }),
        killGroup,
      }).acquire(repo);
      expect(killGroup).not.toHaveBeenCalled();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.holder).toMatch(/STOPPED\/abandoned/);
    });
  });
});

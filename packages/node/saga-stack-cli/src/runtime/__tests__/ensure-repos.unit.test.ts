/**
 * `ensureReposNative` unit tests (M11 — bootstrap step 1).
 *
 * Drives the confirm/abort/clone decision with a FAKE git.clone + a FAKE confirm seam +
 * a fake `.git` existence predicate — no real git, network, or TTY. Asserts bootstrap.sh's
 * exact confirm semantics: present ⇒ no clone; missing+--yes ⇒ clone; missing+no-TTY ⇒
 * ABORT (never clones); missing+TTY+'n' ⇒ abort; and the worktree-safe `.git` marker.
 */

import { describe, expect, it } from 'vitest';
import {
  REQUIRED_BOOTSTRAP_REPOS,
  bootstrapRepos,
  cloneUrl,
  ensureReposNative,
} from '../ensure-repos.js';
import type { ConfirmSeam, EnsureRepo } from '../ensure-repos.js';

/** A git seam whose `clone` records calls and returns a scripted result. */
function fakeGit(ok = true): { git: { clone: (u: string, d: string) => Promise<boolean> }; clones: string[] } {
  const clones: string[] = [];
  return {
    git: {
      async clone(url: string, dir: string): Promise<boolean> {
        clones.push(`${url} → ${dir}`);
        return ok;
      },
    },
    clones,
  };
}

/** A confirm seam with a fixed TTY answer. `prompt` returns `answer` and counts calls. */
function fakeConfirm(isTTY: boolean, answer = false): { confirm: ConfirmSeam; readonly prompts: number } {
  const state = { prompts: 0 };
  const confirm: ConfirmSeam = {
    isTTY: () => isTTY,
    async prompt(): Promise<boolean> {
      state.prompts += 1;
      return answer;
    },
  };
  return {
    confirm,
    get prompts(): number {
      return state.prompts;
    },
  };
}

const REPOS: EnsureRepo[] = [
  { name: 'soa', path: '/dev/soa', url: cloneUrl('soa') },
  { name: 'rostering', path: '/dev/rostering', url: cloneUrl('rostering') },
];

describe('REQUIRED_BOOTSTRAP_REPOS — derived from the manifest, excludes coach/fleek', () => {
  it('is exactly bootstrap.sh\'s 7 required repos, in order', () => {
    expect(REQUIRED_BOOTSTRAP_REPOS).toEqual([
      'SOA',
      'ROSTERING',
      'PROGRAM_HUB',
      'SAGA_DASH',
      'SDS',
      'QBOARD',
      'RTSM',
    ]);
    expect(REQUIRED_BOOTSTRAP_REPOS).not.toContain('COACH');
    expect(REQUIRED_BOOTSTRAP_REPOS).not.toContain('FLEEK');
  });

  it('bootstrapRepos resolves dir names + SSH clone URLs (SDS ⇒ student-data-system)', () => {
    const repos = bootstrapRepos({ dev: '/fixed/dev' });
    expect(repos.map((r) => r.name)).toEqual([
      'soa',
      'rostering',
      'program-hub',
      'saga-dash',
      'student-data-system',
      'qboard',
      'rtsm',
    ]);
    const sds = repos.find((r) => r.name === 'student-data-system');
    expect(sds?.path).toBe('/fixed/dev/student-data-system');
    expect(sds?.url).toBe('git@github.com:saga-ed/student-data-system.git');
  });
});

describe('ensureReposNative — confirm/abort/clone semantics', () => {
  it('all present (dir `.git` AND a worktree `.git` FILE) ⇒ NO clone', async () => {
    const { git, clones } = fakeGit();
    // both markers "exist" — one a dir, one a worktree pointer FILE; existsSync sees both.
    const res = await ensureReposNative(REPOS, { yes: false }, {
      git,
      confirm: fakeConfirm(true, false).confirm,
      pathExists: () => true,
    });
    expect(res.ok).toBe(true);
    expect(res.present).toEqual(['soa', 'rostering']);
    expect(res.cloned).toEqual([]);
    expect(clones).toHaveLength(0);
  });

  it('a worktree `.git` FILE counts as present (marker is existsSync, not is-a-dir)', async () => {
    const { git, clones } = fakeGit();
    // simulate: /dev/soa/.git is a FILE (worktree pointer) — still "exists".
    const res = await ensureReposNative([REPOS[0] as EnsureRepo], { yes: false }, {
      git,
      confirm: fakeConfirm(false).confirm, // no TTY — but nothing is missing, so never consulted
      pathExists: (p) => p === '/dev/soa/.git',
    });
    expect(res.ok).toBe(true);
    expect(res.cloned).toEqual([]);
    expect(clones).toHaveLength(0);
  });

  it('missing + --yes ⇒ CLONES (auto-confirm, no prompt)', async () => {
    const { git, clones } = fakeGit();
    const cf = fakeConfirm(true, false); // would say 'n' if asked — must NOT be asked
    const res = await ensureReposNative(REPOS, { yes: true }, {
      git,
      confirm: cf.confirm,
      pathExists: () => false, // both missing
    });
    expect(res.ok).toBe(true);
    expect(res.cloned).toEqual(['soa', 'rostering']);
    expect(clones).toEqual([
      'git@github.com:saga-ed/soa.git → /dev/soa',
      'git@github.com:saga-ed/rostering.git → /dev/rostering',
    ]);
    expect(cf.prompts).toBe(0); // --yes never prompts
  });

  it('missing + NO TTY + no --yes ⇒ ABORTS and NEVER clones (bootstrap.sh `! -t 0`)', async () => {
    const { git, clones } = fakeGit();
    const res = await ensureReposNative(REPOS, { yes: false }, {
      git,
      confirm: fakeConfirm(false).confirm, // no TTY
      pathExists: () => false,
    });
    expect(res.ok).toBe(false);
    expect(res.aborted).toBe('no-tty');
    expect(res.cloned).toEqual([]);
    expect(clones).toHaveLength(0); // the load-bearing invariant: never clone unprompted
    expect(res.needed).toEqual(['soa', 'rostering']);
  });

  it('missing + TTY + user says "n" ⇒ ABORTS (declined), no clone', async () => {
    const { git, clones } = fakeGit();
    const cf = fakeConfirm(true, false); // TTY, answer 'n'
    const res = await ensureReposNative(REPOS, { yes: false }, {
      git,
      confirm: cf.confirm,
      pathExists: () => false,
    });
    expect(res.ok).toBe(false);
    expect(res.aborted).toBe('declined');
    expect(clones).toHaveLength(0);
    expect(cf.prompts).toBe(1); // it DID prompt
  });

  it('missing + TTY + user says "y" ⇒ clones', async () => {
    const { git, clones } = fakeGit();
    const cf = fakeConfirm(true, true); // TTY, answer 'y'
    const res = await ensureReposNative(REPOS, { yes: false }, {
      git,
      confirm: cf.confirm,
      pathExists: () => false,
    });
    expect(res.ok).toBe(true);
    expect(res.cloned).toEqual(['soa', 'rostering']);
    expect(clones).toHaveLength(2);
  });

  it('a clone FAILURE aborts with the offending repo (clone-failed)', async () => {
    const { git } = fakeGit(false); // clone returns false
    const res = await ensureReposNative(REPOS, { yes: true }, {
      git,
      confirm: fakeConfirm(true, true).confirm,
      pathExists: () => false,
    });
    expect(res.ok).toBe(false);
    expect(res.aborted).toBe('clone-failed');
    expect(res.failedRepo).toBe('soa'); // stopped at the first
  });

  it('only the MISSING subset is cloned (present ones are skipped)', async () => {
    const { git, clones } = fakeGit();
    const res = await ensureReposNative(REPOS, { yes: true }, {
      git,
      confirm: fakeConfirm(true, true).confirm,
      pathExists: (p) => p === '/dev/soa/.git', // soa present, rostering missing
    });
    expect(res.present).toEqual(['soa']);
    expect(res.cloned).toEqual(['rostering']);
    expect(clones).toEqual(['git@github.com:saga-ed/rostering.git → /dev/rostering']);
  });

  it('notify receives the human lines (needed list + cloning)', async () => {
    const { git } = fakeGit();
    const lines: string[] = [];
    await ensureReposNative(REPOS, { yes: true }, {
      git,
      confirm: fakeConfirm(true, true).confirm,
      pathExists: () => false,
      notify: (m) => lines.push(m),
    });
    expect(lines.some((l) => l.includes('need cloning'))).toBe(true);
    expect(lines.some((l) => l.includes('cloning soa'))).toBe(true);
  });
});

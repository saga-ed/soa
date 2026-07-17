/**
 * Slot claims: the actor-resolution ladder (SS_ACTOR > claude-ancestry >
 * user@host:tty), the never-throws advisory writer + sourceAtLaunch folding,
 * and the null-on-anything-suspect reader with read-time pid liveness.
 */

import { describe, expect, it } from 'vitest';
import type { SlotClaim } from '../claim.js';
import { CLAIM_FILE, makeClaimReader, makeClaimWriter, resolveActor } from '../claim.js';
import type { GitRunner } from '../git.js';

/** A `/proc/<pid>/stat` blob whose ppid (field 2 after the comm `)`) is `ppid`. */
function statBlob(pid: number, ppid: number): string {
  return `${pid} (node) S ${ppid} ${pid} ${pid} 34820 ${pid} 4194304 1234`;
}

describe('resolveActor', () => {
  it('a non-empty SS_ACTOR wins without touching /proc', () => {
    let procAsked = false;
    const resolved = resolveActor({
      env: { SS_ACTOR: '  coach-aug3-training ' },
      readProcStat: () => {
        procAsked = true;
        return null;
      },
      readProcCmdline: () => null,
    });
    expect(resolved).toEqual({ actor: 'coach-aug3-training', actorSource: 'env' });
    expect(procAsked).toBe(false);
  });

  it('finds a claude ancestor two hops up the ppid chain', () => {
    // 4100 (ss) → 4000 (a shell) → 3900 (claude).
    const stats: Record<number, string> = {
      4100: statBlob(4100, 4000),
      4000: statBlob(4000, 3900),
      3900: statBlob(3900, 1),
    };
    const cmdlines: Record<number, string> = {
      4100: 'node\0/repo/bin/run.js\0stack:up',
      4000: '/bin/bash\0-c\0ss stack:up',
      3900: '/usr/local/bin/claude\0--resume',
    };
    const resolved = resolveActor({
      env: {},
      pid: 4100,
      readProcStat: (pid) => stats[pid] ?? null,
      readProcCmdline: (pid) => cmdlines[pid] ?? null,
    });
    expect(resolved).toEqual({ actor: 'claude:3900', actorSource: 'claude' });
  });

  it('parses ppid past a comm containing spaces and ")" (the lastIndexOf guard)', () => {
    // The comm field is parenthesised and may itself contain spaces and ')' —
    // a naive indexOf(')') / split(' ') parse would misread ppid here and
    // truncate the walk before reaching the claude ancestor.
    const stats: Record<number, string> = {
      5100: `5100 (tmux: server) (v3) S 5000 5100 5100 34820 5100 4194304 1234`,
      5000: statBlob(5000, 1),
    };
    const cmdlines: Record<number, string> = {
      5100: '/usr/bin/tmux\0new-session',
      5000: '/usr/local/bin/claude\0--resume',
    };
    const resolved = resolveActor({
      env: {},
      pid: 5100,
      readProcStat: (pid) => stats[pid] ?? null,
      readProcCmdline: (pid) => cmdlines[pid] ?? null,
    });
    expect(resolved).toEqual({ actor: 'claude:5000', actorSource: 'claude' });
  });

  it('terminates on a ppid cycle and falls back', () => {
    const stats: Record<number, string> = {
      10: statBlob(10, 20),
      20: statBlob(20, 10), // cycle back
    };
    const resolved = resolveActor({
      env: {},
      pid: 10,
      readProcStat: (pid) => stats[pid] ?? null,
      readProcCmdline: () => '/bin/bash',
      username: () => 'skelly',
      hostname: () => 'devbox',
      ttyName: () => null,
    });
    expect(resolved).toEqual({ actor: 'skelly@devbox', actorSource: 'fallback' });
  });

  it('terminates on an unreadable /proc entry and falls back', () => {
    const resolved = resolveActor({
      env: {},
      pid: 4100,
      readProcStat: () => null, // walk cannot move past the first pid
      readProcCmdline: () => null,
      username: () => 'skelly',
      hostname: () => 'devbox',
      ttyName: () => null,
    });
    expect(resolved.actorSource).toBe('fallback');
  });

  it('the fallback carries the tty when there is one, and omits it off-tty', () => {
    const base = {
      env: {},
      pid: 2,
      readProcStat: () => null,
      readProcCmdline: () => null,
      username: () => 'skelly',
      hostname: () => 'devbox',
    };
    expect(resolveActor({ ...base, ttyName: () => 'pts/4' })).toEqual({
      actor: 'skelly@devbox:pts/4',
      actorSource: 'fallback',
    });
    expect(resolveActor({ ...base, ttyName: () => null })).toEqual({
      actor: 'skelly@devbox',
      actorSource: 'fallback',
    });
  });
});

/** A branch+dirty-only fake — the writer touches no other GitRunner verb. */
function fakeGit(over: Partial<GitRunner> = {}): GitRunner {
  return {
    branchShowCurrent: async () => 'main',
    statusPorcelain: async () => '',
    ...over,
  } as unknown as GitRunner;
}

describe('makeClaimWriter', () => {
  const baseDeps = {
    env: { SS_ACTOR: 'tester' }, // keep resolution off the real /proc
    now: () => '2026-07-16T12:00:00.000Z',
    pid: 4242,
    cwd: () => '/work',
  };

  it('writes a full claim to <stateDir>/claim.json', async () => {
    const written: Record<string, string> = {};
    const writer = makeClaimWriter({
      ...baseDeps,
      git: fakeGit({ statusPorcelain: async () => ' M src/app.ts\n?? notes.txt\n' }),
      headShaOf: () => 'abc1234',
      dirExists: () => true,
      writeFile: (path, data) => {
        written[path] = data;
      },
    });
    await writer.write({
      slot: 2,
      stateDir: '/state/s2',
      command: 'ss stack:up --slot 2',
      set: 'aug3',
      repoRoots: { soa: '/repos/soa' },
    });

    const raw = written[`/state/s2/${CLAIM_FILE}`];
    expect(raw).toBeDefined();
    expect(raw!.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw!)).toEqual({
      version: 1,
      actor: 'tester',
      actorSource: 'env',
      pid: 4242,
      command: 'ss stack:up --slot 2',
      at: '2026-07-16T12:00:00.000Z',
      cwd: '/work',
      slot: 2,
      set: 'aug3',
      sourceAtLaunch: { soa: { branch: 'main', headSha: 'abc1234', dirty: true } },
    });
  });

  it('sourceAtLaunch skips roots that do not exist on disk', async () => {
    const written: Record<string, string> = {};
    const writer = makeClaimWriter({
      ...baseDeps,
      git: fakeGit(),
      headShaOf: () => 'abc1234',
      dirExists: (p) => p === '/repos/soa',
      writeFile: (path, data) => {
        written[path] = data;
      },
    });
    await writer.write({
      slot: 0,
      stateDir: '/state/s0',
      command: 'ss stack:up',
      repoRoots: { soa: '/repos/soa', coach: '/repos/coach' },
    });

    const claim = JSON.parse(written[`/state/s0/${CLAIM_FILE}`]!) as SlotClaim;
    expect(Object.keys(claim.sourceAtLaunch)).toEqual(['soa']);
    expect(claim.set).toBeUndefined();
  });

  it('a throwing git probe costs only its own repo entry, not the claim', async () => {
    const written: Record<string, string> = {};
    const writer = makeClaimWriter({
      ...baseDeps,
      git: fakeGit({
        branchShowCurrent: async (repoPath) => {
          if (repoPath === '/repos/coach') throw new Error('boom');
          return 'main';
        },
      }),
      headShaOf: () => 'abc1234',
      dirExists: () => true,
      writeFile: (path, data) => {
        written[path] = data;
      },
    });
    await writer.write({
      slot: 1,
      stateDir: '/state/s1',
      command: 'ss stack:up --slot 1',
      repoRoots: { soa: '/repos/soa', coach: '/repos/coach' },
    });

    const claim = JSON.parse(written[`/state/s1/${CLAIM_FILE}`]!) as SlotClaim;
    expect(Object.keys(claim.sourceAtLaunch)).toEqual(['soa']);
  });

  it('never throws — a failing writeFile folds to a silent no-op', async () => {
    const writer = makeClaimWriter({
      ...baseDeps,
      git: fakeGit(),
      headShaOf: () => '',
      dirExists: () => true,
      writeFile: () => {
        throw new Error('EACCES');
      },
    });
    await expect(
      writer.write({ slot: 3, stateDir: '/nope', command: 'ss stack:up --slot 3', repoRoots: {} }),
    ).resolves.toBeUndefined();
  });
});

describe('makeClaimReader', () => {
  const validClaim: SlotClaim = {
    version: 1,
    actor: 'claude:3900',
    actorSource: 'claude',
    pid: 4242,
    command: 'ss stack:up --slot 2',
    at: '2026-07-16T12:00:00.000Z',
    cwd: '/work',
    slot: 2,
    sourceAtLaunch: {},
  };

  it('reads a valid claim and reports the writer pid live', () => {
    const reader = makeClaimReader({
      readFile: (path) => (path === `/state/s2/${CLAIM_FILE}` ? JSON.stringify(validClaim) : null),
      pidAlive: (pid) => pid === 4242,
    });
    expect(reader.read('/state/s2')).toEqual({ claim: validClaim, live: true });
  });

  it('live=false when the writer pid is gone (stale claim)', () => {
    const reader = makeClaimReader({
      readFile: () => JSON.stringify(validClaim),
      pidAlive: () => false,
    });
    expect(reader.read('/state/s2')?.live).toBe(false);
  });

  it('null on a missing file', () => {
    const reader = makeClaimReader({ readFile: () => null, pidAlive: () => true });
    expect(reader.read('/state/s2')).toBeNull();
  });

  it('null on garbage JSON', () => {
    const reader = makeClaimReader({ readFile: () => '{not json', pidAlive: () => true });
    expect(reader.read('/state/s2')).toBeNull();
  });

  it('null on an unknown claim version', () => {
    const reader = makeClaimReader({
      readFile: () => JSON.stringify({ ...validClaim, version: 2 }),
      pidAlive: () => true,
    });
    expect(reader.read('/state/s2')).toBeNull();
  });

  it('null on a shape-invalid body', () => {
    const reader = makeClaimReader({
      readFile: () => JSON.stringify({ version: 1, actor: 42 }),
      pidAlive: () => true,
    });
    expect(reader.read('/state/s2')).toBeNull();
  });
});

/**
 * R1 build/prep-pass unit tests (M8 native prep pass; up.sh prep 992-1039).
 *
 * Inject a fake Runner + fresh predicate and assert the executed prep PLAN: which
 * closure repos, in canonical order, get `pnpm install` → `db:generate` (their
 * `*-db` packages) → `pnpm build`; SAGA_DASH is install-only; `--skip-prep`
 * short-circuits; a fresh repo is skipped; a build failure aborts. NO real pnpm.
 */

import { describe, expect, it } from 'vitest';
import type { DbId, RepoKey, ServiceId } from '../../core/manifest/index.js';
import type { RunResult, Runner, ScriptInvocation } from '../exec.js';
import { FATAL_BUILD_REPOS, INSTALL_ONLY_REPOS, prepClosure } from '../prep.js';

const REPO_ROOTS = {
  SOA: '/dev/soa',
  ROSTERING: '/dev/rostering',
  PROGRAM_HUB: '/dev/program-hub',
  SAGA_DASH: '/dev/saga-dash',
  COACH: '/dev/coach',
  SDS: '/dev/student-data-system',
  QBOARD: '/dev/qboard',
  RTSM: '/dev/rtsm',
  FLEEK: '/dev/fleek',
} as Record<RepoKey, string>;

function fakeRunner(failCwd?: string): { runner: Runner; calls: ScriptInvocation[] } {
  const calls: ScriptInvocation[] = [];
  const runner: Runner = {
    async run(spec): Promise<RunResult> {
      calls.push(spec);
      return { code: failCwd && spec.cwd === failCwd ? 1 : 0 };
    },
  };
  return { runner, calls };
}

/** A runner that fails exactly the invocations matching `fail(spec)` (else succeeds). */
function runnerFailingWhen(fail: (spec: ScriptInvocation) => boolean): { runner: Runner; calls: ScriptInvocation[] } {
  const calls: ScriptInvocation[] = [];
  const runner: Runner = {
    async run(spec): Promise<RunResult> {
      calls.push(spec);
      return { code: fail(spec) ? 1 : 0 };
    },
  };
  return { runner, calls };
}

const NEVER_FRESH = (): boolean => false;

describe('prepClosure — closure-scoped install/build/db:generate (R1)', () => {
  it('per repo: install → db:generate (its *-db pkgs) → build, in canonical repo order', async () => {
    const { runner } = fakeRunner();
    const res = await prepClosure({
      services: ['iam-api', 'programs-api', 'scheduling-api'] as ServiceId[],
      dbs: ['iam_local', 'iam_pii_local', 'programs', 'scheduling'] as DbId[],
      repoRoots: REPO_ROOTS,
      runner,
      isFresh: NEVER_FRESH,
    });

    expect(res.ok).toBe(true);
    expect(res.steps.map((s) => `${s.repo}:${s.kind}:${s.argv.join(' ')}`)).toEqual([
      // ROSTERING: install, then db:generate for iam-db + iam-pii-db, then build.
      'ROSTERING:install:install',
      'ROSTERING:db:generate:db:generate',
      'ROSTERING:db:generate:db:generate',
      'ROSTERING:build:build',
      // PROGRAM_HUB: programs/scheduling are apps (NOT *-db) ⇒ no db:generate.
      'PROGRAM_HUB:install:install',
      'PROGRAM_HUB:build:build',
    ]);
    // db:generate cwds are the *-db PACKAGE dirs.
    const gens = res.steps.filter((s) => s.kind === 'db:generate').map((s) => s.cwd);
    expect(gens).toEqual([
      '/dev/rostering/packages/node/iam-db',
      '/dev/rostering/packages/node/iam-pii-db',
    ]);
  });

  it('SAGA_DASH is install-ONLY (vite dev, no build)', async () => {
    const { runner } = fakeRunner();
    const res = await prepClosure({
      services: ['saga-dash'] as ServiceId[],
      dbs: [],
      repoRoots: REPO_ROOTS,
      runner,
      isFresh: NEVER_FRESH,
    });
    expect(res.steps.map((s) => `${s.repo}:${s.kind}`)).toEqual(['SAGA_DASH:install']);
    expect(INSTALL_ONLY_REPOS.has('SAGA_DASH')).toBe(true);
  });

  it('coach: coach-db gets db:generate, then coach builds (dist for coach-api)', async () => {
    const { runner } = fakeRunner();
    const res = await prepClosure({
      services: ['coach-api'] as ServiceId[],
      dbs: ['coach_api'] as DbId[],
      repoRoots: REPO_ROOTS,
      runner,
      isFresh: NEVER_FRESH,
    });
    expect(res.steps.map((s) => `${s.repo}:${s.kind}`)).toEqual([
      'COACH:install',
      'COACH:db:generate',
      'COACH:build',
    ]);
    expect(res.steps.find((s) => s.kind === 'db:generate')?.cwd).toBe('/dev/coach/packages/node/coach-db');
  });

  it('--skip-prep short-circuits the WHOLE pass (no steps, skippedPrep flag)', async () => {
    const { runner, calls } = fakeRunner();
    const res = await prepClosure({
      services: ['iam-api', 'programs-api'] as ServiceId[],
      dbs: ['iam_local', 'programs'] as DbId[],
      repoRoots: REPO_ROOTS,
      runner,
      skipPrep: true,
    });
    expect(res.skippedPrep).toBe(true);
    expect(res.steps).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('M13-B: a HELD build lock fails the pass fast with who-holds-it; fresh repos never lock', async () => {
    const { runner } = fakeRunner();
    const acquired: string[] = [];
    const released: string[] = [];
    const res = await prepClosure({
      services: ['iam-api', 'programs-api'] as ServiceId[],
      dbs: [] as DbId[],
      repoRoots: REPO_ROOTS,
      runner,
      isFresh: (root) => root === '/dev/rostering', // rostering fresh ⇒ must NOT acquire
      lock: {
        async acquire(root) {
          acquired.push(root);
          if (root === '/dev/program-hub') {
            return { ok: false, holder: 'pid 123 (slot 2) has been building /dev/program-hub since T' };
          }
          return { ok: true, release: () => released.push(root) };
        },
      },
    });
    expect(res.ok).toBe(false);
    expect(res.failed?.kind).toBe('lock');
    expect(res.failed?.detail).toContain('pid 123 (slot 2)');
    expect(acquired).toEqual(['/dev/program-hub']); // fresh rostering skipped the lock entirely
    expect(released).toEqual([]); // failed acquire has nothing to release
  });

  it('M13-B: the lock is RELEASED after a successful repo prep', async () => {
    const { runner } = fakeRunner();
    const released: string[] = [];
    const res = await prepClosure({
      services: ['iam-api'] as ServiceId[],
      dbs: [] as DbId[],
      repoRoots: REPO_ROOTS,
      runner,
      lock: { acquire: async (root) => ({ ok: true, release: () => released.push(root) }) },
    });
    expect(res.ok).toBe(true);
    expect(released).toEqual(['/dev/rostering']);
  });

  it('a FRESH repo is skipped (idempotent re-up); a stale one still preps', async () => {
    const { runner } = fakeRunner();
    const res = await prepClosure({
      services: ['iam-api', 'programs-api'] as ServiceId[],
      dbs: ['iam_local', 'programs'] as DbId[],
      repoRoots: REPO_ROOTS,
      runner,
      isFresh: (root) => root === '/dev/rostering', // rostering fresh, program-hub not
    });
    expect(res.freshRepos).toEqual(['ROSTERING']);
    // only PROGRAM_HUB ran (install + build).
    expect(res.steps.every((s) => s.repo === 'PROGRAM_HUB')).toBe(true);
    expect(res.steps.map((s) => s.kind)).toEqual(['install', 'build']);
  });

  it('absent isFresh ⇒ always preps (cold-checkout default)', async () => {
    const { runner } = fakeRunner();
    const res = await prepClosure({
      services: ['rtsm-api'] as ServiceId[],
      dbs: [],
      repoRoots: REPO_ROOTS,
      runner,
    });
    expect(res.freshRepos).toEqual([]);
    expect(res.steps.map((s) => `${s.repo}:${s.kind}`)).toEqual(['RTSM:install', 'RTSM:build']);
  });

  it('a build failure aborts the pass with ok:false + the failing step', async () => {
    const { runner } = fakeRunner('/dev/rostering'); // rostering build (cwd=root) fails
    const res = await prepClosure({
      services: ['iam-api', 'programs-api'] as ServiceId[],
      dbs: ['iam_local'] as DbId[],
      repoRoots: REPO_ROOTS,
      runner,
      isFresh: NEVER_FRESH,
    });
    expect(res.ok).toBe(false);
    // install (cwd=root) also "fails" in this fake since it shares the root cwd —
    // so the pass aborts at ROSTERING's first root-cwd step (install is FATAL).
    expect(res.failed?.repo).toBe('ROSTERING');
  });

  it('BLOCKER-B: db:generate scan generates EVERY declared *-db pkg in the repo, not just closure DBs', async () => {
    const { runner } = fakeRunner();
    // Scan reports FIVE db:generate packages in SDS — but the closure only owns
    // ads_adm_local (ads-adm-db). All five must still be generated (the whole-workspace
    // build needs each sibling's client).
    const scanned = [
      'packages/node/ads-adm-db',
      'packages/node/chat-db',
      'packages/node/insights-db',
      'packages/node/ledger-db',
      'packages/node/transcripts-db',
    ];
    const res = await prepClosure({
      services: ['ads-adm-api'] as ServiceId[],
      dbs: ['ads_adm_local'] as DbId[],
      repoRoots: REPO_ROOTS,
      runner,
      isFresh: NEVER_FRESH,
      dbGenerateScan: (root) => (root === '/dev/student-data-system' ? scanned : []),
    });
    expect(res.ok).toBe(true);
    const gens = res.steps.filter((s) => s.repo === 'SDS' && s.kind === 'db:generate').map((s) => s.cwd);
    expect(gens).toEqual(scanned.map((d) => `/dev/student-data-system/${d}`));
    // …and the build runs AFTER all five generates.
    const kinds = res.steps.filter((s) => s.repo === 'SDS').map((s) => s.kind);
    expect(kinds).toEqual(['install', 'db:generate', 'db:generate', 'db:generate', 'db:generate', 'db:generate', 'build']);
  });

  it('MAJOR-C: a NON-fatal repo build failure (SDS) is a warning, the pass continues (ok:true)', async () => {
    const { runner } = runnerFailingWhen((s) => s.cwd === '/dev/student-data-system' && s.args[0] === 'build');
    const res = await prepClosure({
      services: ['ads-adm-api'] as ServiceId[],
      dbs: ['ads_adm_local'] as DbId[],
      repoRoots: REPO_ROOTS,
      runner,
      isFresh: NEVER_FRESH,
    });
    expect(res.ok).toBe(true);
    expect(res.failed).toBeUndefined();
    expect(res.warnings.map((w) => `${w.repo}:${w.kind}`)).toEqual(['SDS:build']);
    // SDS still installed + built (attempted) — the build step is recorded in steps.
    expect(res.steps.some((s) => s.repo === 'SDS' && s.kind === 'build')).toBe(true);
  });

  it('MAJOR-C: a FATAL repo build failure (COACH) aborts the pass (ok:false)', async () => {
    const { runner } = runnerFailingWhen((s) => s.cwd === '/dev/coach' && s.args[0] === 'build');
    const res = await prepClosure({
      services: ['coach-api'] as ServiceId[],
      dbs: ['coach_api'] as DbId[],
      repoRoots: REPO_ROOTS,
      runner,
      isFresh: NEVER_FRESH,
    });
    expect(res.ok).toBe(false);
    expect(res.failed).toMatchObject({ repo: 'COACH', kind: 'build' });
    expect(FATAL_BUILD_REPOS.has('COACH')).toBe(true);
  });

  it('FLIP 4: a 401 install failure triggers `pnpm co:login` + ONE retry, then proceeds', async () => {
    // install #1 answers a CodeArtifact 401 (unauthorized), co:login succeeds, install
    // #2 (the retry) succeeds → the pass proceeds to build.
    let installs = 0;
    const calls: ScriptInvocation[] = [];
    const runner: Runner = {
      async run(spec): Promise<RunResult> {
        calls.push(spec);
        if (spec.args[0] === 'install') {
          installs += 1;
          return installs === 1 ? { code: 1, unauthorized: true } : { code: 0 };
        }
        return { code: 0 };
      },
    };
    const res = await prepClosure({
      services: ['rtsm-api'] as ServiceId[],
      dbs: [],
      repoRoots: REPO_ROOTS,
      runner,
      isFresh: NEVER_FRESH,
    });

    expect(res.ok).toBe(true);
    // install (401) → co:login → install (retry) → build, all on RTSM.
    expect(res.steps.map((s) => `${s.repo}:${s.kind}`)).toEqual([
      'RTSM:install',
      'RTSM:co:login',
      'RTSM:install',
      'RTSM:build',
    ]);
    // install ran with the 401-detection flag; co:login ran in the repo root.
    const installCalls = calls.filter((c) => c.args[0] === 'install');
    expect(installCalls).toHaveLength(2);
    expect(installCalls.every((c) => c.detectUnauthorized === true)).toBe(true);
    const login = calls.find((c) => c.args[0] === 'co:login');
    expect(login?.command).toBe('pnpm');
    expect(login?.cwd).toBe('/dev/rtsm');
  });

  it('FLIP 4: a NON-401 install failure does NOT co:login/retry — it aborts immediately', async () => {
    let installs = 0;
    const runner: Runner = {
      async run(spec): Promise<RunResult> {
        if (spec.args[0] === 'install') {
          installs += 1;
          return { code: 1 }; // plain failure, NOT unauthorized
        }
        return { code: 0 };
      },
    };
    const res = await prepClosure({
      services: ['rtsm-api'] as ServiceId[],
      dbs: [],
      repoRoots: REPO_ROOTS,
      runner,
      isFresh: NEVER_FRESH,
    });

    expect(res.ok).toBe(false);
    expect(res.failed).toMatchObject({ repo: 'RTSM', kind: 'install' });
    // no co:login, no retry — exactly one install attempt.
    expect(installs).toBe(1);
    expect(res.steps.some((s) => s.kind === 'co:login')).toBe(false);
  });

  it('FLIP 4: a 401 that STILL fails after co:login surfaces the ORIGINAL install failure', async () => {
    let installs = 0;
    const runner: Runner = {
      async run(spec): Promise<RunResult> {
        if (spec.args[0] === 'install') {
          installs += 1;
          return { code: 1, unauthorized: true }; // still 401 on the retry
        }
        return { code: 0 }; // co:login "succeeds" but the token is still bad
      },
    };
    const res = await prepClosure({
      services: ['rtsm-api'] as ServiceId[],
      dbs: [],
      repoRoots: REPO_ROOTS,
      runner,
      isFresh: NEVER_FRESH,
    });

    expect(res.ok).toBe(false);
    expect(res.failed).toMatchObject({ repo: 'RTSM', kind: 'install' });
    // co:login + EXACTLY one retry (install ran twice, then stopped — no infinite loop).
    expect(installs).toBe(2);
    expect(res.steps.map((s) => `${s.repo}:${s.kind}`)).toEqual([
      'RTSM:install',
      'RTSM:co:login',
      'RTSM:install',
    ]);
    // build never ran (the pass aborted at install).
    expect(res.steps.some((s) => s.kind === 'build')).toBe(false);
  });

  it('MAJOR-C: a db:generate failure is NON-fatal (warning), the pass continues', async () => {
    const { runner } = runnerFailingWhen((s) => s.args[0] === 'db:generate');
    const res = await prepClosure({
      services: ['coach-api'] as ServiceId[],
      dbs: ['coach_api'] as DbId[],
      repoRoots: REPO_ROOTS,
      runner,
      isFresh: NEVER_FRESH,
      dbGenerateScan: () => ['packages/node/coach-db'],
    });
    expect(res.ok).toBe(true);
    expect(res.warnings.map((w) => `${w.repo}:${w.kind}`)).toEqual(['COACH:db:generate']);
    // build still ran after the non-fatal generate failure.
    expect(res.steps.some((s) => s.repo === 'COACH' && s.kind === 'build')).toBe(true);
  });
});

describe('prepClosure — soa#256 freshness stamp writing', () => {
  /** Capture the roots the injected stamp writer is called for. */
  function captureStamps(): { writeStamp: (root: string) => void; stamped: string[] } {
    const stamped: string[] = [];
    return { writeStamp: (root) => stamped.push(root), stamped };
  }

  it('stamps each repo that built+installed to completion (after its build)', async () => {
    const { runner } = fakeRunner();
    const { writeStamp, stamped } = captureStamps();
    const res = await prepClosure({
      services: ['iam-api', 'programs-api'] as ServiceId[],
      dbs: ['iam_local'] as DbId[],
      repoRoots: REPO_ROOTS,
      runner,
      isFresh: NEVER_FRESH,
      writeStamp,
    });
    expect(res.ok).toBe(true);
    expect(stamped).toEqual(['/dev/rostering', '/dev/program-hub']);
    // the stamp is written AFTER the repo's build step, per repo.
    const rosteringBuildIdx = res.steps.findIndex((s) => s.repo === 'ROSTERING' && s.kind === 'build');
    expect(rosteringBuildIdx).toBeGreaterThanOrEqual(0);
  });

  it('stamps an install-only repo (saga-dash) after its successful install', async () => {
    const { runner } = fakeRunner();
    const { writeStamp, stamped } = captureStamps();
    const res = await prepClosure({
      services: ['saga-dash'] as ServiceId[],
      dbs: [],
      repoRoots: REPO_ROOTS,
      runner,
      isFresh: NEVER_FRESH,
      writeStamp,
    });
    expect(res.ok).toBe(true);
    expect(stamped).toEqual(['/dev/saga-dash']);
  });

  it('does NOT stamp a repo whose build FAILED fatally (COACH aborts before stamping)', async () => {
    const { runner } = runnerFailingWhen((s) => s.cwd === '/dev/coach' && s.args[0] === 'build');
    const { writeStamp, stamped } = captureStamps();
    const res = await prepClosure({
      services: ['coach-api'] as ServiceId[],
      dbs: ['coach_api'] as DbId[],
      repoRoots: REPO_ROOTS,
      runner,
      isFresh: NEVER_FRESH,
      writeStamp,
    });
    expect(res.ok).toBe(false);
    expect(stamped).toEqual([]);
  });

  it('does NOT stamp a repo whose build FAILED non-fatally (SDS warns, no stamp ⇒ repreps next run)', async () => {
    const { runner } = runnerFailingWhen((s) => s.cwd === '/dev/student-data-system' && s.args[0] === 'build');
    const { writeStamp, stamped } = captureStamps();
    const res = await prepClosure({
      services: ['ads-adm-api'] as ServiceId[],
      dbs: ['ads_adm_local'] as DbId[],
      repoRoots: REPO_ROOTS,
      runner,
      isFresh: NEVER_FRESH,
      writeStamp,
    });
    expect(res.ok).toBe(true); // non-fatal — the pass continues
    expect(res.warnings.map((w) => `${w.repo}:${w.kind}`)).toEqual(['SDS:build']);
    expect(stamped).toEqual([]); // …but a failed build is NOT stamped
  });

  it('does NOT stamp a fresh-skipped repo (no build ran ⇒ its existing stamp stands)', async () => {
    const { runner } = fakeRunner();
    const { writeStamp, stamped } = captureStamps();
    await prepClosure({
      services: ['iam-api', 'programs-api'] as ServiceId[],
      dbs: ['iam_local'] as DbId[],
      repoRoots: REPO_ROOTS,
      runner,
      isFresh: (root) => root === '/dev/rostering', // rostering fresh-skips
      writeStamp,
    });
    expect(stamped).toEqual(['/dev/program-hub']); // rostering skipped ⇒ not re-stamped
  });
});

describe('prepClosure — soa#260 build-failure repair escalation', () => {
  it('a build failure the repair seam heals ⇒ wipe→reinstall→rebuild, recovered, stamped, no warning', async () => {
    let repaired = false;
    const runner: Runner = {
      async run(spec): Promise<RunResult> {
        const isBuild = spec.args[0] === 'build';
        return { code: isBuild && !repaired ? 1 : 0 }; // build fails until the repair wipe runs
      },
    };
    const stamped: string[] = [];
    const res = await prepClosure({
      services: ['iam-api'] as ServiceId[], // ROSTERING — non-fatal build
      dbs: [] as DbId[],
      repoRoots: REPO_ROOTS,
      runner,
      isFresh: NEVER_FRESH,
      writeStamp: (r) => stamped.push(r),
      repairStaleDeps: () => {
        repaired = true;
        return true;
      },
    });
    expect(res.ok).toBe(true);
    expect(res.warnings).toHaveLength(0); // healed ⇒ nothing surfaced as a warning
    expect(stamped).toContain('/dev/rostering'); // recovered ⇒ stamped
    expect(res.steps.map((s) => s.kind)).toEqual(['install', 'build', 'repair', 'install', 'build']);
  });

  it('a build failure with NO repairable signature ⇒ normal non-fatal warning, no wipe, not stamped', async () => {
    const { runner } = runnerFailingWhen((s) => s.args[0] === 'build');
    const stamped: string[] = [];
    let asked = 0;
    const res = await prepClosure({
      services: ['iam-api'] as ServiceId[],
      dbs: [] as DbId[],
      repoRoots: REPO_ROOTS,
      runner,
      isFresh: NEVER_FRESH,
      writeStamp: (r) => stamped.push(r),
      repairStaleDeps: () => {
        asked++;
        return false; // no corruption signature ⇒ do not escalate
      },
    });
    expect(res.ok).toBe(true);
    expect(asked).toBe(1); // consulted once, found nothing repairable
    expect(res.warnings.map((w) => w.kind)).toEqual(['build']); // normal non-fatal warning
    expect(stamped).not.toContain('/dev/rostering'); // failed build ⇒ no stamp
    expect(res.steps.filter((s) => s.kind === 'repair')).toHaveLength(0); // no wipe
    expect(res.steps.filter((s) => s.kind === 'install')).toHaveLength(1); // no reinstall
  });

  it('repair heals a FATAL-build repo ⇒ the pass no longer aborts', async () => {
    let repaired = false;
    const runner: Runner = {
      async run(spec): Promise<RunResult> {
        const failCoachBuild = spec.args[0] === 'build' && spec.cwd === '/dev/coach' && !repaired;
        return { code: failCoachBuild ? 1 : 0 };
      },
    };
    const res = await prepClosure({
      services: ['coach-api'] as ServiceId[], // COACH — fatal build (would abort pre-#260)
      dbs: [] as DbId[],
      repoRoots: REPO_ROOTS,
      runner,
      isFresh: NEVER_FRESH,
      repairStaleDeps: (r) => {
        if (r !== '/dev/coach') return false;
        repaired = true;
        return true;
      },
    });
    expect(res.ok).toBe(true); // escalation runs BEFORE the fatal return → healed
    expect(res.failed).toBeUndefined();
  });
});

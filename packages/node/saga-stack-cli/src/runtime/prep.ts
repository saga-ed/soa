/**
 * R1 — native build/prep pass (M8 native prep pass).
 *
 * A FAITHFUL port of up.sh's `prep()` build loop: over the repos
 * of the closure services, run `pnpm install` (idempotent), a best-effort
 * workspace build, and `pnpm db:generate` for the `*-db` packages (which need a
 * generated Prisma client BEFORE their tsup build + runtime import). Without this,
 * a fresh/stale-`dist` checkout crashes native `up` at import (`@saga-ed/coach-db`
 * from `dist/`, or `vite: not found`) BEFORE any DB work.
 *
 * CLOSURE-SCOPED: only the DISTINCT repos of the closure services are prepped (not
 * up.sh's blanket seven-repo loop), so `--only`/slots stay cheap.
 *
 * db:generate is scoped to REPOS (not closure DBs): step 3 runs `pnpm build` at the
 * repo ROOT = `turbo run build` over the WHOLE workspace, which builds EVERY sibling
 * `*-db` package (chat/insights/transcripts/ledger-db …) whose tsup build imports a
 * generated Prisma client. BLOCKER-B: scoping db:generate to only the closure's
 * `*-db` packages left the other siblings ungenerated → their build fails → abort.
 * So R1 generates EVERY package in each closure repo that DECLARES `db:generate`
 * (via the injected `dbGenerateScan` seam — a faithful port of up.sh's
 * `for dbpkg in $SDS/packages/node/*; grep -q '"db:generate"'` loop),
 * not just the closure DBs' owners. Absent seam ⇒ fall back to the closure-derived
 * targets (unit tests that don't wire the scan).
 *
 * up.sh fidelity notes:
 *   - Per repo: `pnpm install` → `pnpm db:generate` (all `db:generate` pkgs) → `pnpm build`.
 *   - SAGA_DASH is install-ONLY (up.sh installs vite but does NOT build —
 *     it runs via `vite dev`); every other repo builds. This one "install-only"
 *     distinction isn't expressible from the manifest yet (see the report).
 *   - FATAL MAP (MAJOR-C): up.sh's `build_step` defaults NON-fatal (warn+continue)
 *     and is fatal only for QBOARD/RTSM/COACH (their services import workspace
 *     `dist/` at launch); ROSTERING/PROGRAM_HUB/SDS builds
 *     and ALL `db:generate` (`|| true`) are NON-fatal. R1
 *     mirrors this: a non-fatal build/db:generate failure is recorded as a WARNING
 *     and the pass continues; only a FATAL_BUILD_REPOS build (or any `pnpm install`,
 *     which up.sh's `pnpm_install` also aborts on) stops the pass.
 *   - Repos are ordered by up.sh's canonical prep order for determinism.
 *
 * `--skip-prep` (up.sh `SKIP_PREP=1`): short-circuits R1 ONLY (this pass). Unlike
 * up.sh's `SKIP_PREP` — which wraps the WHOLE `prep()` (build + provision + migrate)
 * — the native `--skip-prep` skips only R1 build/install; R2 provision + R3 migrate
 * still run (see stack-api `up`). Documented divergence: skipping the build is safe
 * (fresh-skip already no-ops a built tree), while R2/R3 stay idempotent.
 *
 * CODEARTIFACT (FLIP 4): `pnpm install` here recovers from an expired CodeArtifact
 * token exactly as up.sh's `pnpm_install` does — install runs with
 * `detectUnauthorized`, and on a 401 (`ERR_PNPM_FETCH_401` / `Unauthorized`) R1 runs
 * `pnpm co:login` (the workspace's token-refresh script) and RETRIES the install
 * ONCE. If it still fails, the ORIGINAL failing install step is surfaced (`failed`)
 * and the pass aborts. The 401 detection + co:login + retry all run through the
 * injected Runner seam, so this is unit-testable with a fake (no real network/AWS).
 *
 * FRESH-SKIP (idempotent re-up): when a repo's `dist/` + `node_modules` are already
 * present (the injected `isFresh` predicate), its whole prep is skipped — so a
 * re-up on an already-built workspace is a fast no-op and wiring this into every
 * native `up` doesn't slow the soaked `--only` path.
 *
 * INVARIANT: process/fs IO lives only in `src/runtime/**`; `src/core/**` never
 * imports this and stays pure. Repo/package derivation is manifest-driven.
 */

import { getDb, getService, manifest as defaultManifest } from '../core/manifest/index.js';
import type { DbId, Manifest, RepoKey, ServiceId } from '../core/manifest/index.js';
import type { Runner } from './exec.js';

/**
 * Repos up.sh installs but does NOT build (they run a dev server, not `dist/`).
 * Only SAGA_DASH today (up.sh: `vite dev`, no prebuild). qboard/coach
 * DO build (their services import workspace `dist/` deps). See the report — this
 * isn't manifest-expressible yet.
 */
export const INSTALL_ONLY_REPOS: ReadonlySet<RepoKey> = new Set<RepoKey>(['SAGA_DASH']);

/**
 * Repos whose `pnpm build` failure is FATAL (aborts the pass) — their services
 * import workspace `dist/` at launch, so an unbuilt tree is a guaranteed crash
 * (up.sh: `build_step … 1`). Every other repo's build is
 * NON-fatal (warn + continue), matching up.sh's default `build_step`.
 */
export const FATAL_BUILD_REPOS: ReadonlySet<RepoKey> = new Set<RepoKey>(['QBOARD', 'RTSM', 'COACH']);

/** up.sh's canonical prep order. Non-built repos (SOA/FLEEK) omitted. */
const PREP_REPO_ORDER: readonly RepoKey[] = [
  'ROSTERING',
  'PROGRAM_HUB',
  'SDS',
  'SAGA_DASH',
  'QBOARD',
  'RTSM',
  'COACH',
];

/** Inputs to the R1 prep pass. */
export interface PrepContext {
  /** The closure's services — their distinct repos are what gets prepped. */
  services: ServiceId[];
  /** The closure's databases — their `*-db` owning packages get `db:generate`. */
  dbs: DbId[];
  /** Absolute repo checkout roots keyed by manifest `RepoKey`. */
  repoRoots: Record<RepoKey, string>;
  /** Process seam — `pnpm install`/`build`/`db:generate` run through it. */
  runner: Runner;
  /** `--skip-prep` (up.sh `SKIP_PREP=1`) — short-circuit R1 (this pass) only. */
  skipPrep?: boolean;
  /**
   * Predicate: is this repo root already fresh (`node_modules` + `dist` present)?
   * A fresh repo's prep is skipped. Absent ⇒ never fresh (always prep) — the
   * conservative default for a cold checkout.
   */
  isFresh?: (repoRoot: string) => boolean;
  /**
   * BLOCKER-B seam: given a repo root, the repo-relative dirs of EVERY package that
   * DECLARES a `db:generate` script (up.sh scans `packages/node/*` for
   * `grep -q '"db:generate"'`). These are generated before the whole-workspace
   * `pnpm build` so ungenerated sibling `*-db` packages don't fail the turbo build.
   * ABSENT ⇒ fall back to the closure-derived `*-db` targets (unit-test default).
   */
  dbGenerateScan?: (repoRoot: string) => string[];
  /** Manifest (defaults to the frozen one). */
  manifest?: Manifest;
  /**
   * M13-B: realpath-keyed build lock. When present, each non-fresh repo's prep
   * acquires its lock before install/build and releases after — a held lock
   * FAILS the pass fast (never waits) so two `ss` invocations can't build one
   * checkout concurrently. Absent ⇒ no locking (unit-test default).
   */
  lock?: PrepRepoLock;
}

/** M13-B: the injectable per-repo build lock (production: `makeRealPrepLock`). */
export interface PrepRepoLock {
  acquire(repoRoot: string): { ok: true; release: () => void } | { ok: false; holder: string };
}

/** One prep step in the executed plan (for reporting + test assertions). */
export interface PrepStep {
  repo: RepoKey;
  kind: 'install' | 'db:generate' | 'build' | 'co:login' | 'lock';
  cwd: string;
  /** argv AFTER `pnpm` (e.g. `['install']`, `['db:generate']`, `['build']`, `['co:login']`). */
  argv: string[];
  /** `kind: 'lock'` only — the who-holds-it description for the error surface. */
  detail?: string;
}

/** The outcome of the R1 pass. */
export interface PrepResult {
  ok: boolean;
  /** True iff the pass was short-circuited by `--skip-prep`. */
  skippedPrep: boolean;
  /** Repos skipped because they were already fresh. */
  freshRepos: RepoKey[];
  /** The steps actually run, in order. */
  steps: PrepStep[];
  /**
   * NON-fatal step failures (MAJOR-C): a ROSTERING/PROGRAM_HUB/SDS build or ANY
   * `db:generate` that exited non-zero. The pass CONTINUES (up.sh warn+continue);
   * these are recorded for the caller to surface as warnings.
   */
  warnings: PrepStep[];
  /** The step that failed FATALLY (set only when `ok` is false). */
  failed?: PrepStep;
}

/** Join a repo root + a repo-relative subpath. */
function joinPath(root: string, subpath: string): string {
  return `${root.replace(/\/+$/, '')}/${subpath.replace(/^\/+/, '')}`;
}

/**
 * The closure's DB packages that need `db:generate`, keyed by repo. A DB needs it
 * iff its owning `migrate.dir` is a `*-db` package (the Prisma-client packages);
 * the program-hub apps (`apps/node/*-api`) generate via their own build, matching
 * up.sh (which db:generates only the `*-db` packages + coach-db). Deduped by dir.
 */
function dbGenerateTargets(dbs: DbId[], m: Manifest): { repo: RepoKey; dir: string }[] {
  const seen = new Set<string>();
  const out: { repo: RepoKey; dir: string }[] = [];
  for (const id of dbs) {
    const def = getDb(id, m);
    if (!def.migrate || def.engine !== 'postgres') continue;
    // `*-db` package basename → needs a generated client before its tsup build.
    const base = def.migrate.dir.split('/').pop() ?? '';
    if (!base.endsWith('-db')) continue;
    const repo = ownerRepoOf(id, m);
    if (!repo) continue;
    const key = `${repo}::${def.migrate.dir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ repo, dir: def.migrate.dir });
  }
  return out;
}

/** The RepoKey of the first service that owns `db`. */
function ownerRepoOf(db: DbId, m: Manifest): RepoKey | undefined {
  for (const svc of Object.values(m.services)) {
    if (svc.databases.includes(db)) return svc.repo;
  }
  return undefined;
}

/**
 * Run the R1 prep pass over the closure. Returns the executed step plan (which
 * repos, which scripts) — a `--skip-prep` short-circuit yields an empty plan, and
 * fresh repos are recorded but not run. A non-zero `pnpm install`/`build`/
 * `db:generate` stops the pass with `ok:false`.
 */
export async function prepClosure(ctx: PrepContext): Promise<PrepResult> {
  const m = ctx.manifest ?? defaultManifest;

  if (ctx.skipPrep) {
    return { ok: true, skippedPrep: true, freshRepos: [], steps: [], warnings: [] };
  }

  // Distinct closure repos, ordered by up.sh's canonical prep order.
  const closureRepos = new Set<RepoKey>();
  for (const id of ctx.services) closureRepos.add(getService(id, m).repo);
  const repos = PREP_REPO_ORDER.filter((r) => closureRepos.has(r));

  const steps: PrepStep[] = [];
  const warnings: PrepStep[] = [];
  const freshRepos: RepoKey[] = [];

  const run = async (step: PrepStep): Promise<boolean> => {
    steps.push(step);
    const { code } = await ctx.runner.run({
      cwd: step.cwd,
      command: 'pnpm',
      args: step.argv,
      env: {},
      stdio: 'inherit',
    });
    return code === 0;
  };

  for (const repo of repos) {
    const root = ctx.repoRoots[repo];
    // Fresh-skip: an already-built repo (node_modules + dist) is a no-op.
    // (Deliberately BEFORE the lock: sharing pre-built checkouts stays legal.)
    if (ctx.isFresh?.(root)) {
      freshRepos.push(repo);
      continue;
    }

    // M13-B: exclusive realpath-keyed build lock — a held lock fails FAST with
    // who-holds-it (two invocations building one checkout is the race the
    // whole guard family exists to prevent; plan §4 layer 2).
    const lock = ctx.lock?.acquire(root) ?? { ok: true as const, release: () => {} };
    if (!lock.ok) {
      const step: PrepStep = { repo, kind: 'lock', cwd: root, argv: [], detail: lock.holder };
      steps.push(step);
      return { ok: false, skippedPrep: false, freshRepos, steps, warnings, failed: step };
    }

    try {
      const failed = await prepOneRepo(ctx, m, repo, root, run, steps, warnings);
      if (failed !== null) {
        return { ok: false, skippedPrep: false, freshRepos, steps, warnings, failed };
      }
    } finally {
      lock.release();
    }
  }

  return { ok: true, skippedPrep: false, freshRepos, steps, warnings };
}

/**
 * One repo's install → db:generate → build sequence. Returns the FATALLY
 * failed step (aborting the whole pass), or `null` to continue. Extracted so
 * the caller can hold the M13-B build lock across exactly this body.
 */
async function prepOneRepo(
  ctx: PrepContext,
  m: Manifest,
  repo: RepoKey,
  root: string,
  run: (step: PrepStep) => Promise<boolean>,
  steps: PrepStep[],
  warnings: PrepStep[],
): Promise<PrepStep | null> {
  {
    // 1. install (idempotent) — FATAL (up.sh's `pnpm_install` aborts on failure).
    //    FLIP 4: on a CodeArtifact 401 (expired token), refresh via `pnpm co:login`
    //    and retry the install ONCE (mirrors up.sh's `pnpm_install`). A non-401 failure does NOT
    //    trigger the retry; if the retry still fails, the ORIGINAL install step is
    //    surfaced as `failed`.
    const installStep: PrepStep = { repo, kind: 'install', cwd: root, argv: ['install'] };
    steps.push(installStep);
    let install = await ctx.runner.run({
      cwd: root,
      command: 'pnpm',
      args: ['install'],
      env: {},
      stdio: 'inherit',
      detectUnauthorized: true,
    });
    if (install.code !== 0 && install.unauthorized) {
      // Refresh the CodeArtifact token, then retry the install once.
      await run({ repo, kind: 'co:login', cwd: root, argv: ['co:login'] });
      const retryStep: PrepStep = { repo, kind: 'install', cwd: root, argv: ['install'] };
      steps.push(retryStep);
      install = await ctx.runner.run({
        cwd: root,
        command: 'pnpm',
        args: ['install'],
        env: {},
        stdio: 'inherit',
        detectUnauthorized: true,
      });
    }
    if (install.code !== 0) {
      return installStep;
    }

    // 2. db:generate — BLOCKER-B: every `db:generate` package in the repo (the scan
    //    seam), NOT just the closure DBs' owners, so the whole-workspace build below
    //    finds a generated client for every sibling `*-db`. NON-fatal (up.sh `|| true`):
    //    a failure is a warning, and the pass continues.
    const genDirs = ctx.dbGenerateScan
      ? ctx.dbGenerateScan(root)
      : dbGenerateTargets(ctx.dbs, m)
          .filter((t) => t.repo === repo)
          .map((t) => t.dir);
    for (const dir of genDirs) {
      const gen: PrepStep = { repo, kind: 'db:generate', cwd: joinPath(root, dir), argv: ['db:generate'] };
      if (!(await run(gen))) warnings.push(gen);
    }

    // 3. build — SAGA_DASH is install-only (vite dev, no prebuild). MAJOR-C: FATAL
    //    only for QBOARD/RTSM/COACH (dist-importing services); ROSTERING/PROGRAM_HUB/
    //    SDS builds are NON-fatal (warn + continue).
    if (!INSTALL_ONLY_REPOS.has(repo)) {
      const build: PrepStep = { repo, kind: 'build', cwd: root, argv: ['build'] };
      if (!(await run(build))) {
        if (FATAL_BUILD_REPOS.has(repo)) {
          return build;
        }
        warnings.push(build);
      }
    }
  }

  return null;
}

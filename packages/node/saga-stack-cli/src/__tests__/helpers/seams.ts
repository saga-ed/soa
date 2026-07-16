/**
 * Shared BaseCommand seam battery (M15-C test-harness consolidation).
 *
 * `installCoreSeams` is the ONE copy of the fake-seam recipe that the four
 * native-orchestration suites (run.int / e2e.int / checkpoint.int in
 * commands/e2e, up-native.int in commands/stack) each hand-rolled: a recording
 * `ServiceLauncher`, silent `MeshExec`/`PortProbe`/`DashFs`/`HealthProber`
 * fakes, the Runner-with-CREATE-DATABASE-tracker, the STATEFUL `PgProbe` it
 * backs, and the `getPrepFreshCheck`/`getDbGenerateScan`/`getRepoDirCheck`
 * predicate spies — all installed on `BaseCommand.prototype` via `vi.spyOn`,
 * so `vi.restoreAllMocks()` in the caller's afterEach tears them down.
 *
 * The load-bearing divergences between the old copies are EXPLICIT REQUIRED
 * options — every call site states them; there is no silent shared default:
 *
 * - `pidBase` — the fake launch pid floor (run.int/checkpoint used 3000,
 *   e2e.int/up-native 2000). Cosmetic, but pinned per-suite to keep the
 *   converted suites byte-equivalent to their hand-rolled fakes.
 * - `prepFresh` — what `getPrepFreshCheck` answers. `true` (run.int/
 *   checkpoint) reports every repo fresh so the R1 prep build is SKIPPED;
 *   `false` (e2e.int/up-native) makes R1 run (the fixed `/fixed/dev` paths
 *   don't exist, so the real check would never report fresh). This changes
 *   which `runs` the suites observe — it must never default silently.
 *
 * Stateful pgProbe (mirrors the up-native original): a DB is ABSENT until the
 * Runner sees R2 provision's `CREATE DATABASE <name>` psql, after which it
 * EXISTS — so provision CREATEs each closure DB and the later R4/reset
 * existence probe truncates rather than skips (the live-run BUG 2). The
 * returned `provisioned` set is the tracker itself: up-native PRE-SEEDS the
 * playback trio (their services create those DBs, not R2 provision).
 *
 * Composition: suites layer their extras ON TOP after calling this —
 * checkpoint re-spies `getSnapshotIO` (helpers/snapshot-io.ts), up-native
 * re-spies `getMeshExec`/`getDashFs` with RECORDING fakes and adds its
 * login/git/vite/tunnel/record seams. Re-`vi.spyOn` on an already-spied
 * method returns the same spy, so `.mockReturnValue` cleanly replaces the
 * core fake without stacking.
 */

import { vi } from 'vitest';
import { BaseCommand } from '../../base-command.js';
import type {
  DashFs,
  HealthProber,
  LaunchResult,
  LaunchSpec,
  MeshExec,
  PgProbe,
  PortProbe,
  ProbeResult,
  RunResult,
  Runner,
  ScriptInvocation,
  ServiceLauncher,
  StopResult,
} from '../../runtime/index.js';

export interface CoreSeamsOptions {
  /** Fake launch pid floor (pid = pidBase + launch ordinal). EXPLICIT at every call site. */
  pidBase: number;
  /**
   * `getPrepFreshCheck` answer. EXPLICIT at every call site: `true` skips the
   * R1 prep build (run.int/checkpoint), `false` runs it (e2e.int/up-native).
   */
  prepFresh: boolean;
  /** Service ids whose launch reports health-down (`ok: false`). */
  launchFail?: Set<string>;
  /**
   * Fail (exit 1) any Playwright child whose args include this token —
   * checkpoint.int's RED-stage lever. Non-Playwright runs still exit 0.
   */
  playwrightFail?: string;
  /** Also return the `getLauncher` spy (run.int asserts its state-dir argument). */
  captureLauncherSpy?: boolean;
}

export interface CoreSeams {
  /** Every LaunchSpec the fake launcher received, in launch order. */
  launches: LaunchSpec[];
  /** Every ScriptInvocation the fake Runner received, in run order. */
  runs: ScriptInvocation[];
  /**
   * The CREATE-DATABASE tracker backing the stateful pgProbe. Mutable on
   * purpose: up-native pre-seeds the playback trio before any test runs.
   */
  provisioned: Set<string>;
  /** Present only when `captureLauncherSpy` was set. */
  launcherSpy?: ReturnType<typeof vi.spyOn>;
}

/** Install the shared fake-seam battery on BaseCommand.prototype. */
export function installCoreSeams(opts: CoreSeamsOptions): CoreSeams {
  const launchFail = opts.launchFail ?? new Set<string>();
  const launches: LaunchSpec[] = [];
  const runs: ScriptInvocation[] = [];

  const launcher: ServiceLauncher = {
    async launch(spec: LaunchSpec): Promise<LaunchResult> {
      launches.push(spec);
      return { id: spec.id, ok: !launchFail.has(spec.id), pid: opts.pidBase + launches.length };
    },
    async stopServices(ids: string[]): Promise<StopResult[]> {
      return ids.map((id) => ({ id, stopped: true }));
    },
  };
  const meshExec: MeshExec = { async ready(): Promise<boolean> { return true; } };
  const portProbe: PortProbe = {
    async dockerHolder(): Promise<string | null> { return null; },
    async listening(): Promise<boolean> { return false; },
  };
  const dashFs: DashFs = { existsDir: () => true, existsFile: () => false, remove: () => {}, write: () => {} };
  const prober: HealthProber = { async probe(): Promise<ProbeResult> { return { ok: true, status: 200 }; } };

  // Runner + CREATE DATABASE tracker: R2 provision's `psql -c "CREATE DATABASE
  // <name>"` marks the DB present for the stateful pgProbe below.
  const provisioned = new Set<string>();
  const runner: Runner = {
    async run(spec: ScriptInvocation): Promise<RunResult> {
      runs.push(spec);
      const ci = spec.args.indexOf('-c');
      if (ci >= 0) {
        const m = /CREATE DATABASE (\w+)/.exec(spec.args[ci + 1] ?? '');
        if (m) provisioned.add(m[1]);
      }
      if (
        opts.playwrightFail !== undefined &&
        spec.args.includes('playwright') &&
        spec.args.includes(opts.playwrightFail)
      ) {
        return { code: 1 };
      }
      return { code: 0 };
    },
  };
  // Stateful existence (absent until provision CREATEs it) so provision CREATEs
  // each closure DB and reset then sees it present + truncates; table-empty so
  // migrate takes the `empty → db:deploy` branch (migrate consults
  // hasMigrationsTable/publicTableCount, NOT databaseExists).
  const pgProbe: PgProbe = {
    async databaseExists(_c, db): Promise<boolean> { return provisioned.has(db); },
    async hasMigrationsTable(): Promise<boolean> { return false; },
    async publicTableCount(): Promise<number> { return 0; },
    async scalar(): Promise<string> { return ''; },
  };

  const proto = BaseCommand.prototype as unknown as Record<string, () => unknown>;
  const launcherSpy = vi.spyOn(proto, 'getLauncher').mockReturnValue(launcher);
  vi.spyOn(proto, 'getMeshExec').mockReturnValue(meshExec);
  vi.spyOn(proto, 'getPortProbe').mockReturnValue(portProbe);
  vi.spyOn(proto, 'getDashFs').mockReturnValue(dashFs);
  vi.spyOn(proto, 'getProber').mockReturnValue(prober);
  vi.spyOn(proto, 'getRunner').mockReturnValue(runner);
  vi.spyOn(proto, 'getPgProbe').mockReturnValue(pgProbe);
  vi.spyOn(proto, 'getPrepFreshCheck').mockReturnValue(() => opts.prepFresh);
  vi.spyOn(proto, 'getDbGenerateScan').mockReturnValue(() => []);
  // Fake workspace paths (--dev /fixed/dev) don't exist on disk; report every
  // repo present so no service is skipped. Suites that test the skip-when-absent
  // path re-spy this per test.
  vi.spyOn(proto, 'getRepoDirCheck').mockReturnValue(() => true);
  // soa#327: retry/poll delays (tunnel preflight, settle barrier) must never
  // wall-clock-wait in tests — attempt/poll COUNTS carry the semantics.
  vi.spyOn(proto, 'getSleep').mockReturnValue(async () => {});

  return {
    launches,
    runs,
    provisioned,
    ...(opts.captureLauncherSpy ? { launcherSpy } : {}),
  };
}

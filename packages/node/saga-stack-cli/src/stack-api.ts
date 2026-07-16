/**
 * `stack-api` — the in-process StackApi facade (plan §6.3).
 *
 * ONE facade both the `stack` commands AND `e2e run` drive in-process — no
 * subprocess, no second oclif invocation. `makeStackApi(manifest, runtime)`
 * returns the six-method `StackApi`. PLANNING is pure `core` (closure, launch
 * plan, seed plan, lane env); EXECUTION is the injectable `runtime` seams
 * (`ServiceLauncher` / `MeshExec` / `PortProbe` / `DashFs` / `HealthProber` /
 * `Runner`). The facade itself is the THIN glue between the two — it owns NO IO,
 * it only sequences pure plans through the seams.
 *
 * NATIVE vs DELEGATED (M4 scope):
 *  - `up`    — FULLY NATIVE. `meshUp` (check_ports → `make up` → readiness-gate
 *              the closure's mesh units) → the `sync-dash-local-defaults`
 *              prelaunch hook (only when saga-dash is in the closure) → launch
 *              the closure services in topo WAVES through the `ServiceLauncher`,
 *              health-gating each wave before the next. This is M4's headline
 *              payoff: a partial stack booted FOR REAL, not via up.sh.
 *  - `seed`  — NATIVE. Runs a composed `SeedPlan` (offline steps first, then the
 *              online steps once services are up) through the `Runner`. Env is
 *              resolved from the manifest-faithful `LaunchContext` tokens.
 *  - `verify`— NATIVE. Reuses the M2 manifest-derived probe path (the injectable
 *              `HealthProber`), with a `tolerate` set.
 *  - `down`  — NATIVE. `ServiceLauncher.stopServices` (read pid files, kill).
 *  - `reset` — NATIVE (M8 R4). Truncates the closure's DBs to an empty baseline
 *              (preserving `_prisma_migrations`), migrate-resets ledger, drops
 *              connectv3, then re-seeds the dev user via the seed path. See `reset`.
 *
 * `login` is NO LONGER on this facade — it is fully NATIVE at the command layer
 * (`BaseCommand.mintNativeLoginJar` + `openVendoredBrowser`), shared by `stack
 * login` and `up --login`, so nothing here delegates to `up.sh --login`.
 *
 * INVARIANT (plan hard constraint): this file imports pure `core` planners and
 * the `runtime` seams, but performs NO direct IO of its own — every spawn /
 * docker / fetch / fs touch happens behind a seam the caller injected.
 */

import type { RecordMode, ScriptPlan } from './core/flag-map.js';
import { launchPlan } from './core/launch-plan.js';
import type { LaunchContext } from './core/launch-plan.js';
import { recordPlan } from './core/record-plan.js';
import type { RecordPlan } from './core/record-plan.js';
import { launchOrder } from './core/launch-order.js';
import { getMesh, getService, manifest as defaultManifest } from './core/manifest/index.js';
import type { DbId, Lane, Manifest, MeshId, RepoKey, ServiceId } from './core/manifest/index.js';
import type { HealthProbe } from './core/probe-plan.js';
import { buildSeedRegistry } from './core/seed/profiles.js';
import type { SeedPlan, SeedStep, SkipNote } from './core/seed/types.js';
import type { PullMode } from './core/auto-pull.js';
import {
  DASH_CONFIG_ENV_VAR,
  REPO_DEFAULT_DIR,
  autoPullRepos,
  buildDashLocalDefaultsJson,
  meshContainer,
  meshUp,
  migrateClosure,
  prepClosure,
  provisionDbs,
  resetClosure,
  syncCoachWebEnvLocal,
  syncDashLocalDefaults,
  viteCachePaths,
} from './runtime/index.js';
import type {
  AutoPullRepo,
  AutoPullResult,
  CoachWebFs,
  CoachWebSyncResult,
  DashFs,
  DashSyncResult,
  GitRunner,
  HealthProber,
  LaunchResult,
  MeshExec,
  MeshResult,
  MigrateResult,
  PgProbe,
  PortProbe,
  PrepResult,
  ProvisionResult,
  ResetResult,
  Runner,
  ServiceLauncher,
  PrepRepoLock,
  ServiceStopper,
  StopResult,
  StopServiceResult,
  ViteClear,
  ViteClearResult,
} from './runtime/index.js';

// ── runtime bundle ───────────────────────────────────────────────────────────

/**
 * Everything the facade needs from the host, supplied by the caller (a `stack`
 * command via its `BaseCommand` seams, or `e2e run`). Each field is an injected
 * SEAM or a pre-resolved value, so the facade's sequencing logic is unit-tested
 * with fakes and NO real process/docker/fetch/fs.
 */
export interface Runtime {
  /** URL lane the native launch targets. The M4 native path drives `'stack'`. */
  lane: Lane;
  /** Resolved launch context (ports / repoRoots / tokens) for the pure launch planner. */
  launchContext: LaunchContext;
  /** Absolute soa checkout root — `make up` runs in `<soaRoot>/infra`. */
  soaRoot: string;
  /** Resolved saga-dash root for the `sync-dash-local-defaults` prelaunch hook. */
  sagaDashRoot: string;
  /** Native service-launch seam (`pnpm dev` + pid file + health poll). */
  launcher: ServiceLauncher;
  /** Mesh-readiness seam (`docker exec <container> …`). */
  meshExec: MeshExec;
  /** Host-port preflight seam (`docker ps` / `ss` / `lsof`). */
  portProbe: PortProbe;
  /** Dash-config fs seam (the prelaunch hook's `config.local.json` write/remove). */
  dashFs: DashFs;
  /**
   * coach-web env fs seam (soa#300 — the `.env.local` prelaunch hook's write/remove).
   * When PRESENT AND coach-web is launchable, `up` writes `<coachWebRoot>/.env.local`
   * so coach-web's browser boots against the LOCAL mesh instead of the checked-in
   * `.env` remote defaults. ABSENT ⇒ the hook is skipped (the facade unit/int tests
   * that don't wire it stay byte-identical); coachWebRoot resolves from
   * `launchContext.repoRoots.COACH`.
   */
  coachWebFs?: CoachWebFs;
  /** HTTP health prober (verify). */
  prober: HealthProber;
  /** Process seam — mesh `make up` + the native seed steps. */
  runner: Runner;
  /**
   * Native-prep postgres probe (M8). When PRESENT, `up` runs the native prep pass
   * between mesh-up and launch — R1 build (`prepClosure`) → R2 provision
   * (`provisionDbs`) → R3 migrate (`migrateClosure`) — so a fresh checkout/volume
   * provisions + migrates itself instead of relying on a prior up.sh run. ABSENT ⇒
   * the pass is skipped entirely (the pre-M8 behaviour), so callers that don't wire
   * it (the facade unit/int tests) are byte-identical. All three phases are
   * idempotent, so a re-up on an already-prepped stack is a fast no-op.
   */
  pgProbe?: PgProbe;
  /**
   * Resolved slot postgres container for the native-prep psql (`soa-postgres-1` at
   * slot 0, `soa-s<N>-postgres-1` at slot > 0). Defaults to the env-aware
   * `meshContainer(postgres)` (which reads the slot's `SAGA_MESH_POSTGRES_CONTAINER`).
   */
  pgContainer?: string;
  /** Native `--skip-prep` (up.sh `SKIP_PREP=1`) — skip R1 build only (R2/R3 still run). */
  skipPrep?: boolean;
  /** R1 fresh-skip predicate: is a repo root already built (`node_modules` + `dist`)? */
  prepIsFresh?: (repoRoot: string) => boolean;
  /**
   * soa#256: R1 stamp writer — after a repo builds+installs to completion, record
   * its `{ headSha, lockHash }` so the next fresh-check can reject a pulled-but-
   * unbuilt tree. Absent ⇒ no stamp written (unit-test default).
   */
  prepWriteStamp?: (repoRoot: string) => void;
  /**
   * soa#260: R1 build-failure repair seam — wipe `node_modules` + reinstall/rebuild once
   * when a build fails on the stale-`.bin`-shim corruption a plain reprep can't fix
   * (program-hub#335). Absent ⇒ no escalation (unit-test default).
   */
  prepRepairDeps?: (repoRoot: string) => boolean | Promise<boolean>;
  /** M13-B: realpath-keyed per-repo build lock — held ⇒ prep fails fast (plan §4 layer 2). */
  prepLock?: PrepRepoLock;
  /**
   * R1 `db:generate` scan (M8 BLOCKER-B): given a repo root, the repo-relative dirs
   * of every package declaring a `db:generate` script — generated before the
   * whole-workspace build so ungenerated sibling `*-db` packages don't fail it.
   * Absent ⇒ R1 falls back to the closure-derived `*-db` targets.
   */
  prepDbGenerateScan?: (repoRoot: string) => string[];
  /**
   * Predicate: does a resolved sibling-repo checkout dir exist on disk? Injected
   * so the facade stays IO-free (the command resolves it to `fs.existsSync`). When
   * a service's repo dir is ABSENT, `up` SKIPS that service with a warning instead
   * of erroring — so a missing optional sibling (e.g. the coach repo not cloned)
   * does not redden the whole stack. Absent ⇒ every repo is assumed present (no
   * skipping) — the behaviour before this guard, preserved for callers that don't
   * wire it (e2e / the facade unit tests).
   */
  repoDirExists?: (dir: string) => boolean;
  /** True iff running in `--tunnel` mode (drives the dash prelaunch hook). Default false. */
  tunnel?: boolean;
  /** `<moniker>.<VMS_BASE>` — required when `tunnel` is true. */
  tunnelDomain?: string;
  /**
   * Stack instance slot (M7). > 0 ⇒ `up` brings the mesh up under the slot's
   * `soa-s<N>` project on offset ports and WRITES the slot's stack-lane dash
   * config. Default 0 (or absent) ⇒ byte-identical to the pre-M7 build.
   */
  slot?: number;
  /**
   * COMPOSE_PROJECT_NAME for the mesh at slot > 0 (`soa-s<N>`); OMITTED at slot 0.
   * Threaded into `meshUp`/`meshDown` so the slot's mesh is namespaced and torn
   * down independently of the default project.
   */
  meshProject?: string;
  /** Offset added to every published mesh port at slot > 0 (`slot * 1000`); 0 at slot 0. */
  meshOffset?: number;
  /**
   * Delegate a wrapped bash `ScriptPlan` to its resolved script, returning the exit
   * code. The command layer points it at `BaseCommand.runScript` so script-path
   * resolution stays in ONE place. TODAY this only ever carries a SAGA_DASH e2e
   * `ScriptPlan` (`core/e2e-map.ts`, a different repo) — the `stack` lifecycle
   * (up/down/reset/login/status/verify) is fully native and never delegates.
   */
  delegate?: (plan: ScriptPlan) => Promise<number>;
  /**
   * The ff-only git seam (M9 — auto-pull). When PRESENT AND `autoPull` is a mode
   * (`'auto'`/`'all'`), `up` runs the ff-only sibling sync BEFORE the mesh/prep, so a
   * bare native `up` never builds/migrates a checkout silently behind origin. ABSENT ⇒
   * the pass is skipped (the facade unit/int tests that don't wire it stay byte-identical).
   */
  gitRunner?: GitRunner;
  /**
   * Auto-pull mode for `up`: `'auto'` (default pre-build sync — default-branch siblings
   * only), `'all'` (explicit `--pull` — every on-branch clean sibling), or `false`
   * (opted out via `--no-auto-pull` / `NO_AUTO_PULL`). Absent/false ⇒ no sync.
   */
  autoPull?: PullMode | false;
  /**
   * The vite-cache-clear fs seam (M9 — native `restart`). Wired by every native command;
   * `restart` invokes it between the service stop and the fresh bring-up. Absent ⇒
   * `restart` skips the clear (the facade tests that don't wire it stay byte-identical).
   */
  viteClear?: ViteClear;
  /**
   * The native slot-safe GROUP-killing service-stopper (M7 Phase 3 — the standalone
   * `stopServices(stateDir)`). Native `restart` routes its stop through THIS (not the
   * leader-only `launcher.stopServices`) so the `tsup --watch` child + the port-holding
   * `node dist/main.js` grandchild are group-reaped (`kill(-pid, …)` SIGTERM→grace→
   * SIGKILL) — otherwise the survivor keeps 200-ing and the follow-up `up()` sees
   * `alreadyUp` and serves STALE code. Dir-scoped ⇒ still slot-safe (never a host-global
   * `pkill`). Wired with `stateDir` below. Absent ⇒ `restart` falls back to the pidfile
   * leader method (the facade unit tests that don't wire it stay byte-identical).
   */
  serviceStopper?: ServiceStopper;
  /**
   * The resolved state dir whose recorded pidfiles the `serviceStopper` enumerates
   * (`--state-dir` override, else the slot's `/tmp/sds-synthetic[-s<N>]`). Same dir the
   * launcher writes pids under, so the restart reap targets exactly this run's servers.
   */
  stateDir?: string;
  /**
   * Best-effort Connect AV bring-up (M9 — livekit + coturn from qboard's compose). When
   * true AND slot 0 AND connect is in the closure, `up` starts AV via the Runner (parity
   * with up.sh's `connect_av_up`). Only at slot 0 — single-node livekit `:7880` bypasses
   * the slot offset, so starting it at slot > 0 would split-brain onto slot 0. Absent/false
   * ⇒ no AV step.
   */
  connectAv?: boolean;
  /**
   * `--record [crdt|av]` (Phase 2) — when set AND fleek is checked out, `up` starts
   * the fleek recording sidecars (recorder :7890 + recordings-api :8444 + MinIO; `av`
   * adds the LiveKit egress) after the launch waves, via `recordUp`. Absent ⇒ no record
   * step. When fleek is NOT cloned the step is SKIPPED with a warning (never a failure),
   * mirroring the repo-absent service skip.
   */
  record?: RecordMode;
  /**
   * The `--record` bring-up seam (production shells the fleek docker-compose stack +
   * CodeArtifact token; tests inject a fake). Absent ⇒ `--record` is planned + fleek-gated
   * but not executed (the facade unit tests stay IO-free). Receives the pure `RecordPlan`
   * + the qboard root (for the redis/livekit recording wiring).
   */
  recordUp?: RecordUp;
  /** Per-user recordings dir (up.sh `$FLEEK_REC_DIR`); defaults to `$HOME/.fleek-local/recordings`. */
  recordingsDir?: string;
  /** Manifest (defaults to the frozen one). */
  manifest?: Manifest;
}

/** The `--record` bring-up seam signature (production impl in `runtime/record.ts`). */
export type RecordUp = (
  plan: RecordPlan,
  ctx: { qboardRoot: string },
) => Promise<{ ok: boolean; message: string }>;

// ── results ────────────────────────────────────────────────────────────────

/** A service `up` skipped because its sibling-repo checkout dir is not present. */
export interface UpSkip {
  /** The skipped service id. */
  id: ServiceId;
  /** Its manifest repo key (e.g. `COACH`). */
  repo: RepoKey;
  /** The resolved repo checkout dir that was found to be absent. */
  repoDir: string;
  /** Human-readable warning (e.g. `coach-api skipped — repo dir /d/coach not present (COACH repo not cloned)`). */
  message: string;
}

/** The best-effort Connect AV bring-up outcome (M9). */
export interface AvResult {
  /** True iff the AV step ran (connect in closure, slot 0, seam enabled). */
  attempted: boolean;
  /** True iff `docker compose … up -d livekit coturn` exited 0. */
  ok: boolean;
  /** Human-readable note (up.sh's `connect_av_up` best-effort ✓/⚠). */
  message: string;
}

/** The `--record` fleek-stack bring-up outcome (Phase 2). */
export interface RecordResult {
  /** The requested record mode. */
  mode: RecordMode;
  /** True iff the fleek stack was actually brought up (fleek present + seam ran + ok). */
  ok: boolean;
  /** True iff SKIPPED because the fleek repo is not cloned (warn, not fail). */
  skipped: boolean;
  /** The compose services the plan targeted (recorder/recordings-api/minio[/egress]). */
  services: string[];
  /** Human-readable note (✓ up / ⚠ skipped-fleek-absent / ⚠ bring-up failed). */
  message: string;
}

/** The outcome of a native `up`. */
export interface UpResult {
  /** True iff the mesh came ready, the dash hook ran (if needed), and every launched wave went healthy. */
  ok: boolean;
  /** The `--record` fleek-stack bring-up outcome — only when `--record` was requested. */
  record?: RecordResult;
  /** The auto-pull (ff-only sibling sync) result — only when a git seam was wired + not opted out. */
  autoPull?: AutoPullResult;
  /** The best-effort Connect AV bring-up — only when connect was in the closure at slot 0 with AV enabled. */
  av?: AvResult;
  /** The mesh bring-up result (preflight conflicts / make-up / per-unit readiness). */
  mesh: MeshResult;
  /** R1 native build/prep outcome (only when the native-prep pass ran). */
  prep?: PrepResult;
  /** R2 DB provisioning outcome (only when the native-prep pass ran). */
  provision?: ProvisionResult;
  /** R3 migrate outcome (only when the native-prep pass ran). */
  migrate?: MigrateResult;
  /** What the dash prelaunch hook did (only when saga-dash was in the closure). */
  dash?: DashSyncResult;
  /**
   * The per-instance dash routing env injection (soa#328) — set only when
   * `DASH_CONFIG_LOCAL_JSON` was injected into saga-dash's launch env (tunnel
   * mode, or non-tunnel slot > 0). Absent ⇒ nothing injected (slot-0 non-tunnel,
   * or saga-dash not launchable).
   */
  dashConfigEnv?: { mode: 'tunnel' | 'stack-slot'; slot: number };
  /** What the coach-web `.env.local` prelaunch hook did (only when coach-web was launchable + the seam wired). */
  coachWeb?: CoachWebSyncResult;
  /** Per-service launch results, in the order launched (topo waves flattened). */
  launched: LaunchResult[];
  /** Services skipped because their repo checkout dir is absent (warn, not fail). */
  skipped: UpSkip[];
  /** The first service that failed health (set only when `ok` is false at the service stage). */
  failedAt?: ServiceId;
  /** Why `failedAt` failed, when it's not a plain health timeout (e.g. the adopt-contract drift refusal). */
  failedReason?: string;
}

/** The outcome of a native `seed`. */
export interface SeedResult {
  /** True iff no FATAL step failed (warn-mode failures don't flip this). */
  ok: boolean;
  /** Step ids that ran, split by phase. */
  ran: { offline: string[]; online: string[] };
  /** The step id that failed fatally (set only when `ok` is false). */
  failed?: string;
  /** Steps the plan dropped (partial-stack / restored gates), carried for emit(). */
  skipped: SkipNote[];
}

/** One rendered verify row. */
export interface VerifyRow {
  id: ServiceId;
  url: string;
  ok: boolean;
  status?: number;
  tolerated: boolean;
}

/** The outcome of a native `verify`. */
export interface VerifyResult {
  passed: boolean;
  rows: VerifyRow[];
}

/** The outcome of a native `down`. */
export interface DownResult {
  stopped: StopResult[];
}


/** Per-call `reset` knobs (M8 R4). */
export interface ResetOpts {
  /** Also reset the opt-in playback DBs (transcripts/insights/chat). */
  withPlayback?: boolean;
  /** Also reset the opt-in authz DBs (openfga/authz_sync_local). */
  withAuthz?: boolean;
}

/** The outcome of a native `reset` (M8 R4). */
export interface ResetOutcome {
  /**
   * 0 on success; non-zero when a CORE reset op (a truncate or the mongo drop) or the
   * dev-user re-seed failed. A failed ledger migrate-reset is warn-only and does NOT
   * flip this (parity with up.sh's always-0 reset), though it is still recorded
   * ok:false in `native.dbs`.
   */
  code: number;
  /** The native per-DB reset result. */
  native?: ResetResult;
  /** The dev-user re-seed result. */
  seed?: SeedResult;
}

/** Per-call `up` knobs (reserved; tunnel/tunnelDomain live on the `Runtime`). */
/** Optional `verify` knobs. */
export interface VerifyOpts {
  /** Tokens (service id OR repo name) whose down state does NOT fail the gate. */
  tolerate?: string[];
}

/** The outcome of a native `restart` (M9 — down → vite-clear → up, no data wipe). */
export interface RestartOutcome {
  /** The service-stop result (native kill-by-pidfile — NOT a host-global pkill). */
  down: DownResult;
  /**
   * The raw GROUP-reap results (SIGTERM→grace→SIGKILL per pidfile) — present when the
   * `serviceStopper` seam was wired (production). Carries the richer per-service
   * `outcome` (`term`/`kill`/`stale`/`alive`) so the command can surface a leaked
   * (`alive`) survivor — an under-kill that would let `up()` serve stale code.
   */
  reaped?: StopServiceResult[];
  /** The vite-cache clear (absent when no viteClear seam was wired). */
  vite?: ViteClearResult;
  /** The fresh bring-up (mesh + prep + launch + auto-pull + AV). */
  up: UpResult;
}

/** The in-process facade (plan §6.3) — M9 adds native `restart`. */
export interface StackApi {
  up(closureServices: ServiceId[]): Promise<UpResult>;
  down(closureServices: ServiceId[]): Promise<DownResult>;
  restart(closureServices: ServiceId[]): Promise<RestartOutcome>;
  reset(closureServices: ServiceId[], opts?: ResetOpts): Promise<ResetOutcome>;
  seed(plan: SeedPlan): Promise<SeedResult>;
  verify(probes: HealthProbe[], opts?: VerifyOpts): Promise<VerifyResult>;
}

// ── helpers (pure) ───────────────────────────────────────────────────────────

/** Matches a `${NAME}` token (uppercase / digits / underscore). */
const TOKEN_RE = /\$\{([A-Z0-9_]+)\}/g;

/** Expand every `${NAME}` in `value` from `tokens`; throws on an unset token. */
function expandTokens(value: string, tokens: Record<string, string | undefined>, where: string): string {
  return value.replace(TOKEN_RE, (_m, name: string) => {
    const v = tokens[name];
    if (v === undefined) throw new Error(`stack-api: ${where} references unset token \${${name}}`);
    return v;
  });
}

/** Join a repo root + repo-relative subpath without depending on the leading-slash shape. */
function joinPath(root: string, subpath: string): string {
  return `${root.replace(/\/+$/, '')}/${subpath.replace(/^\/+/, '')}`;
}

/** Split a non-empty argv into `{ command, args }`; throws on an empty argv (never happens for the authored registry/launch.cmd). */
function head(argv: string[]): { command: string; args: string[] } {
  const [command, ...args] = argv;
  /* c8 ignore next — every seed `command` / launch `cmd` is authored non-empty. */
  if (command === undefined) throw new Error('stack-api: empty command argv');
  return { command, args };
}

/**
 * Mesh units the closure needs — the union of the closure services' `mesh`,
 * in manifest declaration order (so a postgres-only partial stack waits only on
 * postgres). `make up` still starts the WHOLE mesh; this only narrows the gate.
 */
function neededMesh(services: ServiceId[], m: Manifest): MeshId[] {
  const set = new Set<MeshId>();
  for (const id of services) for (const u of getService(id, m).mesh) set.add(u);
  return (Object.keys(m.mesh) as MeshId[]).filter((u) => set.has(u));
}

/**
 * Databases the closure needs — the union of the closure services' `databases`,
 * in manifest declaration order (the canonical migrate order). Drives the native
 * prep pass's provision (R2) + migrate (R3) targets, closure-scoped so a partial
 * stack provisions/migrates only its own DBs.
 */
function neededDbs(services: ServiceId[], m: Manifest): DbId[] {
  const set = new Set<DbId>();
  for (const id of services) for (const d of getService(id, m).databases) set.add(d);
  return (Object.keys(m.databases) as DbId[]).filter((d) => set.has(d));
}

/** Token-aware match: a tolerate token equals a service id or its repo name (kebab or env-var spelling). */
function isTolerated(id: ServiceId, tolerate: Set<string>, m: Manifest): boolean {
  if (tolerate.has(id)) return true;
  const repo = m.services[id].repo;
  return tolerate.has(repo) || tolerate.has(repo.toLowerCase().replace(/_/g, '-'));
}

/**
 * up.sh's `pull_repos` sibling ORDER (`SOA:soa … RTSM:rtsm`, ~964-966) — fleek is
 * excluded. Names match up.sh's labels (`REPO_DEFAULT_DIR` gives `student-data-system`
 * for `SDS`, etc.). The native pass narrows this to the CLOSURE's repos (+ SOA, whose
 * `infra` the mesh `make up` runs from) — up.sh always syncs all 8, but a native
 * `--only` only needs the repos it will build.
 */
const AUTO_PULL_REPO_ORDER: RepoKey[] = [
  'SOA',
  'ROSTERING',
  'PROGRAM_HUB',
  'SAGA_DASH',
  'COACH',
  'SDS',
  'QBOARD',
  'RTSM',
];

/**
 * The siblings to auto-pull for a closure: SOA (mesh infra) ∪ every closure service's
 * repo, in up.sh's `pull_repos` order, mapped to `{ name, path }` from the resolved
 * repo roots. Pure.
 */
function autoPullRepoList(
  services: ServiceId[],
  m: Manifest,
  repoRoots: Record<RepoKey, string>,
): AutoPullRepo[] {
  const wanted = new Set<RepoKey>(['SOA']);
  for (const id of services) wanted.add(getService(id, m).repo);
  return AUTO_PULL_REPO_ORDER.filter((r) => wanted.has(r)).map((repo) => ({
    name: REPO_DEFAULT_DIR[repo],
    path: repoRoots[repo],
  }));
}

/**
 * Best-effort Connect AV bring-up: `docker compose -f <QBOARD>/docker-compose.yml up
 * -d livekit coturn` through the Runner (parity with up.sh's `connect_av_up`,
 * ~599-607). Missing compose / name drift ⇒ a ⚠ note, NEVER an abort (no health poll,
 * no teardown). The caller gates on slot 0 + connect-in-closure.
 */
async function startConnectAv(qboardRoot: string, runner: Runner): Promise<AvResult> {
  const composeFile = joinPath(qboardRoot, 'docker-compose.yml');
  try {
    const { code } = await runner.run({
      cwd: qboardRoot,
      command: 'docker',
      args: ['compose', '-f', composeFile, 'up', '-d', 'livekit', 'coturn'],
      env: {},
      stdio: 'inherit',
    });
    return code === 0
      ? { attempted: true, ok: true, message: '✓ connect AV up — livekit :7880 + coturn (qboard compose)' }
      : {
          attempted: true,
          ok: false,
          message: `⚠ livekit/coturn failed to start (exit ${code}) — Connect still works CRDT-only`,
        };
  } catch {
    // A missing `docker` / compose file surfaces as a spawn throw — fold to a warning.
    return {
      attempted: true,
      ok: false,
      message: '⚠ livekit/coturn could not be started (docker/compose unavailable) — Connect still works CRDT-only',
    };
  }
}

// ── facade ────────────────────────────────────────────────────────────────────

/**
 * Build the in-process facade over a manifest + a runtime seam bundle. The
 * returned object is stateless apart from the closed-over `runtime`; every method
 * sequences pure `core` plans through the injected seams.
 */
export function makeStackApi(m: Manifest, runtime: Runtime): StackApi {
  const manifest = runtime.manifest ?? m ?? defaultManifest;
  const { launchContext, lane, launcher, meshExec, portProbe, dashFs, prober, runner } = runtime;
  const tokens = launchContext.tokens as unknown as Record<string, string | undefined>;

  // M8 R4/R5: the SLOT-RESOLVED mesh containers, resolved ONCE (env-aware
  // `meshContainer` reads the slot's `SAGA_MESH_*_CONTAINER`, set by
  // `applyInstanceEnv` before this facade is built). `pgContainer` honours an
  // explicit runtime override (as `up`'s prep pass does). These drive the native
  // reset (R4) and the docker-exec seed steps' `${SAGA_MESH_*_CONTAINER}` tokens
  // (R5 — coach curriculum / playback bootstrap), so both target the right slot.
  const pgContainer = runtime.pgContainer ?? meshContainer(getMesh('postgres', manifest));
  const mongoContainer = meshContainer(getMesh('connect-mongo', manifest));
  // M8 slot bugfix: profiles.ts is PURE, so a pg-DATABASE_URL/POSTGRES_PORT seed step
  // emits the mesh postgres port as a `${MESH_PG_PORT}` TOKEN rather than a literal.
  // Resolve it HERE (the one place with slot context) to the slot's offset port —
  // base 5432 + meshOffset — so a TCP seed at slot N>0 dials the slot's postgres
  // (:6432 at slot 1) instead of slot 0's :5432. At slot 0 (offset 0) it resolves to
  // :5432, byte-identical to before. The docker-exec seeds still target the container
  // via `${SAGA_MESH_*_CONTAINER}` (their psql runs INSIDE the container on :5432).
  const pgPort = getMesh('postgres', manifest).port + (runtime.meshOffset ?? 0);
  const seedTokens: Record<string, string | undefined> = {
    ...tokens,
    SAGA_MESH_POSTGRES_CONTAINER: pgContainer,
    SAGA_MESH_CONNECT_MONGO_CONTAINER: mongoContainer,
    MESH_PG_PORT: String(pgPort),
  };

  /** Resolve a seed step's cwd: owning service's repo root + step.cwd. */
  function seedCwd(step: SeedStep): string {
    // The content demo-polls step runs the CLI's VENDORED `seed-demo-polls.mjs`
    // (Phase-2 DECOUPLING) — the runtime resolved the package's `vendor/` dir into
    // the `VENDOR_DIR` launch token, so this step runs there (NOT a soa checkout's
    // `tools/synthetic-dev`). This is the one non-repo-relative seed cwd.
    if (step.cwd === 'vendor') {
      return launchContext.tokens.VENDOR_DIR;
    }
    const repo = getService(step.service, manifest).repo;
    return joinPath(launchContext.repoRoots[repo], step.cwd);
  }

  /**
   * Resolve a seed step's extra env. `inline`/`inline-multi` ⇒ the var bag with
   * `${TOKEN}`s expanded against the launch-context tokens (the core steps are
   * literal connection strings; only the content optional steps carry tokens).
   *
   * `dotenv` is NOT supported — it silently returned `{}`, which spawned the iam
   * seeds with no `DATABASE_URL` (the soak's `iam-dev-user` failure). No step
   * constructs it anymore (the iam steps derive their env via `iamSeedEnv`); throw
   * so a future `dotenv` step can't reintroduce that no-op env.
   */
  function seedEnv(step: SeedStep): Record<string, string> {
    if (step.env.kind === 'dotenv') {
      throw new Error(`seed step '${step.id}': dotenv env kind is unimplemented — use inline/inline-multi`);
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(step.env.vars)) {
      out[k] = expandTokens(v, seedTokens, `seed.${step.id}.env.${k}`);
    }
    return out;
  }

  /**
   * Resolve a seed step's command argv, expanding `${TOKEN}`s (incl. the M8 R5
   * `${SAGA_MESH_*_CONTAINER}` slot containers) so a docker-exec step targets the
   * right slot. Steps with no tokens (the pnpm db:seed family) pass through verbatim.
   */
  function seedArgs(step: SeedStep): string[] {
    return step.command.map((a) => expandTokens(a, seedTokens, `seed.${step.id}.cmd`));
  }

  /**
   * Resolve a seed step's `stdinFile` (M8 R5) to an absolute path: expand tokens,
   * then join to the step's resolved cwd unless already absolute. Undefined ⇒ no
   * stdin redirect (the child inherits the parent stdin).
   */
  function seedStdin(step: SeedStep): string | undefined {
    if (step.stdinFile === undefined) return undefined;
    const p = expandTokens(step.stdinFile, seedTokens, `seed.${step.id}.stdinFile`);
    return p.startsWith('/') ? p : joinPath(seedCwd(step), p);
  }

  /**
   * Run one seed step (+ its warn-mode optional tail). Returns false only on a
   * FATAL failure. A spawn-level throw (ENOENT — e.g. the owning repo isn't
   * cloned, so its `cwd` doesn't exist) is folded into a non-zero code BEFORE the
   * `failureMode` check, so a warn-mode step degrades to a warning instead of an
   * unhandled rejection (defense-in-depth for the repo-absent skip guard).
   */
  async function runSeedStep(step: SeedStep, phase: 'offline' | 'online', ran: SeedResult['ran']): Promise<boolean> {
    const { command, args } = head(seedArgs(step));
    let code: number;
    try {
      ({ code } = await runner.run({
        cwd: seedCwd(step),
        command,
        args,
        env: seedEnv(step),
        // M8 R5: pipe `stdinFile` (coach curriculum / playback bootstrap) to stdin.
        stdinFile: seedStdin(step),
        stdio: 'inherit',
      }));
    } catch {
      code = -1; // spawn failure (ENOENT etc.) — treat as non-zero, honour failureMode
    }

    // Optional tail steps (content demo-polls / legacy-poll; the coach curriculum's
    // second mongoimport; the playback bootstrap's migrate) are always warn-mode;
    // run them best-effort after the main step regardless of the main exit code —
    // and a spawn throw there is likewise swallowed (they never fail the seed).
    for (const sub of step.optionalSteps ?? []) {
      const sh = head(seedArgs(sub));
      try {
        await runner.run({
          cwd: seedCwd(sub),
          command: sh.command,
          args: sh.args,
          env: seedEnv(sub),
          stdinFile: seedStdin(sub),
          stdio: 'inherit',
        });
      } catch {
        // best-effort tail; a missing script/dir is a no-op warning, never fatal.
      }
    }

    if (code === 0 || step.failureMode === 'warn') {
      ran[phase].push(step.id);
      return true;
    }
    return false; // fatal failure
  }

  return {
    async up(services: ServiceId[]): Promise<UpResult> {
      // 0. AUTO-PULL (M9) — ff-only sibling sync BEFORE anything is built/migrated, so a
      // bare native `up` never runs a checkout silently behind origin (up.sh runs
      // `pull_repos` before mesh_up/prep). Warn-and-continue on every per-repo issue; a
      // fetch failure NEVER aborts. Runs only when a git seam is wired AND not opted out
      // (`--no-auto-pull` / `NO_AUTO_PULL` set `autoPull` false/absent) AND at SLOT 0.
      // SLOT GUARD (parity with the Connect-AV gate below): the ff-only sync MUTATES the
      // SHARED sibling checkouts (fetch + `merge --ff-only`), which belong to slot 0. A
      // `stack up --slot N` (N>0) that synced them could race a concurrent slot-0 up on
      // the same repos — so only a slot-0 up syncs siblings; slot > 0 skips auto-pull.
      let autoPull: AutoPullResult | undefined;
      if (runtime.gitRunner && runtime.autoPull && (runtime.slot ?? 0) === 0) {
        autoPull = await autoPullRepos({
          repos: autoPullRepoList(services, manifest, launchContext.repoRoots as Record<RepoKey, string>),
          mode: runtime.autoPull,
          git: runtime.gitRunner,
          // The `.git` existence check reuses the injected repo-dir predicate (a
          // `fs.existsSync` wrapper in production); absent ⇒ autoPullRepos defaults to
          // real existsSync. Tests inject it to drive the not-cloned gate fs-free.
          pathExists: runtime.repoDirExists,
        });
      }

      // 1+2. mesh: check_ports preflight → `make up` (whole mesh) → readiness-gate
      // the closure's mesh units. meshUp runs the preflight internally.
      const mesh = await meshUp({
        soaRoot: runtime.soaRoot,
        runner,
        exec: meshExec,
        portProbe,
        units: neededMesh(services, manifest),
        manifest,
        // M7: slot > 0 namespaces + offsets the mesh; slot 0 leaves both undefined/0.
        project: runtime.meshProject,
        meshOffset: runtime.meshOffset,
      });
      if (!mesh.ok) return { ok: false, autoPull, mesh, launched: [], skipped: [] };

      // 2.5. CONNECT AV (M9) — best-effort livekit + coturn from qboard's compose, right
      // after mesh-up (parity with up.sh's `connect_av_up`). ONLY at slot 0 (single-node
      // livekit :7880 bypasses the slot offset → split-brain at slot > 0) and ONLY when
      // connect is actually in the closure (a native improvement over up.sh's
      // unconditional call). Warn-only — a missing compose / name drift never aborts.
      let av: AvResult | undefined;
      if (
        runtime.connectAv &&
        (runtime.slot ?? 0) === 0 &&
        (services.includes('connect-api') || services.includes('connect-web'))
      ) {
        av = await startConnectAv((launchContext.repoRoots as Record<RepoKey, string>).QBOARD, runner);
      }

      // 3. skip any service whose sibling-repo checkout is absent — a missing repo
      // (e.g. the coach repo not cloned) is a WARNING, not a failure. Generic across
      // ALL services: resolve each service's repo dir and, if `repoDirExists` says it
      // is not on disk, drop it from the launch set. `repoDirExists` absent ⇒ assume
      // every repo is present (no skipping — the pre-guard behaviour).
      const repoDirExists = runtime.repoDirExists;
      const skipped: UpSkip[] = [];
      const launchable: ServiceId[] = [];
      for (const id of services) {
        const repo = getService(id, manifest).repo;
        const repoDir = launchContext.repoRoots[repo];
        if (repoDirExists && !repoDirExists(repoDir)) {
          skipped.push({
            id,
            repo,
            repoDir,
            message: `${id} skipped — repo dir ${repoDir} not present (${repo} repo not cloned)`,
          });
        } else {
          launchable.push(id);
        }
      }

      // 3b. transitively skip DEPENDENTS of a skipped service (#221 coach-deferral b):
      // a present service whose HARD runtime dependency (url/s2s/event — NOT a
      // frontend's `browser` fetch edge, which doesn't gate the process booting)
      // was repo-absent-skipped would launch orphaned and crash/misbehave against a
      // missing upstream — e.g. connect-api launching without a cloned rostering
      // (iam-api). Skip it too (warn, same philosophy: a missing checkout never
      // reddens the stack), attributing the root-cause absent repo. Fixpoint loop:
      // skips propagate down chains (a → b → c).
      let propagated = true;
      while (propagated) {
        propagated = false;
        const skippedIds = new Map(skipped.map((s) => [s.id, s] as const));
        const survivors: ServiceId[] = [];
        for (const id of launchable) {
          const def = getService(id, manifest);
          const missing = def.dependsOn.find(
            (dep) => skippedIds.has(dep) && def.depKinds[dep] !== 'browser',
          );
          if (missing === undefined) {
            survivors.push(id);
            continue;
          }
          const cause = skippedIds.get(missing)!;
          skipped.push({
            id,
            repo: cause.repo,
            repoDir: cause.repoDir,
            message: `${id} skipped — depends on ${missing}, which was skipped (repo dir ${cause.repoDir} not present — ${cause.repo} repo not cloned)`,
          });
          propagated = true;
        }
        launchable.length = 0;
        launchable.push(...survivors);
      }

      // 3.5. NATIVE PREP PASS (M8) — between mesh-up and the launch waves, in order
      // R1 build → R2 provision → R3 migrate, so a fresh checkout/volume provisions +
      // migrates ITSELF instead of relying on a prior up.sh run. Runs ONLY when the
      // caller wired `pgProbe` (production does; the facade unit/int tests don't, so
      // they stay byte-identical). Scoped to the LAUNCHABLE set (a repo-absent service
      // is neither prepped, provisioned, nor migrated — its cwd/DB would fail). All
      // three phases are IDEMPOTENT (fresh-skip / existence-guarded / apply-pending),
      // so a re-up on an already-prepped stack is a fast no-op and the soaked --only
      // path is unbroken. A fatal failure in any phase aborts the bring-up.
      let prep: PrepResult | undefined;
      let provision: ProvisionResult | undefined;
      let migrate: MigrateResult | undefined;
      if (runtime.pgProbe) {
        const dbs = neededDbs(launchable, manifest);
        const repoRoots = launchContext.repoRoots;
        const pgContainer = runtime.pgContainer ?? meshContainer(getMesh('postgres', manifest));

        // R1 — build/install/db:generate over the closure repos.
        prep = await prepClosure({
          services: launchable,
          dbs,
          repoRoots,
          runner,
          skipPrep: runtime.skipPrep,
          isFresh: runtime.prepIsFresh,
          writeStamp: runtime.prepWriteStamp,
          repairStaleDeps: runtime.prepRepairDeps,
          dbGenerateScan: runtime.prepDbGenerateScan,
          lock: runtime.prepLock,
          manifest,
        });
        if (!prep.ok) return { ok: false, autoPull, av, mesh, prep, launched: [], skipped };

        // R2 — idempotent role+DB provisioning fallback (coach_api #221 blocker incl.).
        provision = await provisionDbs({ dbs, pgContainer, runner, probe: runtime.pgProbe, manifest });
        if (!provision.ok) return { ok: false, autoPull, av, mesh, prep, provision, launched: [], skipped };

        // R3 — migrate every closure DB in canonical order (the three-way branch).
        migrate = await migrateClosure({
          dbs,
          pgContainer,
          meshOffset: runtime.meshOffset,
          repoRoots,
          runner,
          probe: runtime.pgProbe,
          manifest,
        });
        if (!migrate.ok) return { ok: false, autoPull, av, mesh, prep, provision, migrate, launched: [], skipped };
      }

      // 4. dash prelaunch hook — ONLY when saga-dash is actually launchable (it reads
      // static/config.local.json at page load, so the file must match the mode first).
      let dash: DashSyncResult | undefined;
      if (launchable.includes('saga-dash')) {
        dash = syncDashLocalDefaults(
          {
            sagaDashRoot: runtime.sagaDashRoot,
            tunnel: runtime.tunnel,
            tunnelDomain: runtime.tunnelDomain,
            // M7: slot > 0 stack lane WRITES config.local.json with the offset
            // localhost ports (launchContext.ports are already offset for the slot).
            slot: runtime.slot,
            stackPorts: launchContext.ports,
          },
          dashFs,
        );
      }

      // 4a. per-instance dash routing env (soa#328) — the SAME JSON the file hook
      // writes/would write, carried in saga-dash's OWN launch env as
      // DASH_CONFIG_LOCAL_JSON. A new saga-dash's dev server serves it back for
      // GET /config.local.json, so each dash instance gets ITS OWN routing from
      // its own process env instead of the shared static file (which stays, via
      // the hook above, as transitional back-compat for older saga-dash
      // checkouts). Null (slot-0 non-tunnel) ⇒ nothing injected — the launch env
      // stays byte-identical to today.
      const dashConfigJson = launchable.includes('saga-dash')
        ? buildDashLocalDefaultsJson({
            tunnel: runtime.tunnel,
            tunnelDomain: runtime.tunnelDomain,
            slot: runtime.slot,
            stackPorts: launchContext.ports,
          })
        : null;
      const dashConfigEnv: UpResult['dashConfigEnv'] =
        dashConfigJson !== null
          ? { mode: runtime.tunnel ? 'tunnel' : 'stack-slot', slot: runtime.slot ?? 0 }
          : undefined;

      // 4b. coach-web prelaunch hook (soa#300) — ONLY when coach-web is launchable AND
      // the seam is wired. coach-web is a SvelteKit adapter-static SPA that INLINES its
      // PUBLIC_* URLs from `.env` at vite-dev start; the checked-in `.env` points at
      // REMOTE hosts (…wootdev.com) + the base coach-api port, so its browser boots
      // against remote/wrong hosts → whoami fails → it renders a 503 sign-in error and
      // NO route renders. Write a per-slot `.env.local` (> `.env` in Vite; gitignored)
      // mapping each PUBLIC_ var to THIS slot's LOCAL mesh offset port so the browser
      // boots against the local stack. `launchContext.ports` are already slot-offset
      // (same map the dash hook uses). Runs at EVERY slot including 0 (the remote
      // defaults break local browser-testing at slot 0 too — the original soa#300);
      // no-ops under tunnel (public coach-web URLs are a separate concern).
      let coachWeb: CoachWebSyncResult | undefined;
      if (launchable.includes('coach-web') && runtime.coachWebFs) {
        const coachRoot = (launchContext.repoRoots as Record<RepoKey, string>).COACH;
        coachWeb = syncCoachWebEnvLocal(
          {
            coachWebRoot: joinPath(coachRoot, 'apps/web/coach-web'),
            tunnel: runtime.tunnel,
            slot: runtime.slot,
            stackPorts: launchContext.ports,
          },
          runtime.coachWebFs,
        );
      }

      // 5. launch the launchable set in topo WAVES — health-gate each wave before the
      // next. Reuse the faithful per-service spec builder (launchPlan), then regroup
      // the flat specs into waves via launchOrder so dependents only start once their
      // deps are healthy. Both are computed over `launchable` so a skipped service is
      // neither planned nor ordered against.
      const byId = new Map(launchPlan(manifest, launchable, lane, launchContext).map((s) => [s.id, s]));
      const waves = launchOrder(launchable, manifest);
      const launched: LaunchResult[] = [];
      for (const wave of waves) {
        const results = await Promise.all(
          wave.map((id) => {
            const spec = byId.get(id);
            /* c8 ignore next — every wave id comes from the same closure as the specs. */
            if (!spec) throw new Error(`stack-api: no launch spec for ${id}`);
            const argv = spec.command.split(/\s+/);
            // M7: frontends bake their BASE listen-port into the repo dev script /
            // vite config, so at an offset slot they'd bind slot 0's port. For any
            // `isFrontend` service at slot > 0, append `--port <base+offset>`
            // (`launchContext.ports[id]` is already the slot's offset port). vite/cac
            // honours the LAST `--port`, overriding the baked-in flag + config.
            // Appended WITHOUT a `--` separator: `pnpm dev --port N` forwards the flag
            // through to vite, whereas `pnpm dev -- --port N` makes pnpm inject a
            // literal `--` that vite treats as end-of-options (the flag is dropped and
            // the base port wins — verified empirically). At slot 0 (slot falsy /
            // offset 0) nothing is appended, so the command is byte-identical to today.
            if (getService(id, manifest).isFrontend && (runtime.slot ?? 0) > 0) {
              argv.push('--port', String(launchContext.ports[id]));
            }
            const { command, args } = head(argv);
            return launcher.launch({
              id,
              cwd: spec.cwd,
              command,
              args,
              // soa#328: saga-dash carries its own routing JSON in its launch env
              // (tunnel / slot > 0 only — dashConfigJson is null otherwise).
              env:
                id === 'saga-dash' && dashConfigJson !== null
                  ? { ...spec.env, [DASH_CONFIG_ENV_VAR]: dashConfigJson }
                  : spec.env,
              healthUrl: spec.healthUrl,
              // Guard the `alreadyUp` adoption on the service's contract keys (iam-api's
              // JWT_ISSUER) so a drifted/foreign already-up process is refused, not adopted
              // with a stale env the CLI's stamp never reached (soa#305).
              adoptEnv: getService(id, manifest).adoptEnv,
            });
          }),
        );
        launched.push(...results);
        const failed = results.find((r) => !r.ok);
        if (failed) {
          return { ok: false, autoPull, av, mesh, prep, provision, migrate, dash, dashConfigEnv, coachWeb, launched, skipped, failedAt: failed.id as ServiceId, failedReason: failed.reason };
        }
      }

      // 6. RECORD (Phase 2, `--record [crdt|av]`) — start the fleek recording sidecars
      // AFTER the launch waves (connect-api must be up for the recorder to observe it).
      // Fleek-gated: a missing fleek checkout is a WARNING skip (like a repo-absent
      // service), never a failure. The seam does the real docker-compose + CodeArtifact
      // bring-up; absent ⇒ planned + gated but not executed (facade unit tests stay IO-free).
      let record: RecordResult | undefined;
      if (runtime.record) {
        const repoRoots = launchContext.repoRoots as Record<RepoKey, string>;
        const fleekRoot = repoRoots.FLEEK;
        if (runtime.repoDirExists && !runtime.repoDirExists(fleekRoot)) {
          record = {
            mode: runtime.record,
            ok: false,
            skipped: true,
            services: [],
            message: `⚠ --record skipped — fleek repo dir ${fleekRoot} not present (clone git@github.com:saga-ed/fleek.git)`,
          };
        } else {
          const plan = recordPlan(runtime.record, {
            fleekRoot,
            recordingsDir: runtime.recordingsDir ?? `${process.env.HOME ?? ''}/.fleek-local/recordings`,
            rtsmPort: Number(tokens.RTSM_PORT),
            devUserUuid: tokens.DEV_USER_UUID as string,
            connectWebUrl: tokens.CONNECT_WEB_URL as string,
            sagaApiTarget: tokens.SAGA_API_TARGET as string,
          });
          if (runtime.recordUp) {
            const res = await runtime.recordUp(plan, { qboardRoot: repoRoots.QBOARD });
            record = { mode: plan.mode, ok: res.ok, skipped: false, services: plan.services, message: res.message };
          } else {
            record = {
              mode: plan.mode,
              ok: false,
              skipped: false,
              services: plan.services,
              message: `record plan resolved (${plan.services.join(', ')}) — no recordUp seam wired`,
            };
          }
        }
      }

      return { ok: true, autoPull, av, mesh, prep, provision, migrate, dash, dashConfigEnv, coachWeb, launched, skipped, record };
    },

    async down(services: ServiceId[]): Promise<DownResult> {
      // Stop in reverse launch order (dependents before deps) — cosmetic for a
      // kill, but keeps the teardown symmetric with the bring-up.
      const order = launchOrder(services, manifest).flat().reverse();
      const stopped = await launcher.stopServices(order);
      return { stopped };
    },

    async restart(services: ServiceId[]): Promise<RestartOutcome> {
      // Native `restart` (M9 — up.sh `restart`, ~2293-2306): a clean bounce with NO
      // data wipe. down → vite-clear → up, in that order.
      //
      // 1. down — GROUP-reap the running servers via the dir-scoped
      //    `stopServices(stateDir)` (the SAME group-killer `down --slot N` uses), NOT
      //    the leader-only `launcher.stopServices`. A naive `kill(pid)` on the positive
      //    LEADER leaves the `tsup --watch` child + the port-holding `node dist/main.js`
      //    GRANDCHILD alive; the follow-up `up()` then health-probes that STALE server,
      //    sees it still 200-ing, returns `alreadyUp`, and NEVER launches the fresh code
      //    — the exact stale-bundle/port-hold trap `restart` exists to escape. The group
      //    reap (`kill(-pid, …)` SIGTERM→grace→SIGKILL) takes down the whole subtree and
      //    frees the port so `up()` boots fresh. STILL a DELIBERATE DIVERGENCE from
      //    up.sh's `services_down`: no host-global `pkill -f tsup` / `fuser -k <port>` —
      //    the stopper only ever enumerates THIS state dir's pidfiles, so it is dir-scoped
      //    / slot-safe and never crosses a peer slot. Falls back to the pidfile leader
      //    method only when no stopper/stateDir seam is wired (facade unit tests).
      let down: DownResult;
      let reaped: StopServiceResult[] | undefined;
      if (runtime.serviceStopper && runtime.stateDir !== undefined) {
        reaped = await runtime.serviceStopper(runtime.stateDir);
        down = {
          stopped: reaped.map((r) => ({
            id: r.id,
            // A server still `alive` after SIGKILL was NOT stopped — never report a
            // surviving (stale-serving) process as down.
            stopped: r.outcome === 'term' || r.outcome === 'kill',
            pid: r.pid,
          })),
        };
      } else {
        down = await this.down(services);
      }

      // 2. vite-clear — drop the stale optimized-bundle caches (up.sh `nuke_vite`) so a
      //    dead watcher can't serve old JS. Paths are byte-faithful to up.sh; skipped
      //    when no seam is wired.
      let vite: ViteClearResult | undefined;
      if (runtime.viteClear) {
        const repoRoots = launchContext.repoRoots as Record<RepoKey, string>;
        vite = await runtime.viteClear.clear(
          viteCachePaths({ sagaDashRoot: repoRoots.SAGA_DASH, qboardRoot: repoRoots.QBOARD }),
        );
      }

      // 3. up — the SAME native bring-up (mesh + prep + launch + auto-pull + AV). NO
      //    reset (restart never truncates data); the caller passes only the closure.
      const up = await this.up(services);
      return { down, reaped, vite, up };
    },

    async reset(services: ServiceId[], opts: ResetOpts = {}): Promise<ResetOutcome> {
      // M8 R4 — NATIVE reset: truncate the closure's DBs to an empty baseline
      // (preserving `_prisma_migrations`), migrate-reset ledger, drop connectv3,
      // then re-seed the dev user via the EXISTING seed path. Slot-aware: the
      // resolved slot containers + offset (computed at facade scope).
      const dbs = neededDbs(services, manifest);
      const native = await resetClosure({
        dbs,
        pgContainer,
        mongoContainer,
        repoRoots: launchContext.repoRoots,
        meshOffset: runtime.meshOffset,
        withPlayback: opts.withPlayback,
        withAuthz: opts.withAuthz,
        runner,
        // R2/R3 probe seam: SKIP (don't truncate/migrate-reset) a pg DB that a partial
        // `up` never provisioned (e.g. coach_api) — matches up.sh's reset_data tolerance,
        // so a bare reset after a partial up exits 0 instead of erroring on the absent DB.
        probe: runtime.pgProbe,
        manifest,
      });

      // Dev-user re-seed (up.sh:1695-1696) through the existing seed path — reuse the
      // canonical `iam-dev-user` SeedStep so its env handling stays in ONE place.
      // Only when iam-api is in the reset closure (its DBs were just truncated).
      let seed: SeedResult | undefined;
      if (services.includes('iam-api')) {
        const ran: SeedResult['ran'] = { offline: [], online: [] };
        const registry = buildSeedRegistry(manifest);
        // soa#253 recurrence guard: resetClosure() truncated iam_local's permission
        // catalog (incl. session perms 053/054/055), and a truncate never re-migrates.
        // So `iam-registry` MUST run before the `iam-dev-user` dev-admin grant — else
        // applyDevAdminGrant refuses (missing session perms) and dev regresses to
        // DEFAULT_USER_BUNDLE (saga-dash#209.10/#209.1). Registry is FATAL (a failed
        // registry means the grant can't be provisioned safely); dev-user stays warn.
        const registryStep = registry['iam-registry'];
        const registryOk = await runSeedStep(registryStep, 'offline', ran);
        const devUser = registry['iam-dev-user'];
        const devUserOk = registryOk && (await runSeedStep(devUser, 'offline', ran));
        const ok = registryOk && devUserOk;
        seed = {
          ok,
          ran,
          skipped: [],
          ...(ok ? {} : { failed: registryOk ? devUser.id : registryStep.id }),
        };
      }

      // EXIT-CODE CONTRACT (M8 fold-in): up.sh's reset always exits 0 (per-DB failures
      // are warn-only), so a wrapper `stack reset && stack up` must not break where
      // up.sh didn't. We keep native reset's exit code MEANINGFUL for real data
      // failures — a failed TRUNCATE or the mongo drop (the CORE reset set) or the
      // dev-user re-seed DOES flip the code to 1 — but a failed ledger MIGRATE-RESET is
      // treated as a WARNING on the exit code (still recorded ok:false in `native.dbs`
      // and surfaced by the command). Rationale: the most realistic divergence is a
      // ledger migrate hiccup while all the core truncates + the mongo drop succeeded;
      // that end-state (empty core DBs) matches up.sh, so it should not fail the command.
      const coreOk = native.dbs.every((d) => d.action === 'migrate-reset' || d.ok);
      const code = coreOk && (seed?.ok ?? true) ? 0 : 1;
      return { code, native, seed };
    },

    async seed(plan: SeedPlan): Promise<SeedResult> {
      const ran: SeedResult['ran'] = { offline: [], online: [] };
      // Offline steps first (pre/independent of service readiness), then online
      // steps (deferred until their services are up — which `up` guaranteed).
      for (const step of plan.offline) {
        if (!(await runSeedStep(step, 'offline', ran))) {
          return { ok: false, ran, failed: step.id, skipped: plan.skipped };
        }
      }
      for (const step of plan.online) {
        if (!(await runSeedStep(step, 'online', ran))) {
          return { ok: false, ran, failed: step.id, skipped: plan.skipped };
        }
      }
      return { ok: true, ran, skipped: plan.skipped };
    },

    async verify(probes: HealthProbe[], opts: VerifyOpts = {}): Promise<VerifyResult> {
      const tolerate = new Set(opts.tolerate ?? []);
      const rows = await Promise.all(
        probes.map(async (p): Promise<VerifyRow> => {
          const r = await prober.probe(p.url);
          return {
            id: p.id,
            url: p.url,
            ok: r.ok,
            status: r.status,
            tolerated: !r.ok && isTolerated(p.id, tolerate, manifest),
          };
        }),
      );
      const passed = rows.every((r) => r.ok || r.tolerated);
      return { passed, rows };
    },
  };
}

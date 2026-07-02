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
 *  - `reset` — DELEGATED for M4. Native partial reset is M6; for M4 it delegates
 *              to `up.sh --reset` through the M1 script `delegate` (lower-risk
 *              than re-implementing the truncate + re-seed matrix). See `reset`.
 *  - `login` — DELEGATED for M4. Browser-session minting is not ported natively;
 *              delegates to `up.sh --login [email]`. See `login`.
 *
 * INVARIANT (plan hard constraint): this file imports pure `core` planners and
 * the `runtime` seams, but performs NO direct IO of its own — every spawn /
 * docker / fetch / fs touch happens behind a seam the caller injected.
 */

import * as flagMap from './core/flag-map.js';
import type { ScriptPlan } from './core/flag-map.js';
import { launchPlan } from './core/launch-plan.js';
import type { LaunchContext } from './core/launch-plan.js';
import { launchOrder } from './core/launch-order.js';
import { getMesh, getService, manifest as defaultManifest } from './core/manifest/index.js';
import type { DbId, Lane, Manifest, MeshId, RepoKey, ServiceId } from './core/manifest/index.js';
import type { HealthProbe } from './core/probe-plan.js';
import type { SeedPlan, SeedStep, SkipNote } from './core/seed/types.js';
import {
  meshContainer,
  meshUp,
  migrateClosure,
  prepClosure,
  provisionDbs,
  syncDashLocalDefaults,
} from './runtime/index.js';
import type {
  DashFs,
  DashSyncResult,
  HealthProber,
  LaunchResult,
  MeshExec,
  MeshResult,
  MigrateResult,
  PgProbe,
  PortProbe,
  PrepResult,
  ProvisionResult,
  Runner,
  ServiceLauncher,
  StopResult,
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
   * Delegate a wrapped bash `ScriptPlan` to up.sh (the M1 Runner + script path),
   * returning its exit code. M4 wires `reset`/`login` through this because their
   * native ports are M6+. The command layer points it at `BaseCommand.runScript`
   * so script-path resolution stays in ONE place. Absent ⇒ `reset`/`login` throw.
   */
  delegate?: (plan: ScriptPlan) => Promise<number>;
  /** Manifest (defaults to the frozen one). */
  manifest?: Manifest;
}

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

/** The outcome of a native `up`. */
export interface UpResult {
  /** True iff the mesh came ready, the dash hook ran (if needed), and every launched wave went healthy. */
  ok: boolean;
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
  /** Per-service launch results, in the order launched (topo waves flattened). */
  launched: LaunchResult[];
  /** Services skipped because their repo checkout dir is absent (warn, not fail). */
  skipped: UpSkip[];
  /** The first service that failed health (set only when `ok` is false at the service stage). */
  failedAt?: ServiceId;
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

/** The outcome of a DELEGATED `reset` / `login` (M4 wraps up.sh). */
export interface DelegatedResult {
  /** Always true for M4 (the op was delegated to up.sh). */
  delegated: boolean;
  /** up.sh's exit code. */
  code: number;
}

/** Per-call `up` knobs (reserved; tunnel/tunnelDomain live on the `Runtime`). */
export interface UpOpts {
  /** Reserved for future per-call overrides. */
  readonly _?: never;
}

/** Optional `verify` knobs. */
export interface VerifyOpts {
  /** Tokens (service id OR repo name) whose down state does NOT fail the gate. */
  tolerate?: string[];
}

/** The six-method in-process facade (plan §6.3). */
export interface StackApi {
  up(closureServices: ServiceId[], opts?: UpOpts): Promise<UpResult>;
  down(closureServices: ServiceId[]): Promise<DownResult>;
  reset(closureServices: ServiceId[]): Promise<DelegatedResult>;
  seed(plan: SeedPlan): Promise<SeedResult>;
  verify(probes: HealthProbe[], opts?: VerifyOpts): Promise<VerifyResult>;
  login(user?: string): Promise<DelegatedResult>;
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

  /** Resolve a seed step's cwd: owning service's repo root + step.cwd. */
  function seedCwd(step: SeedStep): string {
    // up.sh's content demo-polls runs from the synthetic-dev tool dir ($SCRIPT_DIR),
    // which lives under SOA — not the owning service's repo. Honour that one shim.
    if (step.cwd.startsWith('tools/synthetic-dev')) {
      return joinPath(launchContext.repoRoots.SOA, step.cwd);
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
      out[k] = expandTokens(v, tokens, `seed.${step.id}.env.${k}`);
    }
    return out;
  }

  /**
   * Run one seed step (+ its warn-mode optional tail). Returns false only on a
   * FATAL failure. A spawn-level throw (ENOENT — e.g. the owning repo isn't
   * cloned, so its `cwd` doesn't exist) is folded into a non-zero code BEFORE the
   * `failureMode` check, so a warn-mode step degrades to a warning instead of an
   * unhandled rejection (defense-in-depth for the repo-absent skip guard).
   */
  async function runSeedStep(step: SeedStep, phase: 'offline' | 'online', ran: SeedResult['ran']): Promise<boolean> {
    const { command, args } = head(step.command);
    let code: number;
    try {
      ({ code } = await runner.run({
        cwd: seedCwd(step),
        command,
        args,
        env: seedEnv(step),
        stdio: 'inherit',
      }));
    } catch {
      code = -1; // spawn failure (ENOENT etc.) — treat as non-zero, honour failureMode
    }

    // Optional tail steps (content demo-polls / legacy-poll) are always warn-mode;
    // run them best-effort after the main step regardless of the main exit code —
    // and a spawn throw there is likewise swallowed (they never fail the seed).
    for (const sub of step.optionalSteps ?? []) {
      const sh = head(sub.command);
      try {
        await runner.run({ cwd: seedCwd(sub), command: sh.command, args: sh.args, env: seedEnv(sub), stdio: 'inherit' });
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
    async up(services: ServiceId[], _opts: UpOpts = {}): Promise<UpResult> {
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
      if (!mesh.ok) return { ok: false, mesh, launched: [], skipped: [] };

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
          dbGenerateScan: runtime.prepDbGenerateScan,
          manifest,
        });
        if (!prep.ok) return { ok: false, mesh, prep, launched: [], skipped };

        // R2 — idempotent role+DB provisioning fallback (coach_api #221 blocker incl.).
        provision = await provisionDbs({ dbs, pgContainer, runner, probe: runtime.pgProbe, manifest });
        if (!provision.ok) return { ok: false, mesh, prep, provision, launched: [], skipped };

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
        if (!migrate.ok) return { ok: false, mesh, prep, provision, migrate, launched: [], skipped };
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
              env: spec.env,
              healthUrl: spec.healthUrl,
            });
          }),
        );
        launched.push(...results);
        const failed = results.find((r) => !r.ok);
        if (failed) {
          return { ok: false, mesh, prep, provision, migrate, dash, launched, skipped, failedAt: failed.id as ServiceId };
        }
      }

      return { ok: true, mesh, prep, provision, migrate, dash, launched, skipped };
    },

    async down(services: ServiceId[]): Promise<DownResult> {
      // Stop in reverse launch order (dependents before deps) — cosmetic for a
      // kill, but keeps the teardown symmetric with the bring-up.
      const order = launchOrder(services, manifest).flat().reverse();
      const stopped = await launcher.stopServices(order);
      return { stopped };
    },

    async reset(_services: ServiceId[]): Promise<DelegatedResult> {
      // M4: native partial reset is M6. Delegate to `up.sh --reset` (whole-stack
      // truncate + re-seed) via the M1 script path — lower-risk than porting the
      // per-DB truncate/migrate-reset matrix now. `_services` is accepted for the
      // future native partial reset but is unused in the delegated path.
      if (!runtime.delegate) {
        throw new Error('stack reset: native partial reset is M6; no up.sh delegate wired into this Runtime');
      }
      const code = await runtime.delegate(flagMap.reset({}));
      return { delegated: true, code };
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

    async login(user?: string): Promise<DelegatedResult> {
      // M4: browser-session minting is not ported natively. Delegate to
      // `up.sh --login [email]` via the M1 script path.
      if (!runtime.delegate) {
        throw new Error('stack login: native login is a later milestone; no up.sh delegate wired into this Runtime');
      }
      const code = await runtime.delegate(flagMap.login(user));
      return { delegated: true, code };
    },
  };
}

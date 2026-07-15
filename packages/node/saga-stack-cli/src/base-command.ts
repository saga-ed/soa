/**
 * BaseCommand — every saga-stack command extends this.
 *
 * Carries the shared global flags (`--porcelain` / `--output-json` / `--dev`
 * / `--state-dir` + per-repo overrides — see shared-flags.ts) and a shared
 * `emit()` helper that renders a result in the caller's chosen shape
 * (JSON / porcelain key=value / human lines).
 *
 * It also owns the M1 PROCESS SEAM (plan §7.2). Two protected methods compose
 * the thin wrapper commands:
 *   - `getRunner()` returns the injectable `Runner`. Production returns
 *     `makeRealRunner()` (the only place a real OS process is launched); tests
 *     substitute a fake by spying `BaseCommand.prototype.getRunner`. THIS is the
 *     single seam the M1 golden tests mock — see the wiring note in the report.
 *   - `runScript()` turns a pure `ScriptPlan` (from `core/flag-map`) into a
 *     fully-resolved `ScriptInvocation` (absolute script path + cwd + repo-path
 *     env from the workspace flags) and hands it to the Runner, propagating the
 *     child exit code (read-only commands opt out via `propagateExit:false`).
 *
 * ── THE SEAM-GETTER PATTERN ──
 * Roughly two dozen protected `getX()` methods below are injectable SEAMS.
 * Uniformly: production returns a real implementation (`makeRealX()`) that is
 * THE single place its real side-effect happens (a spawned child, a network
 * probe, a `docker exec`, an fs write), and every one is designed to be spied
 * on the prototype (`BaseCommand.prototype.getX`) so a test can swap in a fake
 * and assert the PLAN without the real effect. That prototype-spy-ability IS the
 * test architecture: these getters MUST stay instance methods on the prototype
 * (never inlined or hoisted to free functions) or the suite loses its seams. So
 * each getter's own doc below states only WHAT it returns + its load-bearing
 * side-effect; the spy mechanism is uniform and documented here, once.
 *
 * Subclass flag sets MUST spread `...BaseCommand.baseFlags` so the shared
 * flags stay attached. Top-level error handling is delegated to oclif's
 * default handler — don't override it.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { Command } from '@oclif/core';
import type { Interfaces } from '@oclif/core';
import { dirname, join } from 'node:path';
import { SET_UNSUPPORTED_COMMAND_MESSAGE, SLOT_UNSUPPORTED_COMMAND_MESSAGE, baseFlags } from './shared-flags.js';
import { applySetToFlags, resolveSet } from './core/set/index.js';
import type { SetInjectableFlags, WorktreeSet } from './core/set/index.js';
import { checkWorktreeSet, makeCheckpointStore, makeSlotActiveProbe } from './runtime/index.js';
import { stampMatches, writeStamp } from './runtime/prep-stamp.js';
import { repairStaleDeps } from './runtime/prep-repair.js';
import type { CheckpointStore, SlotActiveProbe } from './runtime/index.js';
import type { PullMode } from './core/auto-pull.js';
import type { InstanceProfile } from './core/derive-instance.js';
import type { RecordMode, ScriptPlan } from './core/flag-map.js';
import { defaultLaunchContext } from './core/launch-plan.js';
import { resolveIamUrl } from './core/login.js';
import type { RepoKey as ManifestRepoKey } from './core/manifest/index.js';
import type { RecordUp, Runtime } from './stack-api.js';
import { COOKIE_JAR_FILE, nativeLogin } from './runtime/login.js';
import type { NativeLoginResult } from './runtime/login.js';
import { type FrontendRegistryIo, makeRealFrontendRegistryIo } from './runtime/frontend-registry.js';
import {
  buildRepoEnv,
  makeRealConfirm,
  makeRealCookiePoster,
  makeRealDashFs,
  makeRealGhRunner,
  makeRealGitRunner,
  makeRealJarWriter,
  makeRealLauncher,
  makeRealMeshExec,
  makeRealOrphanScanner,
  makeRealPgProbe,
  makeRealOverlayFs,
  makeRealPortProbe,
  makeRealProber,
  makeRealRecordUp,
  makeRealRunner,
  makeRealPrepLock,
  makeRealSetStore,
  repoContextFromFlags,
  repoOverridesFromFlags,
  makeRealSnapshotIO,
  makeRealViteClear,
  makeRealDockerWipe,
  makeRealBuildCleaner,
  makeRealEnvFs,
  makeRealForeignProcs,
  generateTunnelFleetConfig,
  generateSlotFleetConfig,
  resolveRepoRoot,
  resolveTunnelMoniker,
  resolveFleekLivekitCreds,
  resolveScript,
  resolveVendorScript,
  scriptCwd,
  stopServices,
  REPO_DEFAULT_DIR,
} from './runtime/index.js';
import type {
  ConfirmSeam,
  CookiePoster,
  DashFs,
  GhRunner,
  GitRunner,
  HealthProber,
  JarWriter,
  LockHolder,
  MeshExec,
  OrphanScanner,
  OverlayFs,
  PgProbe,
  PortProbe,
  RepoKey,
  Runner,
  ScriptContext,
  SetStore,
  ServiceLauncher,
  ServiceStopper,
  SnapshotIO,
  ViteClear,
  DockerWipe,
  BuildCleaner,
  EnvFs,
  ForeignProcs,
} from './runtime/index.js';

/**
 * The subset of the parsed global flags `runScript` reads to locate the script
 * and build the per-repo path env. Every wrapper command's `flags` satisfies
 * this because they all spread `BaseCommand.baseFlags`.
 */
export type WorkspaceFlags = {
  dev?: string;
} & Partial<Record<RepoKey, string>>;

/**
 * The flags `buildNativeRuntime` reads: the workspace flags plus the optional
 * `--state-dir` (launcher pid/log dir) and `--skip-prep` (M8 R1 skip). Every
 * native command's parsed flags satisfy this (all spread `baseFlags`; `--skip-prep`
 * is undefined for commands that don't declare it, which the prep pass tolerates).
 */
export type NativeRuntimeFlags = WorkspaceFlags & {
  'state-dir'?: string;
  'skip-prep'?: boolean;
  /** M9 auto-pull: `--pull` ⇒ `all` mode. Undefined for commands that don't declare it. */
  pull?: boolean;
  /** M9 auto-pull: `--no-auto-pull` ⇒ opt out. Undefined for commands that don't declare it. */
  'no-auto-pull'?: boolean;
  /**
   * `--yes`: non-interactive. Among other uses, auto-reclaims an abandoned (STOPPED)
   * prep lock — killing the stopped holder — instead of prompting. Undefined for
   * commands that don't declare it (⇒ prompt on a TTY, fail fast otherwise).
   */
  yes?: boolean;
};

/**
 * Phase-2 lane/record overlays `buildNativeRuntime` threads into the launch
 * context + runtime (saga-ed/soa#214). Only `stack up` passes these (for
 * `--sandbox`/`--tunnel`/`--record`); every other native command omits them, so
 * its runtime is byte-identical to the pre-Phase-2 build.
 */
export type NativeOverlays = {
  /** `--sandbox <name>` (+ base) ⇒ the `sandbox_env` dep-repoint overlay. */
  sandbox?: { name: string; base?: string };
  /** `--tunnel` ⇒ the `tunnel_env` browser-plane overlay (domain from `tunnel.sh moniker`). */
  tunnel?: { domain: string; rtsmFleetPath?: string; lkKey?: string; lkSecret?: string };
  /** `--record [crdt|av]` ⇒ start the fleek recording stack after launch. */
  record?: RecordMode;
  /** The `--record` bring-up seam (production shells docker/aws; tests inject a fake). */
  recordUp?: RecordUp;
  /** Per-user recordings dir override (up.sh `$FLEEK_REC_DIR`). */
  recordingsDir?: string;
  /**
   * `--with authz` ⇒ the OpenFGA authz overlay: `withAuthz: true` (drives
   * `FGA_ENABLED`) plus the bootstrapped store id, if one exists on this machine
   * yet (see `resolveOpenfgaStoreId`). Absent for every command that doesn't
   * select the `authz` bundle, so its runtime is byte-identical to before this
   * feature existed.
   */
  authz?: { withAuthz: boolean; storeId?: string };
};

export abstract class BaseCommand extends Command {
  static baseFlags = baseFlags;

  /**
   * Whether THIS command supports `--slot > 0` (M7 Phase 2). Default `false` —
   * the central guard in `parse` rejects a `--slot > 0` for any command that does
   * not opt in, so an un-slot-safe command (the wrapper-lifecycle set, login,
   * tunnel, snapshot, …) fails fast rather than half-running against a peer slot's
   * data on up.sh's host-global lifecycle. `stack up`/`status`/`verify`/`down`
   * override this to `true`. Slot 0 (the default) is accepted everywhere.
   */
  protected slotAware(): boolean {
    return false;
  }

  /**
   * Whether THIS command supports `--set <name>` (M13-A worktree sets). Default
   * `false` — the central guard in `parse` rejects `--set` for any command that
   * does not opt in. A set = repo paths + a slot ≥ 1, so every set-aware command
   * must also be `slotAware()`; the lifecycle set (`up/down/status/verify/reset/
   * seed/snapshot`) and `e2e run` override this to `true`.
   */
  protected setAware(): boolean {
    return false;
  }

  /**
   * The worktree-set store seam (M13-A). Production reads
   * `$SAGA_STACK_SETS ?? ~/.saga-stack/worktree-sets.json`.
   */
  protected getSetStore(): SetStore {
    return makeRealSetStore();
  }

  /**
   * The slot-activity probe (M13-A `set list` ACTIVE column, M13-B up-time
   * collision check). Derived LIVE from state-dir pid liveness + compose
   * containers — no recorded active state.
   */
  protected getSlotActiveProbe(): SlotActiveProbe {
    return makeSlotActiveProbe();
  }

  /**
   * The M14 stage-checkpoint store (`e2e run --snapshot-stages` / `--from`).
   * Composes the SnapshotIO seam with the caller's ScriptContext (the
   * schema-ahead guard's migration discovery — `--set` pins included). MUST be
   * constructed after `applyInstanceEnv` so it targets the slot's snapshot root
   * + containers.
   */
  protected getCheckpointStore(ctx: ScriptContext): CheckpointStore {
    return makeCheckpointStore({ io: this.getSnapshotIO(), ctx });
  }

  /**
   * M13-B: the IMPLICIT set check at run time (plan §2.4/§4 layer 1). A no-op
   * without `--set`. Violations (missing/non-checkout paths, buildable entry at
   * the primary checkout unless `--allow-primary`, cross-set build collisions —
   * sharpened with live ACTIVE-slot detection) are a HARD error before any
   * stack mutation; warnings (branch drift, pre-built-at-primary) just print.
   */
  protected async runSetPreflight(
    flags: { set?: string; dev?: string } & { 'allow-primary'?: boolean },
  ): Promise<void> {
    if (flags.set === undefined) return;
    const file = this.getSetStore().load();
    const set = resolveSet(file, flags.set); // parse() already validated the name; cheap re-resolve
    const result = await checkWorktreeSet(set, file.sets, {
      git: this.getGitRunner(),
      isPrebuilt: this.getPrepFreshCheck(),
      devRoot: flags.dev ?? join(process.env.HOME ?? '~', 'dev'),
      activeProbe: this.getSlotActiveProbe(),
      allowPrimary: flags['allow-primary'] === true,
    });
    for (const repo of result.repos) {
      for (const w of repo.warnings) this.log(`⚠ set ${set.name}/${repo.repo}: ${w}`);
    }
    if (result.violationCount > 0) {
      const lines = result.repos.flatMap((r) => r.violations.map((v) => `${r.repo}: ${v}`));
      this.error(
        `set '${set.name}' failed the preflight check — fix the set (or run \`ss set check ${set.name}\`):\n` +
          lines.map((l) => `  ✗ ${l}`).join('\n'),
      );
    }
  }

  /**
   * Parse + a CENTRAL slot guard. `--slot` lives on `baseFlags`, so every command
   * accepts it — but only the slot-aware commands (`slotAware()` ⇒ true) wire the
   * mesh-project / container / offset threading that makes `--slot > 0` isolated.
   * A `--slot > 0` on a NON-slot-aware command must fail fast here rather than
   * half-run at the base ports / on up.sh's host-global teardown and clobber a live
   * default stack. Slot 0 (the default) is completely unaffected.
   *
   * The structural generic bounds mirror oclif's own `Command.parse` signature
   * (`FlagOutput`/`ArgOutput` are `{ [k: string]: any }`) so this is a faithful
   * override, not a widening.
   */
  protected async parse<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    F extends { [flag: string]: any },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    B extends { [flag: string]: any },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    A extends { [arg: string]: any },
  >(
    options?: Interfaces.Input<F, B, A>,
    argv?: string[],
  ): Promise<Interfaces.ParserOutput<F, B, A>> {
    const result = await super.parse<F, B, A>(options, argv);

    // ── M13-A: the ONE set-injection site. Every downstream ScriptContext /
    // repo-env / `deriveInstance({slot})` consumer reads this parsed flags bag
    // (there are seven independent builders), so rewriting it here threads the
    // set through all of them. Runs BEFORE the slot guard so a set's slot is
    // guarded exactly like a typed `--slot`.
    const setName = (result.flags as { set?: unknown }).set;
    if (typeof setName === 'string') {
      if (!this.setAware()) this.error(SET_UNSUPPORTED_COMMAND_MESSAGE);

      // Flags the user ACTUALLY typed (oclif raw tokens) — the only way to tell
      // a typed `--saga-dash` from one defaulted off `$SAGA_DASH` (repo flags
      // bake env vars in as oclif defaults). Typed flags beat the set.
      const typed = new Set(
        result.raw
          .filter((t): t is { type: 'flag'; flag: string; input: string } => t.type === 'flag')
          .map((t) => t.flag),
      );

      let set: WorktreeSet;
      try {
        set = resolveSet(this.getSetStore().load(), setName);
      } catch (err) {
        return this.error((err as Error).message);
      }

      // The set OWNS its slot (plan §3): a user-typed `--slot N` that disagrees
      // is a hard error, never a silent retarget. An untyped `--slot` is just
      // oclif's default 0 and is overwritten by the injection below.
      const typedSlot = (result.flags as { slot?: unknown }).slot;
      if (typed.has('slot') && typedSlot !== set.slot) {
        this.error(
          `set '${set.name}' is bound to slot ${set.slot} — drop --slot or edit the set ` +
            `(got --slot ${typedSlot}).`,
        );
      }

      applySetToFlags(result.flags as SetInjectableFlags, typed, set);
    }

    const slot = (result.flags as { slot?: unknown }).slot;
    if (typeof slot === 'number' && slot > 0 && !this.slotAware()) {
      this.error(SLOT_UNSUPPORTED_COMMAND_MESSAGE);
    }
    return result;
  }

  /**
   * Apply a slot's `InstanceProfile` to `process.env` (M7 Phase 2 — the "env
   * seam"). Sets the `SAGA_MESH_*_CONTAINER` overrides so the mesh-readiness
   * resolver (`mesh.ts` `meshContainer`), the snapshot-store resolvers, and the
   * preflight owned-container set all target `soa-s<N>-<unit>-1`, and points
   * `SAGA_MESH_SNAPSHOTS_DIR` at the per-slot snapshot root. At slot 0 the profile
   * carries an empty container env and an undefined snapshot dir, so this is a
   * NO-OP and slot 0 stays byte-identical.
   */
  protected applyInstanceEnv(profile: InstanceProfile): void {
    for (const [key, value] of Object.entries(profile.containerEnv)) {
      process.env[key] = value;
    }
    if (profile.snapshotsDir !== undefined) {
      process.env.SAGA_MESH_SNAPSHOTS_DIR = profile.snapshotsDir;
    }
  }

  /**
   * The process seam — production is the only place a real OS child is spawned
   * for a `ScriptInvocation`.
   */
  protected getRunner(): Runner {
    return makeRealRunner();
  }

  /**
   * The HTTP health-probe seam (M2) — production is a real short-timeout `fetch`
   * prober (the only place a real network request is made for `stack status` /
   * `stack verify`).
   */
  protected getProber(): HealthProber {
    return makeRealProber();
  }

  /**
   * The snapshot-IO seam (M3) — production is the only place `docker exec
   * pg_dump/pg_restore/mongodump/mongorestore/psql/redis-cli` is launched (the
   * `stack snapshot store|restore|list|validate` DB work).
   */
  protected getSnapshotIO(): SnapshotIO {
    return makeRealSnapshotIO();
  }

  /**
   * The native-launch seam (M4 — native partial-stack) — production is the ONLY
   * place a real `pnpm dev` child is spawned for `stack up --only` (pid file
   * under `stateDir`, health-polled). `stateDir` comes from the `--state-dir`
   * flag so pid/log files land where the rest of the stack expects.
   */
  protected getLauncher(stateDir?: string): ServiceLauncher {
    return makeRealLauncher({ stateDir });
  }

  /**
   * The slot-safe service-stopper seam (M7 Phase 3) — production is real
   * `stopServices` (fs enumeration of `<stateDir>/<id>.pid` + `process.kill`). It
   * reaches ONLY the pids recorded under the state dir it is given (never a
   * host-global `pkill`), so `down --slot N` can't touch a peer slot's processes.
   */
  protected getServiceStopper(): ServiceStopper {
    return (stateDir: string) => stopServices(stateDir);
  }

  /**
   * The post-down orphan-audit seam (saga-ed/soa#249) — production is the ONLY
   * place `ss -lptnH` / `lsof` run to find sockets still LISTENing on the slot's
   * resolved service-port band after a teardown. `down` uses it to turn a
   * silently-surviving watch child (a stale-build server) into a loud warning.
   */
  protected getOrphanScanner(): OrphanScanner {
    return makeRealOrphanScanner();
  }

  /**
   * The mesh-readiness seam (M4) — production is the only place `docker exec
   * <container> …` runs for mesh readiness gating (pg_isready / redis-cli ping /
   * rabbitmq-diagnostics / mongosh).
   */
  protected getMeshExec(): MeshExec {
    return makeRealMeshExec();
  }

  /**
   * The host-port-probe seam (M4) — production is the only place `docker ps` /
   * `ss` / `lsof` run for the mesh `check_ports` preflight.
   */
  protected getPortProbe(): PortProbe {
    return makeRealPortProbe();
  }

  /**
   * The foreign-process seam (saga-ed/soa#foreign-guardrail) — production is the
   * only place `lsof`/`ss`/`ps` run to answer "is this stack port held by a
   * process ss did NOT launch?" (ownership by pgid vs the slot's pidfiles), plus
   * the group-SIGKILL to reap one. `stack verify` uses `find` (warn-only); `stack
   * cold-start` uses `find` + `reap`. See `runtime/foreign-procs`.
   */
  protected getForeignProcs(): ForeignProcs {
    return makeRealForeignProcs();
  }

  /**
   * The native-prep postgres-probe seam (M8 — R2 provision + R3 migrate) —
   * production is the only place the read-only `docker exec … psql -tAc` probes
   * run (pg_database existence / `_prisma_migrations` presence / public-table
   * count) for the native prep pass.
   */
  protected getPgProbe(): PgProbe {
    return makeRealPgProbe();
  }

  /**
   * The R1 fresh-repo predicate (M8 — native build/prep). A repo is "fresh"
   * (prep skipped) only when it is BOTH installed AND built — MAJOR-D: a
   * `node_modules`-only check treated an installed-but-unbuilt (or stale-`dist`-
   * after-`git pull`) repo as fresh, skipped its build, and launched a service
   * from a missing/stale `dist/` (the exact crash R1 exists to prevent). So it
   * also requires built output (at least one `packages/node/*` or `apps/node/*`
   * package has a `dist/`); a repo with no node workspaces (saga-dash, a pure
   * frontend that is install-only anyway) is fresh on `node_modules` alone.
   */
  protected getPrepFreshCheck(): (repoRoot: string) => boolean {
    return (repoRoot: string) => isRepoBuilt(repoRoot);
  }

  /**
   * soa#256: the R1 stamp writer — after prep builds+installs a repo to completion,
   * record its current `{ headSha, lockHash }` at `node_modules/.saga-stack-prep-stamp`
   * so the next run's fresh-check can tell a pulled-but-unbuilt tree from a current
   * one. Injected (like `getPrepFreshCheck`) so the prep pass stays testable.
   */
  protected getPrepStampWriter(): (repoRoot: string) => void {
    return (repoRoot: string) => writeStamp(repoRoot);
  }

  /**
   * soa#260: the R1 prep repair seam — on a build failure, if the repo carries the
   * stale-`.bin`-shim corruption a plain reprep can't fix (program-hub#335), wipe its
   * `node_modules` and return true so prep reinstalls + rebuilds once. Injected (like
   * `getPrepStampWriter`) so the escalation stays unit-testable with a fake.
   */
  protected getPrepDepRepairer(): (repoRoot: string) => boolean {
    return (repoRoot: string) => repairStaleDeps(repoRoot);
  }

  /**
   * The R1 `db:generate` scan seam (M8 — BLOCKER-B). Given a repo root, returns
   * the repo-relative dirs of every `packages/node/*` package that DECLARES a
   * `db:generate` script (a faithful port of up.sh's `packages/node/*` scan). R1
   * generates ALL of these before the whole-workspace `pnpm build`, so an
   * ungenerated sibling `*-db` package (chat/insights/transcripts/ledger-db)
   * can't fail the turbo build.
   */
  protected getDbGenerateScan(): (repoRoot: string) => string[] {
    return (repoRoot: string) => scanDbGenerateDirs(repoRoot);
  }

  /**
   * The dash-config fs seam (M4 — the `sync-dash-local-defaults` prelaunch hook)
   * — production is the only place the dash `config.local.json` is
   * written/removed for the hook.
   */
  protected getDashFs(): DashFs {
    return makeRealDashFs();
  }

  /**
   * The repo-dir existence check (M4 native partial-stack) — production is a real
   * `fs.existsSync` predicate. The native `stack up` path calls it per service to
   * SKIP (warn, not fail) any service whose sibling-repo checkout is absent (e.g.
   * coach not cloned). NOTE: the real default skips every service under a fake
   * `--dev` path, so seam-mocking tests MUST stub it.
   */
  protected getRepoDirCheck(): (dir: string) => boolean {
    return (dir: string) => existsSync(dir);
  }

  /**
   * The `--record` bring-up seam (Phase 2) — production is the only place the
   * fleek recording docker-compose stack + CodeArtifact token fetch is shelled.
   */
  protected getRecordUp(): RecordUp {
    return makeRealRecordUp();
  }

  /**
   * The `--tunnel` moniker resolver (Phase 2) — production runs the VENDORED
   * `tunnel.sh moniker` (stdin/stderr on the TTY for the first-run prompt) and
   * returns the captured moniker; the command composes `<moniker>.<VMS_BASE>` into
   * the tunnel domain BEFORE building the launch env.
   */
  protected getTunnelMoniker(): (vendorTunnelSh: string) => Promise<string> {
    return resolveTunnelMoniker;
  }

  /**
   * Read the OpenFGA store id the `fga-bootstrap` seed step (rostering's
   * `scripts/fga/bootstrap.mjs --out-file`) wrote on a PRIOR `stack up --with authz`
   * run. `SAGA_STACK_OPENFGA_STORE_ID` takes precedence (manual escape hatch for a
   * live first-run experience without waiting for run 2). Swallows a missing file /
   * unparsable JSON / missing `storeId` field — a cold-start machine has no file
   * yet, and that is the EXPECTED first-run state, not an error (see
   * `LaunchTokens.OPENFGA_STORE_ID`'s fail-closed contract), so this returns
   * `undefined` rather than throwing.
   */
  protected readOpenfgaStoreId(rosteringRoot: string): string | undefined {
    const envOverride = process.env.SAGA_STACK_OPENFGA_STORE_ID;
    if (envOverride) return envOverride;
    const path = join(rosteringRoot, '.saga-mesh/openfga-store.json');
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { storeId?: unknown };
      return typeof raw.storeId === 'string' && raw.storeId ? raw.storeId : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The `--tunnel` rtsm fleet-config generator (Phase 2) — production renders
   * `<stateDir>/rtsm-fleet-tunnel.json` from the base `rtsm-fleet-local.json` with
   * the node endpoint swapped to `rtsm.<domain>`, so rtsm-api's `tunnel_env`
   * FLEET_CONFIG_PATH advertises a browser-reachable node. Best-effort: returns
   * `null` when the base file can't be read/written.
   */
  protected getTunnelFleetGen(): typeof generateTunnelFleetConfig {
    return generateTunnelFleetConfig;
  }

  /**
   * The `--tunnel` fleek-cluster LiveKit creds seam (real A/V). Production
   * best-effort-fetches `qboard/fleek/livekit-creds` from Secrets Manager (up.sh's
   * AV block); the resolved key/secret become connect-api's `LIVEKIT_API_KEY/SECRET`
   * so it signs tokens the fleek cluster accepts. Returns `null` when unavailable
   * (no dev creds / secret) ⇒ connect-api signs with the dev key and cluster A/V
   * fails, but CRDT/chat and the rest of tunnel mode are unaffected.
   */
  protected getFleekCreds(): typeof resolveFleekLivekitCreds {
    return resolveFleekLivekitCreds;
  }

  /** The per-slot rtsm-fleet generator seam (soa#271 — endpoint swapped to the slot's
   *  rtsm host). Production shells the real writer; tests inject a fake. */
  protected getSlotFleetGen(): typeof generateSlotFleetConfig {
    return generateSlotFleetConfig;
  }

  /**
   * The ff-only git seam (M9 — auto-pull) — production is the only place the
   * read-only git probes + the single `merge --ff-only` run for the native
   * sibling sync.
   */
  protected getGitRunner(): GitRunner {
    return makeRealGitRunner();
  }

  /**
   * The `gh` seam (M10 — overlay engine) — production is the only place `gh pr
   * view` is spawned (per-repo cwd, to resolve a numeric PR token to its head
   * branch).
   */
  protected getGhRunner(): GhRunner {
    return makeRealGhRunner();
  }

  /**
   * The overlay-file fs seam (M10) — production is the only place
   * `integration-suite.local.tsv` is read (the file-driven `stack overlay
   * list`/`apply`).
   */
  protected getOverlayFs(): OverlayFs {
    return makeRealOverlayFs();
  }

  /**
   * The confirm seam (M11 — bootstrap ensure-repos) — production is the only
   * place the provisioning prompt reads `process.stdin`.
   */
  protected getConfirm(): ConfirmSeam {
    return makeRealConfirm();
  }

  /**
   * Decide whether to reclaim a prep lock whose holder is STOPPED/abandoned (soa#266
   * follow-up). `--yes` ⇒ auto-kill the stopped holder and reclaim (CI / agents);
   * otherwise prompt on a TTY; with neither, refuse (fail fast — the lock then surfaces
   * a STOPPED-tagged message telling the user how to reclaim). Only ever called for a
   * genuinely stopped holder — a running holder is never offered here.
   */
  protected async reclaimStoppedPrepLock(flags: NativeRuntimeFlags, holder: LockHolder): Promise<boolean> {
    const who = `pid ${holder.pid} (slot ${holder.slot}) building ${holder.root} since ${holder.at}`;
    if (flags.yes) {
      this.log(`⚠ prep lock held by a STOPPED/abandoned ${who} — killing it and reclaiming (--yes).`);
      return true;
    }
    const confirm = this.getConfirm();
    if (!confirm.isTTY()) return false;
    return confirm.prompt(
      `\n  The prep lock for ${holder.root} is held by a STOPPED pid ${holder.pid} (since ${holder.at}) — ` +
        `it is suspended and can never finish.\n  Kill it and reclaim the lock? [y/N] `,
    );
  }

  /**
   * The cookie-capturing POST seam (M11 — native login) — production is the only
   * place the devLogin POST is made.
   */
  protected getCookiePoster(): CookiePoster {
    return makeRealCookiePoster();
  }

  /**
   * The cookie-jar fs seam (M11 — native login) — production is the only place
   * `<stateDir>/cookies.txt` is written.
   */
  protected getJarWriter(): JarWriter {
    return makeRealJarWriter();
  }

  /** Injectable frontends.json IO (the `ss frontend` registry). Real fs in prod. */
  protected getFrontendRegistryIo(): FrontendRegistryIo {
    return makeRealFrontendRegistryIo();
  }

  /**
   * The vite-cache-clear fs seam (M9 — native `restart`) — production is the only
   * place the `nuke_vite` `rm -rf` runs.
   */
  protected getViteClear(): ViteClear {
    return makeRealViteClear();
  }

  /**
   * The docker-wipe seam (cold-start) — production is the only place a destructive `docker
   * compose … down -v` (mesh containers + volumes) or `docker system prune` (`--all-docker`)
   * runs. Injected so the wipe argv + ordering are asserted with no real docker.
   */
  protected getDockerWipe(): DockerWipe {
    return makeRealDockerWipe();
  }

  /**
   * The build-clean seam (cold-start) — production is the only place a real `rm -rf` of a repo's
   * `dist/` (and, under `--reinstall`, `node_modules`) runs to force a clean rebuild.
   */
  protected getBuildCleaner(): BuildCleaner {
    return makeRealBuildCleaner();
  }

  /**
   * The env-fs seam (cold-start) — production is the only place the `.env.example` discovery walk
   * + the `.env.example` → `.env` copy touch the disk.
   */
  protected getEnvFs(): EnvFs {
    return makeRealEnvFs();
  }

  /**
   * Resolve the M9 auto-pull mode from the native flags + env: `--pull` ⇒ `'all'`;
   * `--no-auto-pull` OR `NO_AUTO_PULL=1` ⇒ `false` (opt out); otherwise `'auto'` (the
   * default pre-build sync). Mirrors up.sh's precedence (`DO_PULL` wins; `NO_AUTO_PULL`
   * checked as exactly `1`). Commands without the flags (e.g. `reset`) default to
   * `'auto'`, which is harmless — only `up` runs the pass.
   */
  protected resolveAutoPull(flags: NativeRuntimeFlags): PullMode | false {
    if (flags.pull) return 'all';
    if (flags['no-auto-pull'] || process.env.NO_AUTO_PULL === '1') return false;
    return 'auto';
  }

  /**
   * Assemble the in-process native `Runtime` (M4 + M8) from the shared BaseCommand
   * seams + a resolved slot `InstanceProfile`. Shared by every native command that
   * drives `makeStackApi` (`stack up`, `stack reset`, …) so the slot threading
   * (ports/project/container-env), repo-root resolution, and the M8 prep seams are
   * wired in ONE place. The seams (`getLauncher`/`getMeshExec`/`getPgProbe`/…) are
   * injectable, so a test spies them on the prototype to drive the whole native path
   * with fakes. At slot 0 the profile is the byte-identical no-offset default.
   */
  /**
   * Build the `ScriptContext` (workspace `--dev` + the per-repo `--<repo>` path pins)
   * from a command's parsed workspace flags — the one place the kebab-flag → manifest
   * env-var-key mapping lives. Shared by `buildNativeRuntime` and any command that
   * needs to resolve a repo/script path off the same flags (e.g. `up`'s `--tunnel`
   * fleet-config generation).
   */
  protected scriptContextFromFlags(flags: WorkspaceFlags): ScriptContext {
    return repoContextFromFlags(flags as Record<string, unknown>);
  }

  protected buildNativeRuntime(
    flags: NativeRuntimeFlags,
    profile: InstanceProfile,
    overlays: NativeOverlays = {},
  ): Runtime {
    // Pinned repo roots from the per-repo flags (kebab key → manifest env-var key).
    const ctx: ScriptContext = this.scriptContextFromFlags(flags);

    // Resolve the FULL repo-root map (every manifest repo, defaulted via up.sh's
    // precedence) so the launch planner can place any closure service's cwd.
    const repoRoots = {} as Record<ManifestRepoKey, string>;
    for (const repo of Object.keys(REPO_DEFAULT_DIR) as ManifestRepoKey[]) {
      repoRoots[repo] = resolveRepoRoot(repo, ctx);
    }

    // rtsm-api's non-tunnel FLEET_CONFIG_PATH reads `${VENDOR_DIR}/rtsm-fleet-local.json`;
    // point VENDOR_DIR at the CLI's VENDORED copy (Phase-2 DECOUPLING) — NOT a soa
    // checkout's `tools/synthetic-dev`. (The `--tunnel` case overrides it in `up.ts`.)
    const vendorDir = dirname(resolveVendorScript('rtsm-fleet-local.json'));

    // `--with authz`: read the OpenFGA store id the `fga-bootstrap` seed step wrote on
    // a PRIOR run (same seam as --tunnel's resolveOverlays() — synchronous IO BEFORE
    // building the launch env, since resolveLaunchEnv/defaultLaunchContext are pure).
    // Absent on a cold-start first run (no file yet) ⇒ '' downstream (fail closed,
    // not a crash — see LaunchTokens.OPENFGA_STORE_ID). Only bother reading when the
    // authz bundle is actually selected.
    const authzOverlay = overlays.authz?.withAuthz
      ? { withAuthz: true, storeId: overlays.authz.storeId ?? this.readOpenfgaStoreId(repoRoots.ROSTERING) }
      : undefined;

    // M7: the ONE slot-injection site — apply the slot's env seam so the mesh
    // resolver, preflight owned-container set, and snapshot store target
    // `soa-s<N>-<unit>-1`. No-op at slot 0.
    this.applyInstanceEnv(profile);

    const stateDir = flags['state-dir'] ?? profile.stateDir;

    // soa#271: at slot > 0 (non-tunnel), generate a per-slot rtsm fleet whose
    // browser-visible node endpoint is the SLOT's rtsm host (`localhost:<6110+offset>`),
    // and route it via RTSM_FLEET_PATH. Without it a slot's Connect browser discovers the
    // vendored :6110 endpoint and its CRDT/realtime socket split-brains onto slot 0's
    // rtsm. This is the ONE seam every bring-up path shares (`stack up` AND `e2e run`
    // build the runtime here). Best-effort: a null (unreadable base) keeps the vendored
    // fleet. `--tunnel` (slot-0-only) has its own fleet override via the tunnel overlay.
    let rtsmFleetPath: string | undefined;
    if (profile.slot > 0 && !overlays.tunnel) {
      const rtsmPort = profile.portOverrides['rtsm-api'];
      if (rtsmPort !== undefined) {
        rtsmFleetPath =
          this.getSlotFleetGen()({
            localFleetPath: resolveVendorScript('rtsm-fleet-local.json'),
            outPath: `${stateDir}/rtsm-fleet-s${profile.slot}.json`,
            endpoint: `localhost:${rtsmPort}`,
          }) ?? undefined;
      }
    }

    const launchContext = defaultLaunchContext({
      repoRoots,
      vendorDir,
      portOverrides: profile.portOverrides,
      meshOffset: profile.meshOffset,
      pinoLevel: process.env.PINO_LOGGER_LEVEL,
      pinoIsExpressContext: process.env.PINO_LOGGER_ISEXPRESSCONTEXT,
      // Phase 2: the sandbox / tunnel lane overlays (sandbox_env / tunnel_env). Absent
      // for a plain `up` (and for `reset`, which never passes overlays) ⇒ base env only.
      sandbox: overlays.sandbox,
      tunnel: overlays.tunnel,
      rtsmFleetPath,
      withAuthz: authzOverlay?.withAuthz,
      openfgaStoreId: authzOverlay?.storeId,
    });

    return {
      lane: 'stack',
      launchContext,
      soaRoot: repoRoots.SOA,
      sagaDashRoot: repoRoots.SAGA_DASH,
      slot: profile.slot,
      meshProject: profile.slot === 0 ? undefined : profile.project,
      meshOffset: profile.meshOffset,
      launcher: this.getLauncher(stateDir),
      meshExec: this.getMeshExec(),
      portProbe: this.getPortProbe(),
      dashFs: this.getDashFs(),
      prober: this.getProber(),
      runner: this.getRunner(),
      // M8 native prep pass (R1 build → R2 provision → R3 migrate on `up`; harmless
      // on the other native commands, which never invoke the prep pass).
      pgProbe: this.getPgProbe(),
      skipPrep: flags['skip-prep'],
      prepIsFresh: this.getPrepFreshCheck(),
      prepWriteStamp: this.getPrepStampWriter(),
      prepRepairDeps: this.getPrepDepRepairer(),
      prepDbGenerateScan: this.getDbGenerateScan(),
      // M13-B: realpath-keyed build lock — two `ss` invocations can never
      // prep-BUILD one checkout concurrently (fresh-skipped repos never lock).
      // soa#266 follow-up: an abandoned (STOPPED) holder is reclaimed per the
      // command's --yes/TTY policy instead of wedging every future bring-up.
      prepLock: makeRealPrepLock(profile.slot, {
        reclaimStopped: (holder) => this.reclaimStoppedPrepLock(flags, holder),
      }),
      repoDirExists: this.getRepoDirCheck(),
      // M9: the ff-only sibling sync (up.sh `pull_repos`) + its mode, the vite-cache
      // clear (native `restart`), and best-effort Connect AV (slot-0 + connect-in-closure,
      // gated in the facade). All three no-op unless the relevant native path invokes them.
      gitRunner: this.getGitRunner(),
      autoPull: this.resolveAutoPull(flags),
      viteClear: this.getViteClear(),
      // Native `restart` routes its stop through the dir-scoped GROUP killer (kill(-pid))
      // over THIS state dir's pidfiles, so a `tsup --watch` / port-holding grandchild is
      // reaped and the follow-up `up()` boots fresh code instead of finding the stale
      // server still alive. Slot-safe (no host-global pkill). Same dir the launcher wrote.
      serviceStopper: this.getServiceStopper(),
      stateDir,
      connectAv: true,
      // Phase 2: `--tunnel` flips the dash prelaunch hook to tunnel routing + drives the
      // per-service tunnel_env overlay above. `--record` starts the fleek recording stack
      // after launch (fleek-gated). Both absent on a plain `up`/`reset` ⇒ byte-identical.
      tunnel: overlays.tunnel !== undefined,
      tunnelDomain: overlays.tunnel?.domain,
      record: overlays.record,
      recordUp: overlays.recordUp,
      recordingsDir: overlays.recordingsDir,
      // `delegate` runs a resolved `ScriptPlan` (today only the SAGA_DASH e2e wrapper);
      // the `stack` lifecycle is fully native and never delegates. Kept for the e2e lane.
      delegate: (plan) => this.runScript(plan, flags, { propagateExit: false }),
    };
  }

  /**
   * Resolve a pure `ScriptPlan` to a real script invocation and run it through
   * the injectable Runner.
   *
   * - Locates the absolute script path + cwd from the workspace flags
   *   (`--dev` + the per-repo `--<repo>` pins) via `runtime/scripts`. The script
   *   lives in the repo named by `plan.script.repo` (SOA, SAGA_DASH, …), so the
   *   cwd is that script's own directory — not a hardcoded synthetic-dev dir.
   * - Layers the per-repo path overrides (`--<repo>`/`--dev`) UNDER the plan's
   *   own env (NO_AUTO_PULL / SKIP_PREP / VERIFY_HEALTH_ONLY) — they never
   *   collide, but the subcommand env wins by construction.
   * - stdio is inherited so the bash script owns the user's TTY.
   * - On a non-zero exit the command exits with the SAME code, so the wrapper is
   *   transparent to scripts/CI — unless `propagateExit:false` (status, which is
   *   read-only and must never fail on its own).
   *
   * Returns the child exit code for callers that want it.
   */
  protected async runScript(
    plan: ScriptPlan,
    flags: WorkspaceFlags,
    opts: { propagateExit?: boolean } = {},
  ): Promise<number> {
    // Build BOTH the per-repo override env (for the child process) and the
    // per-repo path-pin map (for locating the script), keyed by the manifest
    // env-var name. `--soa` lands in both because `REPO_ENV_VAR.soa === 'SOA'`.
    const overrides = repoOverridesFromFlags(flags as Record<string, unknown>);
    const ctx = repoContextFromFlags(flags as Record<string, unknown>);
    const command = resolveScript(plan.script, ctx);
    const cwd = scriptCwd(plan.script, ctx);

    const env = { ...buildRepoEnv(overrides), ...plan.env };

    const runner = this.getRunner();
    const { code } = await runner.run({ cwd, command, args: plan.args, env, stdio: 'inherit' });

    if (opts.propagateExit !== false && code !== 0) {
      this.exit(code);
    }
    return code;
  }

  /**
   * Build the per-repo override env (`DEV` + the `--<repo>` path pins) a child
   * process inherits — the same map `runScript` layers under a plan's own env,
   * factored out so `runVendor` can reuse it. Keyed by the manifest env-var name
   * up.sh/tunnel.sh/refresh-suite.sh read (`SOA`, `SAGA_DASH`, …).
   */
  protected buildRepoOverrideEnv(flags: WorkspaceFlags): Record<string, string> {
    return buildRepoEnv(repoOverridesFromFlags(flags as Record<string, unknown>));
  }

  /**
   * Run a VENDORED script (Phase 1 decoupling) through the injectable Runner.
   *
   * Parallel to `runScript`, but for the scripts the CLI now SHIPS under its own
   * `vendor/` dir (`tunnel.sh` / `browser-login.mjs` / `refresh-suite.sh`) instead
   * of resolving from a `soa` checkout's `tools/synthetic-dev`. The caller resolves
   * the absolute path via `resolveVendorScript(name)` and passes the fully-formed
   * invocation (`command` = the vendored script's path, or `node` with the script as
   * `args[0]`; `cwd` = the script's own dir, or the saga-dash dash app dir for
   * playwright resolution). The per-repo path overrides (`--dev`/`--<repo>`) are
   * layered UNDER the caller's `env`, stdio is inherited, and the child exit code is
   * propagated (unless `propagateExit:false`, e.g. the best-effort browser step).
   */
  protected async runVendor(
    spec: { cwd: string; command: string; args: string[]; env: Record<string, string> },
    flags: WorkspaceFlags,
    opts: { propagateExit?: boolean } = {},
  ): Promise<number> {
    const env = { ...this.buildRepoOverrideEnv(flags), ...spec.env };
    const runner = this.getRunner();
    const { code } = await runner.run({
      cwd: spec.cwd,
      command: spec.command,
      args: spec.args,
      env,
      stdio: 'inherit',
    });
    if (opts.propagateExit !== false && code !== 0) {
      this.exit(code);
    }
    return code;
  }

  /**
   * SHARED native headless-login: mint the cookie jar (the curl half of up.sh's
   * `login_user`, ~1935-1960) — POST iam's dev-only, origin-checked devLogin and write
   * the captured cookies to a Netscape jar at `<stateDir>/cookies.txt`. Both `stack
   * login` and `up --login` call this, so the login logic lives in ONE place and NEITHER
   * touches `up.sh`. The iam URL is slot-aware (`LOGIN_IAM_URL` overrides for the tunnel).
   * Returns the `NativeLoginResult` (ok / status / captured / resolved iamUrl+jarPath) —
   * the caller owns the messaging + exit policy (hard-fail for `stack login`, best-effort
   * for `up --login`). Never throws (a non-200 truncates the jar and returns `ok:false`).
   */
  protected async mintNativeLoginJar(opts: {
    email: string;
    slot: number;
    stateDir: string;
  }): Promise<NativeLoginResult> {
    // LOGIN_IAM_URL wins (tunnel: login goes through the PUBLIC iam host); else slot-offset localhost.
    const iamUrl = resolveIamUrl({ slot: opts.slot, loginIamUrl: process.env.LOGIN_IAM_URL });
    const jarPath = join(opts.stateDir, COOKIE_JAR_FILE);
    return nativeLogin(
      { email: opts.email, iamUrl, jarPath },
      { poster: this.getCookiePoster(), jar: this.getJarWriter() },
    );
  }

  /**
   * SHARED best-effort headful auto-login: open an auto-logged-in Chromium via the CLI's
   * VENDORED `browser-login.mjs` (Phase-1 DECOUPLING) — the native replacement for up.sh's
   * `open_login_browser`. Both `stack login --browser` and `up --login` call this.
   *
   * Passes the exact env browser-login.mjs reads: `IAM_URL` (the resolved iam host),
   * `DASH_URL` (`LOGIN_DASH_URL` override else localhost:8900), `LOGIN_EMAIL` (the persona),
   * `PROFILE_DIR` (`<stateDir>/browser-profile`, up.sh's BROWSER_PROFILE), and
   * `SAGA_DASH_DASH` (the resolved saga-dash dash app dir). node runs with `cwd` = that
   * dash dir so `createRequire`'d playwright + its browsers resolve there.
   *
   * BEST-EFFORT (`propagateExit:false`): the headless jar is already minted, so a browser
   * failure (playwright absent, no DISPLAY, …) — which browser-login.mjs reports as an
   * `AUTOLOGIN_FAIL` line on the inherited stdio — must NOT flip the caller's exit code,
   * mirroring up.sh's best-effort browser step.
   */
  protected async openVendoredBrowser(
    flags: WorkspaceFlags,
    ctx: { email: string; iamUrl: string; stateDir: string; dashUrl?: string },
  ): Promise<void> {
    const script = resolveVendorScript('browser-login.mjs');
    const sagaDashDash = join(
      resolveRepoRoot('SAGA_DASH', this.scriptContextFromFlags(flags)),
      'apps',
      'web',
      'dash',
    );
    // TRULY best-effort — guard SPAWN-level failures too, mirroring up.sh's
    // open_login_browser preflight ([[ -f BROWSER_LOGIN ]] / command -v node /
    // [[ -d …/dash ]] each warn-and-return). `propagateExit:false` only tolerates a
    // NON-ZERO child exit; a missing cwd rejects with ENOENT from the spawn 'error'
    // event and would otherwise redden `up`/`login` even though the headless jar is
    // already minted. saga-dash-absent is a supported state (`up` skips it with a
    // warning), so the browser step must degrade the same way.
    if (!this.getRepoDirCheck()(sagaDashDash)) {
      this.warn(
        `headful browser skipped — saga-dash dash app not found at ${sagaDashDash} ` +
          '(the headless cookie jar is minted; clone saga-dash for the browser step)',
      );
      return;
    }
    const env: Record<string, string> = {
      IAM_URL: ctx.iamUrl,
      // Plan 13 --hold passes the run's RESOLVED (slot-offset) SPA URL so the held
      // browser opens the slot's own dash; login's default keeps LOGIN_DASH_URL / :8900.
      DASH_URL: ctx.dashUrl ?? (process.env.LOGIN_DASH_URL || 'http://localhost:8900'),
      LOGIN_EMAIL: ctx.email,
      PROFILE_DIR: join(ctx.stateDir, 'browser-profile'),
      SAGA_DASH_DASH: sagaDashDash,
    };
    try {
      await this.runVendor({ cwd: sagaDashDash, command: 'node', args: [script], env }, flags, {
        propagateExit: false,
      });
    } catch (err) {
      // spawn-level failure (node missing, ENOENT race, …) — warn, never redden.
      this.warn(`headful browser skipped — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Emit a result in one of three shapes, picked by flags:
   *   --output-json → JSON.stringify(json, null, 2)
   *   --porcelain   → one key=value line per entry (primitives only)
   *   default       → one or more human-readable text lines
   *
   * `textLines` may be a single string or an array; either is supported so
   * callers can drop in a single line without array-wrapping.
   */
  protected emit(
    flags: { porcelain: boolean; 'output-json': boolean },
    json: Record<string, unknown>,
    textLines: string | string[],
  ): void {
    if (flags['output-json']) {
      this.log(JSON.stringify(json, null, 2));
      return;
    }
    if (flags.porcelain) {
      for (const [k, v] of Object.entries(json)) {
        this.log(`${k}=${String(v)}`);
      }
      return;
    }
    const lines = Array.isArray(textLines) ? textLines : [textLines];
    for (const line of lines) this.log(line);
  }
}

/** The node-workspace roots up.sh builds under (`packages/node/*`, `apps/node/*`). */
const NODE_WORKSPACE_DIRS = ['packages/node', 'apps/node'] as const;

/**
 * MAJOR-D: a repo has its build ARTIFACTS present iff `node_modules` is present AND
 * at least one `packages/node/*` / `apps/node/*` package has a `dist/`. A repo with
 * NO node workspaces (a pure frontend like saga-dash, install-only, no `dist/`)
 * counts once installed. Every `fs` error folds to "not present" (the safe default).
 */
function hasBuildArtifacts(root: string): boolean {
  if (!existsSync(`${root}/node_modules`)) return false;
  let sawWorkspace = false;
  for (const ws of NODE_WORKSPACE_DIRS) {
    const wsRoot = `${root}/${ws}`;
    let entries: string[];
    try {
      entries = readdirSync(wsRoot);
    } catch {
      continue; // this workspace dir doesn't exist here
    }
    sawWorkspace = true;
    for (const pkg of entries) {
      if (existsSync(`${wsRoot}/${pkg}/dist`)) return true; // at least one built package
    }
  }
  // No node workspaces at all ⇒ nothing to build; installed is enough (saga-dash).
  return !sawWorkspace;
}

/**
 * The R1 fresh-skip predicate. A repo is "built" iff its artifacts are present
 * (`hasBuildArtifacts`) AND — soa#256 — it is CURRENT: presence alone is
 * stale-blind, so after `git pull` without a reinstall/rebuild the old check skipped
 * prep and the stack served stale code. A git checkout is fresh only when its
 * `node_modules/.saga-stack-prep-stamp` matches the repo's current HEAD + lockfile;
 * a missing/mismatched/unreadable stamp ⇒ not fresh ⇒ prep re-runs (the same safe
 * default the presence check already used). A NON-checkout (no `.git`) has no HEAD
 * to drift against, so it falls back to presence-only — the pre-#256 behaviour,
 * preserved for deployed/tarball trees that are never stamped.
 */
function isRepoBuilt(repoRoot: string): boolean {
  const root = repoRoot.replace(/\/+$/, '');
  if (!hasBuildArtifacts(root)) return false;
  if (!existsSync(`${root}/.git`)) return true; // not a checkout ⇒ presence-only fallback
  return stampMatches(root);
}

/**
 * BLOCKER-B: scan a repo's `packages/node/*` for every package DECLARING a
 * `db:generate` script, returning their repo-relative dirs (mirrors up.sh's scan loop). A
 * malformed/absent `package.json` is skipped; a missing workspace dir yields `[]`.
 */
function scanDbGenerateDirs(repoRoot: string): string[] {
  const root = repoRoot.replace(/\/+$/, '');
  const base = `${root}/packages/node`;
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const name of entries) {
    const pkgJson = `${base}/${name}/package.json`;
    if (!existsSync(pkgJson)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as { scripts?: Record<string, string> };
      if (pkg.scripts?.['db:generate']) dirs.push(`packages/node/${name}`);
    } catch {
      // malformed package.json — skip (never throw out of the scan).
    }
  }
  return dirs;
}

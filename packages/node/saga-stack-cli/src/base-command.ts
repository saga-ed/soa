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
import { checkWorktreeSet, makeSlotActiveProbe } from './runtime/index.js';
import type { SlotActiveProbe } from './runtime/index.js';
import type { PullMode } from './core/auto-pull.js';
import type { InstanceProfile } from './core/derive-instance.js';
import type { RecordMode, ScriptPlan } from './core/flag-map.js';
import { defaultLaunchContext } from './core/launch-plan.js';
import { resolveIamUrl } from './core/login.js';
import type { RepoKey as ManifestRepoKey } from './core/manifest/index.js';
import type { RecordUp, Runtime } from './stack-api.js';
import { COOKIE_JAR_FILE, nativeLogin } from './runtime/login.js';
import type { NativeLoginResult } from './runtime/login.js';
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
  makeRealPgProbe,
  makeRealOverlayFs,
  makeRealPortProbe,
  makeRealProber,
  makeRealRecordUp,
  makeRealRunner,
  makeRealPrepLock,
  makeRealSetStore,
  makeRealSnapshotIO,
  makeRealViteClear,
  generateTunnelFleetConfig,
  resolveRepoRoot,
  resolveTunnelMoniker,
  resolveScript,
  resolveVendorScript,
  scriptCwd,
  stopServices,
  REPO_DEFAULT_DIR,
  REPO_ENV_VAR,
} from './runtime/index.js';
import type {
  ConfirmSeam,
  CookiePoster,
  DashFs,
  GhRunner,
  GitRunner,
  HealthProber,
  JarWriter,
  MeshExec,
  OverlayFs,
  PgProbe,
  PortProbe,
  RepoKey,
  RepoOverrides,
  Runner,
  ScriptContext,
  SetStore,
  ServiceLauncher,
  ServiceStopper,
  SnapshotIO,
  ViteClear,
} from './runtime/index.js';

/**
 * The subset of the parsed global flags `runScript` reads to locate the script
 * and build the per-repo path env. Every wrapper command's `flags` satisfies
 * this because they all spread `BaseCommand.baseFlags`.
 */
export type WorkspaceFlags = {
  dev?: string;
  soa?: string;
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
   * The injectable worktree-set store seam (M13-A). Production reads
   * `$SAGA_STACK_SETS ?? ~/.saga-stack/worktree-sets.json`; tests spy this on
   * the prototype to feed a canned store without fs — mirroring
   * `getRunner`/`getGitRunner`/`getSnapshotIO`.
   */
  protected getSetStore(): SetStore {
    return makeRealSetStore();
  }

  /**
   * The injectable slot-activity probe (M13-A `set list` ACTIVE column,
   * M13-B up-time collision check). Derived LIVE from state-dir pid liveness +
   * compose containers — no recorded active state. Tests spy this on the
   * prototype to pin activity without fs/docker.
   */
  protected getSlotActiveProbe(): SlotActiveProbe {
    return makeSlotActiveProbe();
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
   * The injectable process seam. Production launches real children; tests spy
   * this on the prototype to record the `ScriptInvocation` without spawning.
   */
  protected getRunner(): Runner {
    return makeRealRunner();
  }

  /**
   * The injectable HTTP health-probe seam (M2). Production returns a real
   * short-timeout `fetch` prober (the only place a real network request is
   * made); the native `stack status` / `stack verify` tests spy this on the
   * prototype to return canned `ProbeResult`s without hitting the network or a
   * running stack — mirroring how `getRunner` is mocked for the process seam.
   * Provided here as a SEAM; the M2 build phase wires it into status/verify.
   */
  protected getProber(): HealthProber {
    return makeRealProber();
  }

  /**
   * The injectable snapshot-IO seam (M3). Production returns
   * `makeRealSnapshotIO()` — the only place `docker exec
   * pg_dump/pg_restore/mongodump/mongorestore/psql/redis-cli` is launched; the
   * `stack snapshot store|restore|list|validate` TESTS spy this on the prototype
   * to return a fake that records the calls and yields canned bytes, so the
   * snapshot logic is asserted WITHOUT a real container, DB, or dump file —
   * mirroring how `getRunner`/`getProber` are mocked for the process/HTTP seams.
   */
  protected getSnapshotIO(): SnapshotIO {
    return makeRealSnapshotIO();
  }

  /**
   * The injectable native-launch seam (M4 — native partial-stack). Production
   * returns `makeRealLauncher()` — the ONLY place a real `pnpm dev` child is
   * spawned for the native `stack up --only` path (pid file written under
   * `stateDir`, health-polled). The native partial-stack TESTS spy this on the
   * prototype to return a fake `ServiceLauncher` that records each `LaunchSpec`
   * and yields a canned result, so the topo-wave launch order + per-service env +
   * health gating are asserted WITHOUT spawning a process — mirroring how
   * `getRunner`/`getProber`/`getSnapshotIO` are mocked. `stateDir` comes from the
   * `--state-dir` flag so pid/log files land where the rest of the stack expects.
   */
  protected getLauncher(stateDir?: string): ServiceLauncher {
    return makeRealLauncher({ stateDir });
  }

  /**
   * The injectable native slot-safe service-stopper seam (M7 Phase 3). Production
   * returns the real `stopServices` (real fs enumeration of `<stateDir>/<id>.pid` +
   * `process.kill`) — the ONLY place `down --slot N` reaches a slot's dev-server
   * processes, and it reaches ONLY the pids recorded under the state dir it is given
   * (never a host-global `pkill`). `stack down` at slot > 0 calls this against the
   * slot's `profile.stateDir`; the TESTS spy it on the prototype (or drive the raw
   * `stopServices` with a fake fs + fake killer) to assert the SIGTERM/SIGKILL
   * targets are EXACTLY that slot's pids WITHOUT touching a real process — mirroring
   * how `getRunner`/`getLauncher`/… are mocked.
   */
  protected getServiceStopper(): ServiceStopper {
    return (stateDir: string) => stopServices(stateDir);
  }

  /**
   * The injectable mesh-readiness seam (M4). Production returns
   * `makeRealMeshExec()` — the only place `docker exec <container> …` runs for
   * mesh readiness gating (pg_isready / redis-cli ping / rabbitmq-diagnostics /
   * mongosh). Tests substitute a fake so the native `meshUp` readiness poll is
   * asserted WITHOUT a real container.
   */
  protected getMeshExec(): MeshExec {
    return makeRealMeshExec();
  }

  /**
   * The injectable host-port-probe seam (M4). Production returns
   * `makeRealPortProbe()` — the only place `docker ps` / `ss` / `lsof` run for the
   * mesh `check_ports` preflight. Tests substitute a fake so the conflict logic is
   * asserted WITHOUT touching docker or the host socket table.
   */
  protected getPortProbe(): PortProbe {
    return makeRealPortProbe();
  }

  /**
   * The injectable native-prep postgres-probe seam (M8 — R2 provision + R3
   * migrate). Production returns `makeRealPgProbe()` — the only place the read-only
   * `docker exec … psql -tAc` probes (pg_database existence / `_prisma_migrations`
   * presence / public-table count) run for the native prep pass. The native `up`
   * TESTS spy this on the prototype to return a fake that answers from a script, so
   * the provision/migrate PLAN is asserted WITHOUT a real container or DB —
   * mirroring how `getRunner`/`getMeshExec`/… are mocked.
   */
  protected getPgProbe(): PgProbe {
    return makeRealPgProbe();
  }

  /**
   * The injectable R1 fresh-repo predicate (M8 — native build/prep). A repo is
   * "fresh" (prep skipped) only when it is BOTH installed AND built — MAJOR-D: a
   * `node_modules`-only check treated an installed-but-unbuilt (or stale-`dist`-
   * after-`git pull`) repo as fresh, skipped its build, and launched a service from
   * a missing/stale `dist/` — the exact crash R1 exists to prevent. So this also
   * requires built output: at least one `packages/node/*` or `apps/node/*` package
   * has a `dist/` (a repo with no such node workspaces — e.g. saga-dash, a pure
   * frontend that is install-only anyway — is fresh on `node_modules` alone).
   * Injected so tests drive R1's fresh-skip WITHOUT touching the filesystem.
   */
  protected getPrepFreshCheck(): (repoRoot: string) => boolean {
    return (repoRoot: string) => isRepoBuilt(repoRoot);
  }

  /**
   * The injectable R1 `db:generate` scan seam (M8 — BLOCKER-B). Given a repo root,
   * returns the repo-relative dirs of every `packages/node/*` package that DECLARES
   * a `db:generate` script — a faithful port of up.sh's
   * `for dbpkg in $SDS/packages/node/*; grep -q '"db:generate"'` loop (up.sh:1010-1013).
   * R1 generates ALL of these before the whole-workspace `pnpm build`, so an
   * ungenerated sibling `*-db` package (chat/insights/transcripts/ledger-db) can't
   * fail the turbo build. Injected so tests drive R1's db:generate plan WITHOUT fs.
   */
  protected getDbGenerateScan(): (repoRoot: string) => string[] {
    return (repoRoot: string) => scanDbGenerateDirs(repoRoot);
  }

  /**
   * The injectable dash-config fs seam (M4 — the `sync-dash-local-defaults`
   * prelaunch hook). Production returns `makeRealDashFs()` (the only place the
   * dash `config.local.json` is written/removed for the hook); tests substitute a
   * fake so the hook's mode-for-mode behaviour is asserted WITHOUT real fs IO.
   */
  protected getDashFs(): DashFs {
    return makeRealDashFs();
  }

  /**
   * The injectable repo-dir existence check (M4 native partial-stack). Production
   * returns a real `fs.existsSync` predicate — the native `stack up` path calls it
   * per service to SKIP (warn, not fail) any service whose sibling-repo checkout is
   * absent (e.g. the coach repo not cloned). Tests spy this on the prototype to
   * drive the skip logic WITHOUT touching the filesystem — mirroring how
   * `getLauncher`/`getMeshExec`/… are mocked. Default (real existsSync) would skip
   * every service under a fake `--dev` path, so seam-mocking tests must stub it.
   */
  protected getRepoDirCheck(): (dir: string) => boolean {
    return (dir: string) => existsSync(dir);
  }

  /**
   * The injectable `--record` bring-up seam (Phase 2). Production returns
   * `makeRealRecordUp()` — the only place the fleek recording docker-compose stack +
   * CodeArtifact token fetch is shelled. The native `stack up --record` TESTS spy this
   * on the prototype to assert the record PLAN (services/env) WITHOUT docker/aws —
   * mirroring how `getLauncher`/`getRunner`/… are mocked.
   */
  protected getRecordUp(): RecordUp {
    return makeRealRecordUp();
  }

  /**
   * The injectable `--tunnel` moniker resolver (Phase 2). Production runs the VENDORED
   * `tunnel.sh moniker` (stdin/stderr on the TTY for the first-run prompt) and returns
   * the captured moniker; the command composes `<moniker>.<VMS_BASE>` into the tunnel
   * domain BEFORE building the launch env. Tests spy this on the prototype to return a
   * fixed moniker WITHOUT spawning tunnel.sh.
   */
  protected getTunnelMoniker(): (vendorTunnelSh: string) => Promise<string> {
    return resolveTunnelMoniker;
  }

  /**
   * The injectable `--tunnel` rtsm fleet-config generator (Phase 2). Production returns
   * `generateTunnelFleetConfig` — renders `<stateDir>/rtsm-fleet-tunnel.json` from the
   * base `rtsm-fleet-local.json` with the node endpoint swapped to `rtsm.<domain>`, so
   * rtsm-api's `tunnel_env` FLEET_CONFIG_PATH advertises a browser-reachable node (up.sh
   * ~2170-2188). Best-effort: returns `null` when the base file can't be read/written.
   * Tests spy this on the prototype to return a fixed path WITHOUT touching the fs.
   */
  protected getTunnelFleetGen(): typeof generateTunnelFleetConfig {
    return generateTunnelFleetConfig;
  }

  /**
   * The injectable ff-only git seam (M9 — auto-pull). Production returns
   * `makeRealGitRunner()` — the only place the read-only git probes + the single
   * `merge --ff-only` run for the native sibling sync. The native `stack up` TESTS spy
   * this on the prototype to drive the skip/ff decision WITHOUT a real repo/network —
   * mirroring how `getRunner`/`getMeshExec`/… are mocked.
   */
  protected getGitRunner(): GitRunner {
    return makeRealGitRunner();
  }

  /**
   * The injectable `gh` seam (M10 — overlay engine). Production returns
   * `makeRealGhRunner()` — the only place `gh pr view` is spawned (per-repo cwd, to
   * resolve a numeric PR token to its head branch). The native `stack overlay` TESTS
   * spy this on the prototype to drive PR resolution WITHOUT a live `gh`/network —
   * mirroring how `getGitRunner`/`getRunner`/… are mocked.
   */
  protected getGhRunner(): GhRunner {
    return makeRealGhRunner();
  }

  /**
   * The injectable overlay-file fs seam (M10). Production returns `makeRealOverlayFs()`
   * — the only place `integration-suite.local.tsv` is read. The native `stack overlay
   * list`/`apply` (file-driven) TESTS spy this on the prototype to feed canned tsv text
   * WITHOUT touching the filesystem.
   */
  protected getOverlayFs(): OverlayFs {
    return makeRealOverlayFs();
  }

  /**
   * The injectable confirm seam (M11 — bootstrap ensure-repos). Production returns
   * `makeRealConfirm()` (the only place the provisioning prompt reads `process.stdin`);
   * the `stack bootstrap` TESTS spy this on the prototype to drive the TTY / y-n / no-tty
   * branches WITHOUT a real terminal — mirroring how `getRunner`/`getGitRunner`/… are mocked.
   */
  protected getConfirm(): ConfirmSeam {
    return makeRealConfirm();
  }

  /**
   * The injectable cookie-capturing POST seam (M11 — native login). Production returns
   * `makeRealCookiePoster()` — the only place the devLogin POST is made; the `stack login`
   * TESTS spy this on the prototype to return canned `Set-Cookie`s WITHOUT a network.
   */
  protected getCookiePoster(): CookiePoster {
    return makeRealCookiePoster();
  }

  /**
   * The injectable cookie-jar fs seam (M11 — native login). Production returns
   * `makeRealJarWriter()` — the only place `<stateDir>/cookies.txt` is written; the
   * `stack login` TESTS spy this on the prototype to capture the jar bytes WITHOUT fs IO.
   */
  protected getJarWriter(): JarWriter {
    return makeRealJarWriter();
  }

  /**
   * The injectable vite-cache-clear fs seam (M9 — native `restart`). Production returns
   * `makeRealViteClear()` — the only place the `nuke_vite` `rm -rf` runs. The `stack
   * restart` TESTS spy this on the prototype to assert the exact cache paths WITHOUT
   * touching the filesystem.
   */
  protected getViteClear(): ViteClear {
    return makeRealViteClear();
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
    const pinned: Partial<Record<ManifestRepoKey, string>> = {};
    for (const kebab of Object.keys(REPO_ENV_VAR) as (keyof typeof REPO_ENV_VAR)[]) {
      const value = (flags as unknown as Record<string, string | undefined>)[kebab];
      if (value) pinned[REPO_ENV_VAR[kebab] as ManifestRepoKey] = value;
    }
    return { dev: flags.dev, repoRoots: pinned };
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

    // M7: the ONE slot-injection site — apply the slot's env seam so the mesh
    // resolver, preflight owned-container set, and snapshot store target
    // `soa-s<N>-<unit>-1`. No-op at slot 0.
    this.applyInstanceEnv(profile);

    const stateDir = flags['state-dir'] ?? profile.stateDir;

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
      prepDbGenerateScan: this.getDbGenerateScan(),
      // M13-B: realpath-keyed build lock — two `ss` invocations can never
      // prep-BUILD one checkout concurrently (fresh-skipped repos never lock).
      prepLock: makeRealPrepLock(profile.slot),
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
    const overrides: RepoOverrides = { dev: flags.dev };
    const repoRoots: Partial<Record<ManifestRepoKey, string>> = {};
    for (const repo of Object.keys(REPO_ENV_VAR) as RepoKey[]) {
      const value = flags[repo];
      if (value) {
        overrides[repo] = value;
        repoRoots[REPO_ENV_VAR[repo] as ManifestRepoKey] = value;
      }
    }

    const ctx: ScriptContext = { dev: flags.dev, repoRoots };
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
    const overrides: RepoOverrides = { dev: flags.dev };
    for (const repo of Object.keys(REPO_ENV_VAR) as RepoKey[]) {
      const value = flags[repo];
      if (value) overrides[repo] = value;
    }
    return buildRepoEnv(overrides);
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
    ctx: { email: string; iamUrl: string; stateDir: string },
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
      DASH_URL: process.env.LOGIN_DASH_URL || 'http://localhost:8900',
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
 * MAJOR-D: a repo is "built" iff `node_modules` is present AND at least one
 * `packages/node/*` / `apps/node/*` package has a `dist/`. A repo with NO node
 * workspaces (a pure frontend like saga-dash, which is install-only and produces no
 * `dist/`) counts as built once installed. Every `fs` error folds to "not built"
 * (⇒ prep runs), the safe default.
 */
function isRepoBuilt(repoRoot: string): boolean {
  const root = repoRoot.replace(/\/+$/, '');
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
 * BLOCKER-B: scan a repo's `packages/node/*` for every package DECLARING a
 * `db:generate` script, returning their repo-relative dirs (up.sh:1010-1013). A
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

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
import { SLOT_UNSUPPORTED_COMMAND_MESSAGE, baseFlags } from './shared-flags.js';
import type { InstanceProfile } from './core/derive-instance.js';
import type { ScriptPlan } from './core/flag-map.js';
import type { RepoKey as ManifestRepoKey } from './core/manifest/index.js';
import {
  buildRepoEnv,
  makeRealDashFs,
  makeRealLauncher,
  makeRealMeshExec,
  makeRealPgProbe,
  makeRealPortProbe,
  makeRealProber,
  makeRealRunner,
  makeRealSnapshotIO,
  resolveScript,
  scriptCwd,
  stopServices,
  REPO_ENV_VAR,
} from './runtime/index.js';
import type {
  DashFs,
  HealthProber,
  MeshExec,
  PgProbe,
  PortProbe,
  RepoKey,
  RepoOverrides,
  Runner,
  ScriptContext,
  ServiceLauncher,
  ServiceStopper,
  SnapshotIO,
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

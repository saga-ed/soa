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

import { Command } from '@oclif/core';
import { baseFlags } from './shared-flags.js';
import type { ScriptPlan } from './core/flag-map.js';
import type { RepoKey as ManifestRepoKey } from './core/manifest/index.js';
import {
  buildRepoEnv,
  makeRealProber,
  makeRealRunner,
  makeRealSnapshotIO,
  resolveScript,
  scriptCwd,
  REPO_ENV_VAR,
} from './runtime/index.js';
import type {
  HealthProber,
  RepoKey,
  RepoOverrides,
  Runner,
  ScriptContext,
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

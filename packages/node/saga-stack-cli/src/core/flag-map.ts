/**
 * The M1 PARITY CONTRACT (plan §7.2 "M1 — Wrapped daily-driver").
 *
 * PURE flag → invocation mappers. Each `stack` daily-driver subcommand maps its
 * parsed (already-normalized, camelCase) flags to a `ScriptPlan` — the exact
 * `{ script, args, env }` a human types today at:
 *
 *   tools/synthetic-dev/up.sh
 *   tools/synthetic-dev/verify.sh
 *
 * The runtime layer (`src/runtime/**`) takes a `ScriptPlan` and `exec`s the
 * matching script through an injectable Runner (stdio inherited). NOTHING here
 * spawns a process, touches the network, or reads the filesystem — this module
 * lives in `core/` and stays PURE so the golden argv/env tests (the single
 * top-named risk across the plan's three review panels) can assert the precise
 * command line without launching real infrastructure.
 *
 * GROUND TRUTH — these mappers were transcribed flag-for-flag from up.sh's
 * arg parser (the leading-verb `case "${1:-up}"` at ~1875 and the trailing
 * `while`/`case` flag loop at ~1893-1926) and verify.sh's env gate
 * (`VERIFY_HEALTH_ONLY` at ~129). Do NOT "improve" the spellings — they must
 * match the scripts byte-for-byte or the wrap diverges from bash.
 *
 * Two up.sh knobs are ENV vars, NOT CLI args (up.sh reads them from the
 * environment, never argv):
 *   --no-auto-pull  → NO_AUTO_PULL=1   (up.sh ~2087)
 *   --skip-prep     → SKIP_PREP=1      (up.sh ~2105)
 * so the corresponding CLI flags translate to `env`, not `args`.
 *
 * Global env (DEV + per-repo path overrides from `--dev`/`--<repo>`, and the
 * `DEV=` verify.sh reads) is layered in by the RUNTIME env builder, not here —
 * these mappers only emit the per-subcommand args/env. See the report TODO.
 */

// The script LOCATOR names which sibling repo a wrapped bash script lives in.
// `RepoKey` is the manifest's env-var-name union (SOA, SAGA_DASH, …). Imported
// as a TYPE only — `import type` never re-exports, so `core/index.ts`'s
// `export *` from this module does not collide with the manifest's own `RepoKey`.
import type { RepoKey } from './manifest/types.js';

/** up.sh `--record [crdt|av]` mode (crdt is the bash default when bare). */
export type RecordMode = 'crdt' | 'av';

/**
 * Where a wrapped bash script lives. GENERALIZES the old hardcoded
 * `'up.sh' | 'verify.sh'` union so ANY script in ANY sibling repo can be named
 * by (a) the `RepoKey` of the repo it lives in and (b) the path RELATIVE to
 * that repo's root. The runtime (`runtime/scripts.ts#resolveScript`) joins the
 * resolved `<repoRoot>` (override env / DEV-based default) with `relPath` to
 * get the absolute command; the script's own directory is used as the cwd.
 *
 * The ONLY remaining `ScriptLocator` today is the SAGA_DASH e2e wrapper (a
 * different repo — `core/e2e-map.ts`); every synthetic-dev script is vendored.
 *
 * Example:
 *   { repo: 'SAGA_DASH', relPath: 'apps/web/dash/e2e/check-e2e.sh' }
 */
export interface ScriptLocator {
  repo: RepoKey;
  relPath: string;
}

/**
 * The single invocation contract every mapper returns. The runtime resolves
 * `script` (a `ScriptLocator`) to an absolute path under its owning repo and
 * spawns it with `args`, merging `env` over the inherited process env.
 */
/** A pure argv/env plan for a command that resolves its OWN (vendored) script path.
 * (overlay compose-rest / tunnel resolve via resolveVendorScript, so they emit no
 * synthetic-dev ScriptLocator — 0 source coupling to tools/synthetic-dev.) */
export interface ArgvPlan {
  args: string[];
  env: Record<string, string>;
}

export interface ScriptPlan {
  script: ScriptLocator;
  args: string[];
  env: Record<string, string>;
}

/**
 * Repo-relative dir holding the per-dev overlay tsv DATA file
 * (`integration-suite.local.tsv`). This is the SOLE remaining reference to
 * `tools/synthetic-dev` — a gitignored per-dev DATA path (read by `stack verify`
 * + `stack overlay`), NOT a script. Every synthetic-dev SCRIPT (up.sh/verify.sh/
 * refresh-suite.sh/tunnel.sh/browser-login.mjs/seed-demo-polls.mjs) + the
 * rtsm-fleet-local.json config are now VENDORED under the CLI's `vendor/` dir, so
 * NOTHING here builds a `tools/synthetic-dev` SCRIPT locator anymore.
 */
export const SYNTH_DEV_DIR = 'tools/synthetic-dev';

// NOTE (Phase 2/FINISH, saga-ed/soa#214): the `up()`/`status()`/`login()` up.sh
// mappers + the `synthScript()` up.sh locator builder were ALL REMOVED — `stack up`,
// `stack status`, and `stack login` (+ `up --login`) are now FULLY NATIVE (no up.sh
// wrapper: native launch/health/cookie-jar). There is NO `synthScript('up.sh')` left
// anywhere; the only wrapped bash scripts remaining are the VENDORED ones
// (overlay→refresh-suite.sh, tunnel→tunnel.sh, both via `resolveVendorScript`) and the
// SAGA_DASH e2e scripts (`core/e2e-map.ts`, a different repo's ScriptLocator).

// ─────────────────────────────────────────────────────────────────────────────
// The remaining sole-implementation synthetic-dev wrappers: overlay / tunnel.
//
// As with the mappers above, these are PURE flag→invocation transforms,
// transcribed flag-for-flag from the scripts' own arg parsers:
//   overlay   → refresh-suite.sh  (arg loop ~lines 328-343; verbs --prs/--list/
//               --reset/--compose-rest, env BASE + SANDBOX_* knobs)
//   tunnel    → tunnel.sh         (verb dispatch `case "${1:-up}"` ~258-269)
// ─────────────────────────────────────────────────────────────────────────────

/** `stack overlay` sub-verbs → refresh-suite.sh modes. */
export type OverlayVerb = 'apply' | 'list' | 'reset' | 'compose-rest';

/**
 * `stack overlay` options (normalized by the command layer).
 *
 * The verb selects refresh-suite.sh's mode; the rest fill in that mode's argv
 * (`repos` / `sandbox`) or its env knobs:
 *   - `apply`        bare → file-driven (integration-suite.local.tsv); with
 *                    `prs` → ad-hoc `--prs <set> <repo…>`.
 *   - `list`         → `--list`.
 *   - `reset`        → `--reset [repo…]`.
 *   - `compose-rest` → `--compose-rest <name>` (name = `sandbox`).
 *
 * refresh-suite.sh reads BASE / SANDBOX_* from the ENVIRONMENT (never argv), so
 * `base`/`ttlHours`/`seedProfile`/`bypassHeader` map to env, not args — mirroring
 * how up.sh's `--no-auto-pull`/`--skip-prep` are env, not flags.
 */
export interface OverlayOptions {
  /** `apply` only: explicit ad-hoc PR/branch set (`--prs <#s|branch>`); requires `repos`. */
  prs?: string;
  /** Trailing repo names (positional in bash) — for `apply --prs …` and `reset`. */
  repos?: string[];
  /** `compose-rest` only: the sandbox name (`--compose-rest <name>`). */
  sandbox?: string;
  /** env BASE — non-main base ref the overlay rebuilds on (refresh-suite.sh ~56). */
  base?: string;
  /** `compose-rest`: env SANDBOX_TTL_HOURS (refresh-suite.sh ~113). */
  ttlHours?: string;
  /** `compose-rest`: env SANDBOX_SEED_PROFILE (refresh-suite.sh ~114). */
  seedProfile?: string;
  /** `compose-rest`: env SANDBOX_BYPASS_HEADER (refresh-suite.sh ~112). Unset ⇒ spec-only (exit 2). */
  bypassHeader?: string;
}

/**
 * `stack overlay <verb>` → refresh-suite.sh.
 *
 * EXIT-CODE NOTE (compose-rest): when no bypass header is set, refresh-suite.sh
 * prints the sandbox spec and returns exit code **2** ("spec printed, composed
 * NOTHING") to distinguish a no-op from a real compose or a hard failure. This
 * mapper does not encode that — it is a RUNTIME exit code; the command layer
 * preserves it by propagating the child's exit code verbatim (no `propagateExit:
 * false`), so a `&&` chain / CI sees the 2.
 */
export function overlay(verb: OverlayVerb, opts: OverlayOptions = {}): ArgvPlan {
  const args: string[] = [];
  const repos = opts.repos ?? [];

  switch (verb) {
    case 'list':
      args.push('--list');
      break;
    case 'reset':
      args.push('--reset', ...repos);
      break;
    case 'compose-rest':
      // The command layer guarantees `sandbox` is present for this verb.
      args.push('--compose-rest', opts.sandbox as string);
      break;
    case 'apply':
      // Bare apply = file-driven (no args). `--prs` switches to the ad-hoc form.
      if (opts.prs !== undefined) args.push('--prs', opts.prs, ...repos);
      break;
    /* c8 ignore next 2 — exhaustive guard for the 4-member verb union. */
    default:
      throw new Error(`unknown overlay verb: ${String(verb)}`);
  }

  const env: Record<string, string> = {};
  if (opts.base !== undefined) env.BASE = opts.base;
  if (opts.ttlHours !== undefined) env.SANDBOX_TTL_HOURS = opts.ttlHours;
  if (opts.seedProfile !== undefined) env.SANDBOX_SEED_PROFILE = opts.seedProfile;
  if (opts.bypassHeader !== undefined) env.SANDBOX_BYPASS_HEADER = opts.bypassHeader;

  return { args, env }; // vendored refresh-suite.sh resolved by the command via resolveVendorScript
}

/** `stack tunnel` sub-verbs → tunnel.sh dispatch (`case "${1:-up}"`). */
export type TunnelVerb = 'up' | 'down' | 'status' | 'moniker' | 'urls' | 'aws-profile';

/** `stack tunnel` options. */
export interface TunnelOptions {
  /** env VMS_BASE — the rendezvous domain (tunnel.sh ~42). */
  vmsBase?: string;
}

/**
 * `stack tunnel <verb>` → tunnel.sh.
 *
 * MONIKER IS NEVER A FLAG. tunnel.sh deliberately refuses to take the moniker on
 * argv (a placeholder moniker in a shared command cross-contaminates stacks); it
 * prompts on the TTY on first use. So `moniker` here is only ever the dispatch
 * VERB — the value is read/prompted by the script. The command therefore runs
 * every tunnel verb with stdio inherited (the prompt + frpc progress own the
 * user's terminal). `AWS_PROFILE` is honored from the ambient env by tunnel.sh
 * (it resolves the dev-account profile itself), so it is not a flag here.
 */
export function tunnel(verb: TunnelVerb, opts: TunnelOptions = {}): ArgvPlan {
  const env: Record<string, string> = {};
  if (opts.vmsBase !== undefined) env.VMS_BASE = opts.vmsBase;
  return { args: [verb], env }; // vendored tunnel.sh resolved by the command via resolveVendorScript
}


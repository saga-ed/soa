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

// SeedAddOn / SeedProfile are owned by `core/seed` (re-exported through the core
// barrel) — imported here as types, not re-exported, to avoid a duplicate-name
// clash in `core/index.ts`'s `export *`.
import type { SeedProfile } from './seed/types.js';
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
 * Examples:
 *   { repo: 'SOA',       relPath: 'tools/synthetic-dev/up.sh' }
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
export interface ScriptPlan {
  script: ScriptLocator;
  args: string[];
  env: Record<string, string>;
}

/** Repo-relative dir holding the synthetic-dev bash scripts (up/verify/refresh/tunnel/bootstrap). */
export const SYNTH_DEV_DIR = 'tools/synthetic-dev';

/**
 * Terse locator builder for a script in `soa`'s `tools/synthetic-dev/` dir —
 * keeps the up()/verify() (and the later overlay/tunnel/bootstrap) mappers
 * concise. Later phases wrapping saga-dash e2e scripts build their own
 * `{ repo: 'SAGA_DASH', relPath: 'apps/web/dash/e2e/…' }` locators directly.
 */
export function synthScript(name: string): ScriptLocator {
  return { repo: 'SOA', relPath: `${SYNTH_DEV_DIR}/${name}` };
}

/**
 * `stack up` flags (normalized to camelCase by the command layer).
 *
 * `seed` / `login` / `record` model up.sh's optional positional after the flag:
 *   - `seed`:  a `SeedProfile` ⇒ `--seed <profile>`. (A bare `--seed`, which
 *     up.sh defaults to `roster`, should be resolved to `'roster'` by the
 *     command layer before calling — keeps this mapper's output unambiguous.)
 *   - `login`: `true` ⇒ bare `--login` (default persona dev@saga.org);
 *     a string ⇒ `--login <email>`.
 *   - `record`: `true` ⇒ bare `--record` (crdt default); a `RecordMode` ⇒
 *     `--record <mode>`.
 */
export interface UpFlags {
  /** Leading verb flips from `up` to `restart` (up.sh: `restart` is a verb, not a trailing flag). */
  restart?: boolean;
  reset?: boolean;
  seed?: SeedProfile;
  /** `--pull`: force a full ff-only sync of every sibling before build. */
  pull?: boolean;
  /** `--no-auto-pull`: opt out of the automatic auto-pull pass ⇒ env NO_AUTO_PULL=1. */
  noAutoPull?: boolean;
  /** `--skip-prep`: skip the install+build prep pass ⇒ env SKIP_PREP=1. */
  skipPrep?: boolean;
  record?: RecordMode | boolean;
  withPlayback?: boolean;
  withQtfDemo?: boolean;
  tunnel?: boolean;
  login?: string | boolean;
  /**
   * M1: passed THROUGH verbatim to up.sh's existing SINGLE-service `--only`
   * semantics (up.sh validates the value against its known-service list and
   * rejects a comma-list). The plan's NEW comma-list + dependency-closure
   * `--only` is native partial-stack work and lands at M4 — NOT here.
   */
  only?: string;
  /** `--sandbox <name>` (up.sh requires it accompany `--only`; up.sh self-validates). */
  sandbox?: string;
  /** `--workspace <file.json>` (up.sh: mutually exclusive with --only/--sandbox; self-validated). */
  workspace?: string;
}

/**
 * `stack up` → up.sh.
 *
 * Canonical, DETERMINISTIC flag order (up.sh's trailing `while` loop is
 * order-insensitive, so we pick one stable order for the golden tests):
 *   <verb> --reset --seed <p> --pull --record [m] --with-playback
 *   --with-qtf-demo --tunnel --login [e] --only <s> --sandbox <n> --workspace <f>
 *
 * The leading verb is `restart` when `restart` is set, else `up` (up.sh treats
 * `up` and `restart` as distinct leading verbs; `--restart` is NOT a valid
 * trailing flag in up.sh's loop, so it must surface as the verb).
 */
export function up(flags: UpFlags = {}): ScriptPlan {
  const args: string[] = [flags.restart ? 'restart' : 'up'];

  if (flags.reset) args.push('--reset');

  if (flags.seed !== undefined) args.push('--seed', flags.seed);

  if (flags.pull) args.push('--pull');

  if (flags.record) {
    args.push('--record');
    if (typeof flags.record === 'string') args.push(flags.record);
  }

  if (flags.withPlayback) args.push('--with-playback');
  if (flags.withQtfDemo) args.push('--with-qtf-demo');
  if (flags.tunnel) args.push('--tunnel');

  if (flags.login) {
    args.push('--login');
    if (typeof flags.login === 'string') args.push(flags.login);
  }

  if (flags.only !== undefined) args.push('--only', flags.only);
  if (flags.sandbox !== undefined) args.push('--sandbox', flags.sandbox);
  if (flags.workspace !== undefined) args.push('--workspace', flags.workspace);

  const env: Record<string, string> = {};
  if (flags.noAutoPull) env.NO_AUTO_PULL = '1';
  if (flags.skipPrep) env.SKIP_PREP = '1';

  return { script: synthScript('up.sh'), args, env };
}

/** `stack status` → up.sh `--status` (flag-only; health + row counts, then exit). */
export function status(): ScriptPlan {
  return { script: synthScript('up.sh'), args: ['--status'], env: {} };
}

/**
 * `stack login [email]` → up.sh `--login [email]`. A bare invocation logs in the
 * default persona (dev@saga.org); an email overrides it. Used by `stack login
 * --browser` (the headful Chromium auto-login) and by the native `up --login`
 * delegation in the StackApi facade.
 */
export function login(email?: string): ScriptPlan {
  const args = ['--login'];
  if (email !== undefined) args.push(email);
  return { script: synthScript('up.sh'), args, env: {} };
}

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
export function overlay(verb: OverlayVerb, opts: OverlayOptions = {}): ScriptPlan {
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

  return { script: synthScript('refresh-suite.sh'), args, env };
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
export function tunnel(verb: TunnelVerb, opts: TunnelOptions = {}): ScriptPlan {
  const env: Record<string, string> = {};
  if (opts.vmsBase !== undefined) env.VMS_BASE = opts.vmsBase;
  return { script: synthScript('tunnel.sh'), args: [verb], env };
}


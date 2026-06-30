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
import type { SeedAddOn, SeedProfile } from './seed/types.js';

/** up.sh `--record [crdt|av]` mode (crdt is the bash default when bare). */
export type RecordMode = 'crdt' | 'av';

/**
 * The single invocation contract every mapper returns. The runtime resolves
 * `script` to an absolute path under `tools/synthetic-dev/` and spawns it with
 * `args`, merging `env` over the inherited process env.
 */
export interface ScriptPlan {
  script: 'up.sh' | 'verify.sh';
  args: string[];
  env: Record<string, string>;
}

/**
 * Thrown when a CLI flag has no bash antecedent and is not yet wired in M1.
 * The command layer renders `.message` as a friendly oclif error.
 */
export class FlagNotAvailableError extends Error {
  constructor(flag: string, milestone: string) {
    super(`${flag} is not available until ${milestone}.`);
    this.name = 'FlagNotAvailableError';
  }
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

/** `stack seed` flags. */
export interface SeedFlags {
  /** Base profile. A bare `stack seed` should be resolved to `'roster'` by the command layer. */
  profile: SeedProfile;
  /** Orthogonal add-ons layered on the profile (`playback` ⇒ --with-playback, `qtf` ⇒ --with-qtf-demo). */
  addOns?: SeedAddOn[];
}

/** `stack reset` flags. */
export interface ResetFlags {
  /** Also truncate the opt-in playback DBs (up.sh: `--reset --with-playback`). */
  withPlayback?: boolean;
}

/** `stack verify` flags. */
export interface VerifyFlags {
  /** Fast health gate ⇒ env VERIFY_HEALTH_ONLY=1 (verify.sh ~129). */
  healthOnly?: boolean;
  /**
   * NEW flag (generalizes verify.sh's hardcoded dash tolerance). It has NO
   * antecedent in verify.sh, which is purely env-driven and accepts no argv —
   * so it is M1-unsupported and lands when verify is re-implemented natively (M2).
   */
  tolerate?: string | string[];
}

/** Map a `SeedAddOn` to its up.sh flag spelling. */
function addOnFlag(addOn: SeedAddOn): string {
  switch (addOn) {
    case 'playback':
      return '--with-playback';
    case 'qtf':
      return '--with-qtf-demo';
    /* c8 ignore next 2 — exhaustive guard for a 2-member union. */
    default:
      throw new Error(`unknown seed add-on: ${String(addOn)}`);
  }
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

  return { script: 'up.sh', args, env };
}

/**
 * `stack down` → up.sh `--down` (flag-only invocation; up.sh skips the up path,
 * stops services, and leaves the mesh up).
 *
 * NOTE: the plan's NEW `stack down --mesh` (also tear the mesh down) has no
 * up.sh antecedent and is not part of this M1 mapper — add when it lands.
 */
export function down(): ScriptPlan {
  return { script: 'up.sh', args: ['--down'], env: {} };
}

/** `stack restart` → up.sh `restart` (leading verb; clean bounce, no data wipe). */
export function restart(): ScriptPlan {
  return { script: 'up.sh', args: ['restart'], env: {} };
}

/** `stack status` → up.sh `--status` (flag-only; health + row counts, then exit). */
export function status(): ScriptPlan {
  return { script: 'up.sh', args: ['--status'], env: {} };
}

/**
 * `stack seed` → up.sh `--seed <profile>` (+ add-ons). Flag-only invocation:
 * against an already-running stack up.sh skips the up step and just seeds.
 */
export function seed(flags: SeedFlags): ScriptPlan {
  const args = ['--seed', flags.profile];
  for (const addOn of flags.addOns ?? []) args.push(addOnFlag(addOn));
  return { script: 'up.sh', args, env: {} };
}

/**
 * `stack reset` → up.sh `--reset` (+ `--with-playback` to also truncate the
 * playback DBs). Flag-only invocation.
 */
export function reset(flags: ResetFlags = {}): ScriptPlan {
  const args = ['--reset'];
  if (flags.withPlayback) args.push('--with-playback');
  return { script: 'up.sh', args, env: {} };
}

/**
 * `stack login [email]` → up.sh `--login [email]`. A bare invocation logs in the
 * default persona (dev@saga.org); an email overrides it.
 */
export function login(email?: string): ScriptPlan {
  const args = ['--login'];
  if (email !== undefined) args.push(email);
  return { script: 'up.sh', args, env: {} };
}

/**
 * `stack verify` → verify.sh. verify.sh takes NO argv; its only mode knob is the
 * `VERIFY_HEALTH_ONLY=1` env gate. `--tolerate` is M1-unsupported (no bash
 * antecedent — see VerifyFlags).
 */
export function verify(flags: VerifyFlags = {}): ScriptPlan {
  if (
    flags.tolerate !== undefined &&
    (Array.isArray(flags.tolerate) ? flags.tolerate.length > 0 : true)
  ) {
    throw new FlagNotAvailableError('verify --tolerate', 'M2');
  }
  const env: Record<string, string> = {};
  if (flags.healthOnly) env.VERIFY_HEALTH_ONLY = '1';
  return { script: 'verify.sh', args: [], env };
}

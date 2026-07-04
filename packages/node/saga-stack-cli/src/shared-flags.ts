/**
 * Shared flag definitions reused by every saga-stack command.
 *
 * Commands import from here to avoid redefining the same output-shape /
 * workspace-discovery flags in every file. These are the GLOBAL flags from
 * the plan (§3): every command spreads `...BaseCommand.baseFlags`.
 *
 *   --porcelain / --output-json   output shape (consumed by emit())
 *   --dev <dir>                   sibling-repo workspace root
 *   --state-dir <dir>            scratch/state dir for pid files, snapshots, …
 *   --<repo>                      per-repo path overrides (RepoKey set)
 *
 * NOTE: the retired mesh-fixture HTTP-create flags (`asFlag`, `sourceFlag`,
 * `fixtureIdFlag`) are intentionally NOT ported — they belonged to the
 * create commands that this CLI replaces.
 *
 * NOTE: per-service URL flags (e.g. `--iam-url`) are NOT global here — they
 * attach to the specific commands that talk to a service (M1+). When the
 * iam-api URL flag is reintroduced its default is the CORRECTED `:3010`
 * (mesh-fixture's `:3000` was stale), per the plan.
 */

import { Flags } from '@oclif/core';

/** Default sibling-repo workspace root: `$DEV ?? $HOME/dev`. */
const defaultDevDir = process.env.DEV ?? `${process.env.HOME ?? ''}/dev`;

/**
 * Per-repo path-override flags. Each maps a `RepoKey` to a CLI flag that
 * pins that repo's checkout location, overriding `<dev>/<dir>` discovery.
 * Defaults come from the matching env var (the convention `up.sh` already
 * uses), falling back to undefined so `core` can derive the path from
 * `--dev` at resolution time.
 */
export const repoFlags = {
  soa: Flags.string({
    description: 'override path to the soa repo checkout',
    default: process.env.SOA,
  }),
  rostering: Flags.string({
    description: 'override path to the rostering repo checkout',
    default: process.env.ROSTERING,
  }),
  'program-hub': Flags.string({
    description: 'override path to the program-hub repo checkout',
    default: process.env.PROGRAM_HUB,
  }),
  'saga-dash': Flags.string({
    description: 'override path to the saga-dash repo checkout',
    default: process.env.SAGA_DASH,
  }),
  coach: Flags.string({
    description: 'override path to the coach repo checkout',
    default: process.env.COACH,
  }),
  sds: Flags.string({
    description: 'override path to the sds (student-data-system) repo checkout',
    default: process.env.SDS,
  }),
  qboard: Flags.string({
    description: 'override path to the qboard repo checkout',
    default: process.env.QBOARD,
  }),
  rtsm: Flags.string({
    description: 'override path to the rtsm repo checkout',
    default: process.env.RTSM,
  }),
  fleek: Flags.string({
    description: 'override path to the fleek repo checkout',
    default: process.env.FLEEK,
  }),
};

/**
 * The error surfaced when `--slot > 0` is passed on a command that is NOT
 * slot-aware (M7 Phase 2). Phase 2 makes `stack up`/`status`/`verify`/`down`
 * bring up / act on an ISOLATED `soa-s<N>` stack; every OTHER command — the
 * wrapper-lifecycle set (`reset`/`restart`/`overlay`/`bootstrap`/`seed`) plus
 * `login`/`tunnel`/`snapshot`/… — still delegates to up.sh's HOST-GLOBAL
 * lifecycle (`pkill -f tsup`, `nuke_vite`, fixed `STATE=/tmp/sds-synthetic`),
 * which would clobber other slots. Those FAIL FAST here rather than silently
 * corrupt a peer slot. Enforced in `BaseCommand.parse`, opted out per-command via
 * `slotAware()`. Slot 0 (the default) is unaffected everywhere.
 */
export const SLOT_UNSUPPORTED_COMMAND_MESSAGE =
  'multi-slot (--slot > 0) is not supported for this command yet — the slot-aware set is ' +
  "'stack up/status/verify/down/reset/seed/snapshot/login' and 'e2e run'. The rest " +
  '(restart/overlay/bootstrap/tunnel) operate on shared checkouts, slot-0 state, or fixed ' +
  'slot-0 ports and would cross slots; run them against slot 0 only. (A --set carrying ' +
  'slot > 0 hits this same guard.)';

/**
 * The error surfaced when `--set` is passed on a command that cannot thread a
 * worktree set (M13-A). A set = repo paths + a slot ≥ 1, so the set-aware
 * commands are exactly the slot-aware lifecycle set; `restart`/`tunnel` are
 * slot-0-only by design and the wrapper/overlay commands act on the primary
 * checkouts. Enforced in `BaseCommand.parse`, opted in per-command via
 * `setAware()`.
 */
export const SET_UNSUPPORTED_COMMAND_MESSAGE =
  '--set is not supported for this command — worktree sets thread repo paths + a slot ' +
  "into 'stack up/status/verify/down/reset/seed/snapshot' and 'e2e run' (see `ss set list`). " +
  'This command is slot-0 / primary-checkout only.';

export const baseFlags = {
  porcelain: Flags.boolean({
    description: 'machine-readable output; no color, minimal noise',
    default: false,
  }),
  slot: Flags.integer({
    default: 0,
    min: 0,
    // CEILING 9 (M7 MINOR): the mesh's rabbitmq (:5672) and rabbitmq-mgmt (:15672)
    // differ by 10000 = 10 * the 1000 stride, so slot 10's rabbitmq (:15672) would
    // collide with slot 0's rabbitmq-mgmt (:15672). Cap at 9 so every slot's full
    // resolved port band stays disjoint. Slot > 0 is a BACKEND sub-stack (the
    // literal-port backends + browser frontends are excluded — see derive-instance).
    max: 9,
    description:
      'stack instance slot (0 = default; N in 1..9 offsets ports by N*1000 into an isolated soa-s<N> BACKEND sub-stack — the literal-port backends + browser frontends stay on slot 0). Ceiling is 9: slot 10 would collide rabbitmq (:15672) with slot 0 rabbitmq-mgmt.',
  }),
  'output-json': Flags.boolean({
    description: 'emit structured JSON on stdout instead of human-readable text',
    default: false,
  }),
  set: Flags.string({
    // NO oclif default: an unset `--set` stays `undefined` (= no set in play),
    // mirroring `--state-dir`. The M13-A injection in `BaseCommand.parse` then
    // rewrites the repo flags the user did not type + `slot` from the named set.
    description:
      'worktree set to run against (M13): a named repo→path map bound to a slot, from ' +
      '$SAGA_STACK_SETS ?? ~/.saga-stack/worktree-sets.json. Supplies the slot and any repo ' +
      'path you did not pin explicitly (--<repo> flags win; env vars lose to the set).',
  }),
  dev: Flags.string({
    description: 'sibling-repo workspace root (where the saga repos are checked out)',
    default: defaultDevDir,
  }),
  'state-dir': Flags.string({
    description:
      'scratch dir for pid files, snapshots, and other run state (default /tmp/sds-synthetic, or /tmp/sds-synthetic-s<N> for --slot N)',
    // NO oclif default: an unset `--state-dir` stays `undefined` so a slot-aware
    // command can fall back to the slot's `InstanceProfile.stateDir` (an explicit
    // `--state-dir` still wins). The launcher's `DEFAULT_STATE_DIR` (/tmp/sds-
    // synthetic) is the ultimate fallback for callers that pass it through
    // unchanged (e2e), so slot 0 stays /tmp/sds-synthetic.
  }),
  ...repoFlags,
};

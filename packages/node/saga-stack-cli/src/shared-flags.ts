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
 * The error surfaced when `--slot > 0` is passed on any command. Multi-slot
 * bring-up (the mesh-project / container / down threading) lands in M7 Phase 2;
 * until then a slot > 0 must FAIL FAST rather than half-run at the base slot 0
 * ports and silently clobber a live default stack. Enforced centrally in
 * `BaseCommand.parse`, so every command that spreads `baseFlags` is guarded.
 */
export const SLOT_PHASE2_MESSAGE =
  'multi-slot (--slot > 0) is not enabled yet — Phase 2. Only --slot 0 (the default) is supported for now.';

export const baseFlags = {
  porcelain: Flags.boolean({
    description: 'machine-readable output; no color, minimal noise',
    default: false,
  }),
  slot: Flags.integer({
    default: 0,
    min: 0,
    description:
      'stack instance slot (0 = default; N>0 offsets ports by N*1000 into an isolated soa-s<N> stack). Multi-slot bring-up lands in a later phase.',
  }),
  'output-json': Flags.boolean({
    description: 'emit structured JSON on stdout instead of human-readable text',
    default: false,
  }),
  dev: Flags.string({
    description: 'sibling-repo workspace root (where the saga repos are checked out)',
    default: defaultDevDir,
  }),
  'state-dir': Flags.string({
    description: 'scratch dir for pid files, snapshots, and other run state',
    default: '/tmp/sds-synthetic',
  }),
  ...repoFlags,
};

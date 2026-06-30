/**
 * `saga-stack stack overlay <verb>` — overlay your in-flight PRs onto a
 * main-based synthetic-dev (M2 thin wrapper over refresh-suite.sh).
 *
 * Verbs map to refresh-suite.sh modes (see `flagMap.overlay`):
 *   apply [--prs <#s|branch> <repo…>]   bare → apply integration-suite.local.tsv;
 *                                        with --prs → ad-hoc overlay of an explicit set
 *   list                                 print your personal overlay file
 *   reset [repo…]                        back overlaid repos out to main
 *   compose-rest <name> [--base/--ttl-hours/--seed-profile/--bypass-header]
 *                                        compose the NOT-pinned services as cloud
 *                                        sandbox <name> (the complement of your overlay)
 *
 * INTERACTIVE / EXIT-CODE NOTES (preserved verbatim from bash):
 *   - compose-rest WITHOUT --bypass-header prints the sandbox spec and exits **2**
 *     ("spec printed, composed NOTHING") — a deliberate non-zero that is NOT a
 *     hard failure. We propagate the child exit code verbatim, so the 2 reaches a
 *     `&&` chain / CI exactly as bare refresh-suite.sh would deliver it.
 *   - compose-rest WITH --bypass-header POSTs to the sandbox API and polls (up to
 *     ~20m), streaming progress; stdio is inherited so that hold runs in the
 *     foreground, same as the script.
 *
 *   node bin/dev.js stack overlay list
 *   node bin/dev.js stack overlay apply --prs 165 saga-dash
 *   node bin/dev.js stack overlay reset rostering
 *   node bin/dev.js stack overlay compose-rest dev --ttl-hours 6
 */

import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import * as flagMap from '../../core/flag-map.js';
import type { OverlayVerb } from '../../core/flag-map.js';

const VERBS: readonly OverlayVerb[] = ['apply', 'list', 'reset', 'compose-rest'];

export default class StackOverlay extends BaseCommand {
  static description =
    'Overlay your in-flight PRs onto a main-based synthetic-dev (wraps refresh-suite.sh).';

  static examples = [
    '<%= config.bin %> <%= command.id %> list',
    '<%= config.bin %> <%= command.id %> apply --prs 165 saga-dash',
    '<%= config.bin %> <%= command.id %> reset rostering',
    '<%= config.bin %> <%= command.id %> compose-rest dev --ttl-hours 6',
  ];

  // Trailing positionals vary by verb (repo list for apply/reset, sandbox name
  // for compose-rest), so accept extra args and read them off `argv`.
  static strict = false;

  static args = {
    verb: Args.string({
      description: 'overlay action',
      options: [...VERBS],
      default: 'apply',
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    prs: Flags.string({
      description:
        'apply: ad-hoc PR/branch set to overlay (refresh-suite.sh --prs <#s|branch>); requires one or more trailing repo names',
    }),
    base: Flags.string({
      description: 'base ref the overlay rebuilds on (refresh-suite.sh env BASE; default main)',
    }),
    'ttl-hours': Flags.string({
      description: 'compose-rest: sandbox TTL in hours (refresh-suite.sh env SANDBOX_TTL_HOURS)',
    }),
    'seed-profile': Flags.string({
      description: 'compose-rest: sandbox seed profile (refresh-suite.sh env SANDBOX_SEED_PROFILE)',
    }),
    'bypass-header': Flags.string({
      description:
        "compose-rest: ALB-perimeter bypass header 'Name: value' (refresh-suite.sh env SANDBOX_BYPASS_HEADER). Omit to print the spec only (exit 2, composes nothing).",
    }),
  };

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(StackOverlay);

    // argv = positional tokens only (oclif strips flags). argv[0] is the verb;
    // the remainder are repo names (apply/reset) or the sandbox name (compose-rest).
    const positionals = argv as string[];
    const verb = (positionals[0] ?? 'apply') as string;
    const rest = positionals.slice(1);

    if (!VERBS.includes(verb as OverlayVerb)) {
      this.error(`unknown overlay verb '${verb}'. Use one of: ${VERBS.join(', ')}.`);
    }
    const v = verb as OverlayVerb;

    // Per-verb argument validation (friendly, before bash would reject it).
    if (v === 'compose-rest' && rest.length !== 1) {
      this.error('overlay compose-rest needs exactly one sandbox name, e.g. `overlay compose-rest dev`.');
    }
    if (v === 'apply' && flags.prs && rest.length === 0) {
      this.error('overlay apply --prs needs at least one repo, e.g. `overlay apply --prs 165 saga-dash`.');
    }
    if (v === 'apply' && !flags.prs && rest.length > 0) {
      // Bare `apply` is file-driven (reads integration-suite.local.tsv) and
      // ignores positional repos — silently dropping them would surprise the
      // user. Require --prs to act on an explicit repo set.
      this.error(
        `overlay apply ignores positional repos unless --prs is given (bare apply is file-driven). Did you mean \`overlay apply --prs <#s|branch> ${rest.join(' ')}\`?`,
      );
    }
    if (v === 'list' && rest.length > 0) {
      this.error('overlay list takes no positional arguments.');
    }

    const plan = flagMap.overlay(v, {
      prs: flags.prs,
      repos: v === 'reset' || v === 'apply' ? rest : undefined,
      sandbox: v === 'compose-rest' ? rest[0] : undefined,
      base: flags.base,
      ttlHours: flags['ttl-hours'],
      seedProfile: flags['seed-profile'],
      bypassHeader: flags['bypass-header'],
    });

    // Propagate the child exit code verbatim — this is what preserves
    // compose-rest's exit-2 ("spec printed, composed nothing") semantics.
    await this.runScript(plan, flags);
  }
}

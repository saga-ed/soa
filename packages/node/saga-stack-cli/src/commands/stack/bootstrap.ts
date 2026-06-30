/**
 * `saga-stack stack bootstrap` — one command to stand up the synthetic-dev stack
 * on main (M2 thin wrapper over bootstrap.sh).
 *
 * Chains ensure-repos → refresh-suite → up.sh up --reset --seed <p> → verify.sh,
 * stopping at the first failing step. Maps to `flagMap.bootstrap`:
 *   --no-refresh   → bootstrap.sh --no-refresh
 *   --seed <p>     → bootstrap.sh --seed <roster|full>
 *
 * INTERACTIVE: bootstrap.sh's step-1 provisioning prompt ("Provision the repo(s)
 * now? [y/N]") is interactive; we inherit stdio so the user answers at the TTY.
 *
 * `--yes` (NEW, non-interactive) is accepted but NOT yet honorable by the wrap:
 * bootstrap.sh has no non-interactive provisioning path and rejects unknown
 * flags, so the mapper raises a clear `FlagNotAvailableError` rather than break
 * bash or silently no-op. It lands when bootstrap goes native.
 *
 *   node bin/dev.js stack bootstrap
 *   node bin/dev.js stack bootstrap --no-refresh --seed full
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import * as flagMap from '../../core/flag-map.js';
import { FlagNotAvailableError } from '../../core/flag-map.js';
import type { SeedProfile } from '../../core/seed/types.js';

export default class StackBootstrap extends BaseCommand {
  static description =
    'Stand up the synthetic-dev stack on main: ensure repos → overlay → up → verify (wraps bootstrap.sh).';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --no-refresh --seed full',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    'no-refresh': Flags.boolean({
      description: 'skip the refresh-suite overlay step (bootstrap.sh --no-refresh)',
      default: false,
    }),
    seed: Flags.string({
      description: 'seed profile for the up step (bootstrap.sh --seed <roster|full>)',
      options: ['roster', 'full'],
      default: 'roster',
    }),
    yes: Flags.boolean({
      description:
        'non-interactive auto-confirm (NEW — not yet supported: bootstrap.sh has no non-interactive antecedent)',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(StackBootstrap);

    let plan;
    try {
      plan = flagMap.bootstrap({
        noRefresh: flags['no-refresh'],
        seed: flags.seed as SeedProfile | undefined,
        yes: flags.yes,
      });
    } catch (err) {
      if (err instanceof FlagNotAvailableError) this.error(err.message);
      throw err;
    }

    await this.runScript(plan, flags);
  }
}

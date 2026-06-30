/**
 * `saga-stack stack seed [profile]` — seed an already-running stack (M1 thin
 * wrapper).
 *
 * Maps to `flagMap.seed({ profile, addOns })` → `up.sh --seed <profile>` (+ the
 * add-on flags): against a running stack up.sh skips the up step and just seeds.
 *
 * The optional `profile` arg defaults to `roster` (up.sh's own bare-`--seed`
 * default). Add-ons are surfaced as booleans the mapper translates:
 *   --with-playback → `playback` → up.sh --with-playback
 *   --with-qtf-demo → `qtf`      → up.sh --with-qtf-demo
 *
 *   node bin/dev.js stack seed
 *   node bin/dev.js stack seed full --with-playback
 */

import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import * as flagMap from '../../core/flag-map.js';
import type { SeedAddOn, SeedProfile } from '../../core/seed/types.js';

export default class StackSeed extends BaseCommand {
  static description = 'Seed a running stack (wraps up.sh --seed <profile>).';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> full --with-playback',
  ];

  static args = {
    profile: Args.string({
      description: 'seed profile to apply',
      options: ['roster', 'full'],
      default: 'roster',
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'with-playback': Flags.boolean({
      description:
        'also seed the playback DBs (up.sh --with-playback). NOTE: up.sh treats --with-playback as a launch directive — without --reset/--restart it implies a full stack bring-up (DO_UP), so on a seed-only invocation this brings the whole stack up rather than seeding in place. Prefer `stack up --with-playback --seed <profile>` when you want the bring-up.',
      default: false,
    }),
    'with-qtf-demo': Flags.boolean({
      description: 'also seed the QTF demo data (up.sh --with-qtf-demo)',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(StackSeed);

    const addOns: SeedAddOn[] = [];
    if (flags['with-playback']) addOns.push('playback');
    if (flags['with-qtf-demo']) addOns.push('qtf');

    const plan = flagMap.seed({ profile: args.profile as SeedProfile, addOns });
    await this.runScript(plan, flags);
  }
}

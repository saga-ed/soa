/**
 * `saga-stack stack seed [profile]` — seed an already-running stack (M1 thin
 * wrapper).
 *
 * Maps to `flagMap.seed({ profile, addOns })` → `up.sh --seed <profile>` (+ the
 * add-on flags): against a running stack up.sh skips the up step and just seeds.
 *
 * The optional `profile` arg defaults to `roster` (up.sh's own bare-`--seed`
 * default). A bundle's DATA scope on `seed` is its SEED ADD-ON (`--with playback`
 * ⇒ `playback` ⇒ up.sh --with-playback; `--with qtf` ⇒ `qtf` ⇒ up.sh
 * --with-qtf-demo) — derived from the shared bundle registry, so `--with
 * playback` reproduces exactly what the old `--with-playback` boolean did. A
 * bundle with no seed add-on (`--with dash`/`coach`/`connect`) is a harmless
 * no-op here.
 *
 *   node bin/dev.js stack seed
 *   node bin/dev.js stack seed full --with playback
 */

import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { BUNDLE_NAMES, seedAddOnsFor } from '../../core/bundles.js';
import * as flagMap from '../../core/flag-map.js';
import type { SeedAddOn, SeedProfile } from '../../core/seed/types.js';

export default class StackSeed extends BaseCommand {
  static description = 'Seed a running stack (wraps up.sh --seed <profile>).';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> full --with playback',
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
    with: Flags.string({
      multiple: true,
      options: [...BUNDLE_NAMES],
      description:
        "convenience bundle(s) whose seed ADD-ON is layered onto the seed plan — sugar shared with `stack up`. Repeatable: --with playback --with qtf. `--with playback` seeds the playback DBs (== the old --with-playback); `--with qtf` seeds the QTF demo. Bundles with no seed add-on (dash/coach/connect) are a no-op here. NOTE: up.sh treats --with-playback as a launch directive — without --reset/--restart it implies a full stack bring-up (DO_UP), so on a seed-only invocation `--with playback` brings the whole stack up rather than seeding in place. Prefer `stack up --with playback --seed <profile>` when you want the bring-up.",
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(StackSeed);

    // A bundle's seed-axis contribution is its seed add-on (derived from the
    // registry so it cannot drift from `--with`): `--with playback` ⇒ playback,
    // `--with qtf` ⇒ qtf. No legacy `--with-*` booleans on the command surface.
    const addOns: SeedAddOn[] = [...seedAddOnsFor(flags.with)];

    const plan = flagMap.seed({ profile: args.profile as SeedProfile, addOns });
    await this.runScript(plan, flags);
  }
}

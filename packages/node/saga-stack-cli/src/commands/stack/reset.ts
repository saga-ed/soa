/**
 * `saga-stack stack reset` — truncate + re-seed the data DBs (M1 thin wrapper).
 *
 * Maps to `flagMap.reset({ withPlayback })` → `up.sh --reset` (+ `--with-playback`
 * to also truncate the opt-in playback DBs).
 *
 * up.sh's reset always truncates every NON-optional data DB; the only opt-in
 * axis is the playback trio (transcripts/insights/chat, owned by the optional
 * playback services). A bundle's DATA scope here is therefore whether it admits
 * those playback DBs — only `--with playback` does, so `--with playback`
 * reproduces exactly what the old `--with-playback` boolean did. Every other
 * bundle's DBs (coach_api, connectv3, …) are already in the default reset set,
 * so `--with coach`/`connect`/`dash` are harmless no-ops.
 *
 *   node bin/dev.js stack reset
 *   node bin/dev.js stack reset --with playback
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { BUNDLE_NAMES, effectiveWithPlayback } from '../../core/bundles.js';
import * as flagMap from '../../core/flag-map.js';

export default class StackReset extends BaseCommand {
  static description = 'Truncate and re-seed the data DBs (wraps up.sh --reset).';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --with playback',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    with: Flags.string({
      multiple: true,
      options: [...BUNDLE_NAMES],
      description:
        "convenience bundle(s) whose DBs join the reset set — sugar shared with `stack up`. Only `--with playback` changes the set (it also truncates the opt-in playback DBs — transcripts, insights, chat = the old --with-playback); every other bundle's DBs are already reset by default, so `--with coach`/`connect`/`dash` are no-ops. Repeatable: --with playback.",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(StackReset);
    await this.runScript(
      flagMap.reset({ withPlayback: effectiveWithPlayback(flags.with) }),
      flags,
    );
  }
}

/**
 * `saga-stack stack login [email]` — mint a browser session (M1 thin wrapper).
 *
 * Maps to `flagMap.login(email)` → `up.sh --login [email]`: a bare invocation
 * logs in the default persona (dev@saga.org); an email arg overrides it.
 *
 *   node bin/dev.js stack login
 *   node bin/dev.js stack login teacher@saga.org
 */

import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import * as flagMap from '../../core/flag-map.js';

export default class StackLogin extends BaseCommand {
  static description = 'Log in a persona against the running stack (wraps up.sh --login [email]).';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> teacher@saga.org',
  ];

  static args = {
    email: Args.string({
      description: 'persona email to log in (defaults to dev@saga.org)',
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(StackLogin);
    await this.runScript(flagMap.login(args.email), flags);
  }
}

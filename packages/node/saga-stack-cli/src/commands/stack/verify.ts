/**
 * `saga-stack stack verify` — run the end-to-end verification suite (M1 thin
 * wrapper).
 *
 * Maps to `flagMap.verify({ healthOnly, tolerate })` → `verify.sh`. verify.sh
 * takes NO argv; its only mode knob is the `VERIFY_HEALTH_ONLY=1` env gate, so
 * `--health-only` becomes env, not args.
 *
 * `--tolerate` has no verify.sh antecedent (verify.sh is purely env-driven and
 * accepts no argv), so the mapper throws `FlagNotAvailableError` — we surface
 * its message as a friendly oclif error. It lands when verify is re-implemented
 * natively (M2).
 *
 *   node bin/dev.js stack verify
 *   node bin/dev.js stack verify --health-only
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import * as flagMap from '../../core/flag-map.js';
import { FlagNotAvailableError } from '../../core/flag-map.js';

export default class StackVerify extends BaseCommand {
  static description = 'Run the verification suite (wraps verify.sh).';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --health-only',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    'health-only': Flags.boolean({
      description: 'fast health gate only (verify.sh env VERIFY_HEALTH_ONLY=1)',
      default: false,
    }),
    tolerate: Flags.string({
      description: 'tolerate the named non-fatal failures (M2 — not yet supported)',
      multiple: true,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(StackVerify);

    let plan;
    try {
      plan = flagMap.verify({
        healthOnly: flags['health-only'],
        tolerate: flags.tolerate,
      });
    } catch (err) {
      if (err instanceof FlagNotAvailableError) this.error(err.message);
      throw err;
    }

    await this.runScript(plan, flags);
  }
}

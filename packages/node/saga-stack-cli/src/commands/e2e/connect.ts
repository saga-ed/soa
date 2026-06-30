/**
 * `saga-stack e2e connect` — open a LIVE interactive Connect tutoring session
 * (M2 thin wrapper over connect-session.sh).
 *
 * Maps to `e2eMap.e2eConnect()` → connect-session.sh: builds the journey
 * end-state (reset + seed through stage 5) then opens the headed Playwright
 * harness driving 1 tutor + 2 students into a live Connect room. The 3 windows
 * stay open at the end (page.pause). FOREGROUND: stdio is inherited so the hold
 * owns the user's TTY (needs connect-web :6210 + the AV stack + a real mic/cam).
 *
 * `--reuse` skips the rebuild and runs against the current stack state; anything
 * after `--` passes straight through to Playwright (e.g. --debug, --timeout=0).
 *
 *   node bin/dev.js e2e connect
 *   node bin/dev.js e2e connect --reuse -- --debug
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import * as e2eMap from '../../core/e2e-map.js';

export default class E2eConnect extends BaseCommand {
  static description =
    'Open a live interactive Connect session: 1 tutor + 2 students (wraps connect-session.sh; foreground).';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --reuse -- --debug',
  ];

  // Allow trailing playwright passthrough args (after `--`).
  static strict = false;

  static flags = {
    ...BaseCommand.baseFlags,
    reuse: Flags.boolean({
      description: 'skip the rebuild; run the live session against the current stack state',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(E2eConnect);

    const plan = e2eMap.e2eConnect({
      reuse: flags.reuse,
      passthrough: argv as string[],
    });

    await this.runScript(plan, flags);
  }
}

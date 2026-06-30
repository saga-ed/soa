/**
 * `saga-stack e2e run` — run the saga-dash journey e2e pipeline (M2 thin wrapper
 * over check-e2e.sh).
 *
 * Maps flags → `e2eMap.e2eRun()` → check-e2e.sh, which runs the journey THROUGH
 * a phase (Playwright projects chained via `dependencies`, so phase N runs 1..N
 * against a freshly reset stack) and delegates to run-stack-e2e.sh. FOREGROUND BY
 * DEFAULT: the test browser is headed and an inspect browser opens afterwards;
 * stdio is inherited so those holds own the user's TTY.
 *
 * `--phase`/`--through` pick the terminal phase; the lifecycle knobs (`--skip-
 * reset`, `--inspect`/`--no-inspect`, `--pause-at-end`, `--inspect-user`) become
 * the env check-e2e.sh forwards to run-stack-e2e.sh. Anything after `--` passes
 * straight through to Playwright.
 *
 * M2 SCOPE: this is the STACK-lane journey. The deployed sandbox lane and the
 * native flow/phase registry land at M5 (plan §3.2 / §7.2).
 *
 *   node bin/dev.js e2e run --phase 2 --headless
 *   node bin/dev.js e2e run --skip-reset -- --debug
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import * as e2eMap from '../../core/e2e-map.js';

export default class E2eRun extends BaseCommand {
  static description =
    'Run the saga-dash journey e2e pipeline through a phase (wraps check-e2e.sh; foreground by default).';

  static examples = [
    '<%= config.bin %> <%= command.id %> --phase 2 --headless',
    '<%= config.bin %> <%= command.id %> --skip-reset -- --debug',
  ];

  // Allow trailing playwright passthrough args (after `--`).
  static strict = false;

  static flags = {
    ...BaseCommand.baseFlags,
    phase: Flags.string({
      description: 'run the journey THROUGH this phase (name or number; earlier phases run first)',
    }),
    through: Flags.string({
      description: 'alias of --phase (run the journey through this phase)',
    }),
    headless: Flags.boolean({
      description: 'CI-style run: no browser windows (default is headed/foreground)',
      default: false,
    }),
    'skip-reset': Flags.boolean({
      description: 'reuse the current stack state; skip the up.sh reset+seed (env SKIP_RESET=1)',
      default: false,
    }),
    inspect: Flags.boolean({
      description: 'after the suite, open a logged-in browser on the built state (env INSPECT=1)',
      default: false,
    }),
    'no-inspect': Flags.boolean({
      description: 'stay headed but skip the post-suite inspect browser (env INSPECT=0)',
      default: false,
    }),
    'pause-at-end': Flags.boolean({
      description: 'pause inside each test at its final state (Playwright Inspector; env PAUSE_AT_END=1)',
      default: false,
    }),
    'inspect-user': Flags.string({
      description: 'persona for the inspect browser (env INSPECT_USER; default empty@saga.org)',
    }),
  };

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(E2eRun);

    if (flags.inspect && flags['no-inspect']) {
      this.error('--inspect and --no-inspect are mutually exclusive.');
    }

    const plan = e2eMap.e2eRun({
      phase: flags.phase ?? flags.through,
      headless: flags.headless,
      skipReset: flags['skip-reset'],
      inspect: flags.inspect,
      noInspect: flags['no-inspect'],
      pauseAtEnd: flags['pause-at-end'],
      inspectUser: flags['inspect-user'],
      passthrough: argv as string[],
    });

    await this.runScript(plan, flags);
  }
}

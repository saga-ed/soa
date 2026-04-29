/**
 * pgm:seed-from-prod-mirror — thin spawn-and-relay shell.
 *
 * Composite logic (extract programs_rules → transform → load via
 * programs-api/seed-mode) lives in `@saga-ed/pgm-seed`'s
 * `seed-from-prod-mirror` subcommand inside the program-hub repo. This
 * wrapper spawns the bin with that subcommand and relays exit + output.
 *
 * After the child exits 0, the CLI records a CommandInfo via
 * snapshot.registry.addCommand on programs-api so snapshot:show /
 * snapshot:list can surface the run in the fixture's history.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { fixtureIdFlag } from '../../shared-flags.js';
import { resolvePgmSeedBin } from '../../lib/pgm-seed-bin.js';
import { recordCommand, sanitizeArgs } from '../../lib/registry.js';

export default class PgmSeedFromProdMirror extends BaseCommand {
  static description =
    'Seed programs + tutoring periods + enrollments from prod-mirror (delegates to pgm-seed).';

  static flags = {
    ...BaseCommand.baseFlags,
    'fixture-id': fixtureIdFlag,
    source: Flags.string({
      description: 'prod-mirror or source label (informational)',
      default: 'prod-mirror',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(PgmSeedFromProdMirror);
    const binPath = resolvePgmSeedBin();
    if (!existsSync(binPath)) {
      this.logToStderr(
        `pgm-seed binary not found at ${binPath}. ` +
          'Build the package (cd ~/dev/program-hub/packages/node/pgm-seed && pnpm build) ' +
          'or set PGM_SEED_BIN to override.',
      );
      this.exit(2);
    }

    const args = [
      binPath,
      'seed-from-prod-mirror',
      '--fixture-id',
      flags['fixture-id'],
      '--source',
      flags.source,
    ];
    if (flags.porcelain) args.push('--porcelain');
    if (flags['output-json']) args.push('--output-json');

    const exitCode = await new Promise<number>((resolvePromise) => {
      const child = spawn('node', args, {
        stdio: ['inherit', 'inherit', 'inherit'],
        env: { ...process.env },
      });
      child.on('exit', (code) => resolvePromise(code ?? 1));
      child.on('error', (err) => {
        this.logToStderr(`pgm-seed failed to start: ${err.message}`);
        resolvePromise(1);
      });
    });

    if (exitCode !== 0) {
      this.exit(exitCode);
    }

    await recordCommand(
      'pgm:seed-from-prod-mirror',
      flags['fixture-id'],
      sanitizeArgs(flags),
      flags,
    );
  }
}

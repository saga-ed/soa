/**
 * iam:seed-from-prod-mirror — thin spawn-and-relay shell.
 *
 * Composite logic (extract → de-identify → transform → load) lives in
 * `@saga-ed/iam-seed` inside the rostering repo. This command is a
 * lightweight wrapper that spawns the iam-seed binary and relays its
 * exit + output, mirroring ads/seed-attendance.ts.
 *
 * After the child exits 0, the CLI records a CommandInfo via
 * fixture.registry.addCommand on iam-api so fixture:show / fixture:list
 * can surface the run in the fixture's history.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { fixtureIdFlag } from '../../shared-flags.js';
import { resolveIamSeedBin } from '../../lib/iam-seed-bin.js';
import { recordCommand, sanitizeArgs } from '../../lib/registry.js';

export default class IamSeedFromProdMirror extends BaseCommand {
  static description =
    'Seed iam_local + iam_pii_local from prod-mirror (delegates to iam-seed).';

  static flags = {
    ...BaseCommand.baseFlags,
    'fixture-id': fixtureIdFlag,
    source: Flags.string({
      description: 'prod-mirror or path to a pre-extracted JSON dump',
      default: 'prod-mirror',
    }),
    limit: Flags.integer({
      description: 'cap on user count extracted (debugging only)',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IamSeedFromProdMirror);
    const binPath = resolveIamSeedBin();
    if (!existsSync(binPath)) {
      this.logToStderr(
        `iam-seed binary not found at ${binPath}. ` +
          'Build the package (cd ~/dev/rostering/packages/node/iam-seed && pnpm build) ' +
          'or set IAM_SEED_BIN to override.',
      );
      this.exit(2);
    }

    const args = [binPath, '--fixture-id', flags['fixture-id'], '--source', flags.source];
    if (flags.limit !== undefined) args.push('--limit', String(flags.limit));
    if (flags.porcelain) args.push('--porcelain');
    if (flags['output-json']) args.push('--output-json');

    const exitCode = await new Promise<number>((resolvePromise) => {
      const child = spawn('node', args, {
        stdio: ['inherit', 'inherit', 'inherit'],
        env: { ...process.env },
      });
      child.on('exit', (code) => resolvePromise(code ?? 1));
      child.on('error', (err) => {
        this.logToStderr(`iam-seed failed to start: ${err.message}`);
        resolvePromise(1);
      });
    });

    if (exitCode !== 0) {
      this.exit(exitCode);
    }

    await recordCommand(
      'iam:seed-from-prod-mirror',
      flags['fixture-id'],
      sanitizeArgs(flags),
      flags,
    );
  }
}

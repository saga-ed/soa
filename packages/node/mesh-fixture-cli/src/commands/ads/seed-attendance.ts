/**
 * ads:seed-attendance — thin spawn-and-relay shell.
 *
 * Per the architecture pattern audit (claude/projects/sds_80/phase-3/
 * architecture-pattern-audit.md) and D3.6 Phase B decisions
 * (claude/projects/sds_80/decisions/d3.6-phase-b-transform.md §Decision 3c):
 * the heavy lifting (prod-mirror extract, de-identify, transform, load)
 * lives in `@saga-ed/ads-adm-seed` inside the sds-fixture repo. This command
 * is just a lightweight wrapper that spawns the sds-fixture binary and
 * relays its exit + output.
 *
 * After the child process exits 0, the CLI records a CommandInfo via
 * snapshot.registry.addCommand on ads-adm-api so snapshot:show / snapshot:list
 * can surface the run in the fixture's history.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { fixtureIdFlag } from '../../shared-flags.js';
import { recordCommand, sanitizeArgs } from '../../lib/registry.js';

const DEFAULT_ADS_SEED_BIN = resolve(
  homedir(),
  'dev/sds-fixture/packages/node/ads-adm-seed/dist/bin/ads-adm-seed.js',
);

export default class AdsSeedAttendance extends BaseCommand {
  static description =
    'Seed ADS/ADM attendance rows from prod-mirror (delegates to ads-adm-seed).';

  static flags = {
    ...BaseCommand.baseFlags,
    'fixture-id': fixtureIdFlag,
    source: Flags.string({
      description: 'prod-mirror or path to a pre-extracted JSON dump',
      default: 'prod-mirror',
    }),
    limit: Flags.integer({
      description: 'cap on adm_attendance rows extracted (for smoke tests)',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AdsSeedAttendance);
    const binPath = process.env.ADS_ADM_SEED_BIN ?? DEFAULT_ADS_SEED_BIN;
    if (!existsSync(binPath)) {
      this.logToStderr(
        `ads-adm-seed binary not found at ${binPath}. ` +
          'Build the package (cd ~/dev/sds-fixture/packages/node/ads-adm-seed && pnpm build) ' +
          'or set ADS_ADM_SEED_BIN to override.',
      );
      this.exit(2);
    }

    const args = [binPath, '--fixture-id', flags['fixture-id'], '--source', flags.source];
    if (flags.limit !== undefined) args.push('--limit', String(flags.limit));
    if (flags.porcelain) args.push('--porcelain');
    if (flags['output-json']) args.push('--output-json');

    // Pass ads-adm-url through as ADS_ADM_DATABASE_URL when the user hasn't
    // set it — the child needs a postgres URL, which the CLI already knows
    // about indirectly. Not load-bearing in practice (the mesh .env has
    // ADS_ADM_DATABASE_URL set) but keeps the command self-contained.
    const childEnv = { ...process.env };
    // ads-adm-url carries the HTTP service URL, not the DB URL; don't
    // silently map them. Leave DB-URL resolution to the child's own env.

    const exitCode = await new Promise<number>((resolvePromise) => {
      const child = spawn('node', args, {
        stdio: ['inherit', 'inherit', 'inherit'],
        env: childEnv,
      });
      child.on('exit', (code) => resolvePromise(code ?? 1));
      child.on('error', (err) => {
        this.logToStderr(`ads-adm-seed failed to start: ${err.message}`);
        resolvePromise(1);
      });
    });

    if (exitCode !== 0) {
      this.exit(exitCode);
    }

    // Only record the fixture-registry command on success. Registry writes
    // are best-effort — recordCommand logs + swallows failures.
    await recordCommand(
      'ads:seed-attendance',
      flags['fixture-id'],
      sanitizeArgs(flags),
      flags,
    );
  }
}

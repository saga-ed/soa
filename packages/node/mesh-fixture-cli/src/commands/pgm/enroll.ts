/**
 * pgm:enroll — thin spawn-and-relay shell.
 *
 * Per the architecture pattern audit (claude/projects/sds_80/phase-3/
 * architecture-pattern-audit.md) and D3.8: the composite enrollment logic
 * lives in `@saga-ed/pgm-seed` inside the program-hub repo. This command
 * is a lightweight wrapper that spawns the pgm-seed binary and relays its
 * exit + output.
 *
 * After the child exits 0, the CLI records a CommandInfo via
 * fixture.registry.addCommand + appendArtifact on programs-api so
 * snapshot:show / snapshot:list surface the run in the fixture's history.
 * Registry writes stay the CLI's job — per architecture audit — so the
 * child doesn't need cross-service awareness.
 */

import { existsSync } from 'node:fs';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { asFlag, fixtureIdFlag, sourceFlag } from '../../shared-flags.js';
import { TrpcClient } from '../../lib/http.js';
import { resolveGroupId } from '../../iam-helpers.js';
import { appendArtifact, recordCommand, sanitizeArgs } from '../../lib/registry.js';
import {
  resolvePgmSeedBin,
  spawnPgmSeed,
  extractUuidFromStdout,
} from '../../lib/pgm-seed-bin.js';

export default class PgmEnroll extends BaseCommand {
  static description =
    'Set program enrollment (school + section). Upsert — safe to re-run. Delegates to pgm-seed.';

  static flags = {
    ...BaseCommand.baseFlags,
    'fixture-id': fixtureIdFlag,
    program: Flags.string({
      description: 'program name or UUID',
      required: true,
    }),
    school: Flags.string({
      description: 'school group slug or UUID',
      required: true,
    }),
    section: Flags.string({
      description: 'section group slug or UUID (enrolled students)',
      required: true,
    }),
    org: Flags.string({
      description: 'district org (for x-organization-id + program name lookup)',
      required: true,
    }),
    period: Flags.string({
      description: 'also assign section to this period (optional)',
    }),
    source: sourceFlag,
    as: asFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(PgmEnroll);
    const binPath = resolvePgmSeedBin();
    if (!existsSync(binPath)) {
      this.logToStderr(
        `pgm-seed binary not found at ${binPath}. ` +
          'Build the package (cd ~/dev/program-hub/packages/node/pgm-seed && pnpm build) ' +
          'or set PGM_SEED_BIN to override.',
      );
      this.exit(2);
    }

    const args: string[] = ['enroll',
      '--fixture-id', flags['fixture-id'],
      '--program', flags.program,
      '--school', flags.school,
      '--section', flags.section,
      '--org', flags.org,
      '--source', flags.source,
      '--as', flags.as,
      '--iam-url', flags['iam-url'],
      '--programs-url', flags['programs-url'],
    ];
    if (flags.period) args.push('--period', flags.period);
    if (flags.porcelain) args.push('--porcelain');
    if (flags['output-json']) args.push('--output-json');

    const { exitCode, stdout } = await spawnPgmSeed(binPath, args);
    if (exitCode !== 0) {
      this.exit(exitCode);
    }

    // Re-resolve school+section to UUIDs for the artifact key (keeps the
    // registry shape identical to pre-D3.8: <programUuid>:<schoolUuid>:<sectionUuid>).
    // programId is captured from the child's stdout; short-circuits when
    // flags.program was already a UUID. Fall back to flags.program when
    // nothing matched the UUID pattern (shouldn't happen in practice).
    const iamClient = new TrpcClient({ baseUrl: flags['iam-url'] });
    const [schoolId, sectionId] = await Promise.all([
      resolveGroupId(iamClient, flags.source, flags.school),
      resolveGroupId(iamClient, flags.source, flags.section),
    ]);
    const programId = extractUuidFromStdout(stdout, 'programId') ?? flags.program;

    await appendArtifact(
      'pgm:enroll',
      flags['fixture-id'],
      'enrollments',
      `${programId}:${schoolId}:${sectionId}`,
      flags,
    );
    await recordCommand('pgm:enroll', flags['fixture-id'], sanitizeArgs(flags), flags);
  }
}

/**
 * pgm:enroll — set program enrollment (school + section). Uses upsert-shaped
 * enrollment.setProgramEnrollment so repeat runs are safe. Optional --period
 * also applies enrollment.setPeriodAssignments.
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { asFlag, fixtureIdFlag, sourceFlag } from '../../shared-flags.js';
import { TrpcClient } from '../../lib/http.js';
import { devLogin } from '../../lib/auth.js';
import { looksLikeUuid, resolveGroupId } from '../../iam-helpers.js';
import { appendArtifact, recordCommand, sanitizeArgs } from '../../lib/registry.js';

interface Program {
  id: string;
  name: string;
  organizationId: string;
}

interface Period {
  id: string;
  name: string;
  programId: string;
}

export default class PgmEnroll extends BaseCommand {
  static description =
    'Set program enrollment (school + section). Upsert-shaped — safe to re-run.';

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

    const iamClient = new TrpcClient({ baseUrl: flags['iam-url'] });
    const [orgId, schoolId, sectionId] = await Promise.all([
      resolveGroupId(iamClient, flags.source, flags.org),
      resolveGroupId(iamClient, flags.source, flags.school),
      resolveGroupId(iamClient, flags.source, flags.section),
    ]);
    const { cookie } = await devLogin(flags['iam-url'], flags.as);
    const programsClient = new TrpcClient({
      baseUrl: flags['programs-url'],
      cookie,
      headers: { 'x-organization-id': orgId },
    });

    let programId: string;
    if (looksLikeUuid(flags.program)) {
      programId = flags.program;
    } else {
      const resp = await programsClient.query<{ programs: Program[] }>(
        'programs.list',
        { page: 1, limit: 200 },
      );
      const p = resp.programs.find((x) => x.name === flags.program);
      if (!p) throw new Error(`program '${flags.program}' not found.`);
      programId = p.id;
    }

    // setProgramEnrollment is upsert-shaped — safe to call repeatedly.
    // Uses only-include + all-except (per demo-small spec) so just the
    // named section is enrolled with every one of its students.
    await programsClient.mutation('enrollment.setProgramEnrollment', {
      programId,
      schools: [
        {
          schoolGroupId: schoolId,
          enrolled: true,
          childPolicy: 'only-include',
          sectionEnrollments: [
            { sectionGroupId: sectionId, studentPolicy: 'all-except' },
          ],
        },
      ],
    });

    if (flags.period) {
      let periodId: string;
      if (looksLikeUuid(flags.period)) {
        periodId = flags.period;
      } else {
        const periods = await programsClient.query<Period[]>('periods.list', {
          programId,
        });
        const p = periods.find((x) => x.name === flags.period);
        if (!p) throw new Error(`period '${flags.period}' not found on program.`);
        periodId = p.id;
      }
      await programsClient.mutation('enrollment.setPeriodAssignments', {
        programId,
        assignments: [{ sectionGroupId: sectionId, periodId, action: 'add' }],
      });
    }

    this.emit(
      flags,
      { programId, schoolId, sectionId, period: flags.period ?? null, dedup: 'upsert' },
      `  ok     enroll program=${programId.slice(0, 8)}... school=${flags.school} section=${flags.section}`,
    );
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

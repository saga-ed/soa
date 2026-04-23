/**
 * pgm:* — program-hub programs-api seed commands.
 *
 * Each command is idempotent:
 *   pgm:create-program  — dedup by (organizationId, name) via programs.listByOrg (or similar)
 *   pgm:create-period   — dedup by (programId, name) via periods.listByProgram
 *   pgm:enroll          — uses enrollment.setProgramEnrollment which is upsert-shaped by design
 *
 * Resolves iam group slugs to UUIDs via iam-api's groups.findBySourceBulk
 * so callers pass stable slugs ('demo-small-org', 'demo-small-scholars')
 * rather than the dynamic UUIDs rostering assigned.
 *
 * Auth: programs-api resolves userId by exchanging the `iam_session` cookie
 * with iam-api. We devLogin against iam-api as --as <email> (default:
 * demo-tutor@fixture.test) and carry the cookie on all programs-api calls.
 * An `x-organization-id` header is also required — we resolve that from
 * --org.
 */

import type { Command } from 'commander';
import { TrpcClient, TrpcCallError } from '../lib/http.js';
import { devLogin } from '../lib/auth.js';

const DEFAULT_ADMIN_EMAIL =
  process.env.SAGA_MESH_ADMIN_EMAIL ?? 'demo-tutor@fixture.test';
const DEFAULT_SOURCE = 'demo';

interface GlobalOpts {
  iamUrl: string;
  programsUrl: string;
  adsAdmUrl: string;
  porcelain: boolean;
  outputJson: boolean;
}

interface Group {
  id: string;
  sourceId: string | null;
}

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

async function resolveGroupId(
  iamClient: TrpcClient,
  source: string,
  sourceIdOrUuid: string,
): Promise<string> {
  if (/^[0-9a-f]{8}-/.test(sourceIdOrUuid)) return sourceIdOrUuid;
  const groups = await iamClient.query<Group[]>('groups.findBySourceBulk', {
    source,
    sourceIds: [sourceIdOrUuid],
  });
  const match = groups.find((g) => g.sourceId === sourceIdOrUuid);
  if (!match) {
    throw new Error(
      `group with source='${source}' sourceId='${sourceIdOrUuid}' not found (have you run iam:create-org?)`,
    );
  }
  return match.id;
}

function logJsonOrText(
  outputJson: boolean,
  porcelain: boolean,
  json: object,
  text: string,
): void {
  if (outputJson) {
    console.log(JSON.stringify(json, null, 2));
  } else if (porcelain) {
    for (const [k, v] of Object.entries(json)) console.log(`${k}=${v as string}`);
  } else {
    console.log(text);
  }
}

export function registerPgmCommands(program: Command): void {
  const pgm = program
    .command('pgm')
    .description('program-hub seed commands.');

  pgm
    .command('create-program')
    .description('Create a program — dedup by (organizationId, name).')
    .requiredOption('--fixture-id <id>', 'fixture identifier')
    .requiredOption('--name <name>', 'program name')
    .requiredOption('--org <slug-or-uuid>', 'district group slug or UUID')
    .option('--timezone <tz>', 'IANA timezone', 'America/Los_Angeles')
    .option('--street <addr>', 'street address', '100 Demo Lane')
    .option('--city <city>', 'city', 'Demo City')
    .option('--state <state>', 'state', 'CA')
    .option('--zip <zip>', 'zip', '94000')
    .option('--source <source>', 'source namespace for iam slug lookup', DEFAULT_SOURCE)
    .option('--as <email>', 'fixture-admin email for devLogin', DEFAULT_ADMIN_EMAIL)
    .action(async (opts, cmd) => {
      const { iamUrl, programsUrl, porcelain, outputJson } =
        cmd.optsWithGlobals<GlobalOpts>();

      const iamClient = new TrpcClient({ baseUrl: iamUrl });
      const orgId = await resolveGroupId(iamClient, opts.source, opts.org);
      const { cookie } = await devLogin(iamUrl, opts.as);

      // Dedup: list programs for this org, match by name.
      const programsClient = new TrpcClient({
        baseUrl: programsUrl,
        cookie,
        headers: { 'x-organization-id': orgId },
      });
      // programs.list is paged + wrapped: { programs: [...], total, page, limit }.
      // We pull a large first page rather than walk pages — seed volumes are small.
      let existing: Program | null = null;
      try {
        const resp = await programsClient.query<{ programs: Program[] }>(
          'programs.list',
          { page: 1, limit: 200 },
        );
        existing = resp.programs.find((p) => p.name === opts.name) ?? null;
      } catch (err) {
        // If programs.list is unavailable, fall through — a duplicate-name
        // create will throw, which we can treat as hit.
        if (!(err instanceof TrpcCallError && err.status === 404)) throw err;
      }
      if (existing) {
        logJsonOrText(
          outputJson,
          porcelain,
          { programId: existing.id, name: existing.name, dedup: 'hit' },
          `  hit    program/${opts.name} → ${existing.id}`,
        );
        return;
      }

      const created = await programsClient.mutation<Program>('programs.create', {
        name: opts.name,
        timezone: opts.timezone,
        streetAddress: opts.street,
        city: opts.city,
        state: opts.state,
        zip: opts.zip,
      });
      logJsonOrText(
        outputJson,
        porcelain,
        { programId: created.id, name: created.name, dedup: 'miss' },
        `  new    program/${opts.name} → ${created.id}`,
      );
    });

  pgm
    .command('create-period')
    .description('Create a period on a program — dedup by (programId, name).')
    .requiredOption('--fixture-id <id>', 'fixture identifier')
    .requiredOption('--program <name-or-uuid>', 'program name or UUID')
    .requiredOption('--name <name>', 'period name')
    .option('--sort-order <n>', 'sort order', '0')
    .option('--color-key <color>', 'color key', 'blue')
    .requiredOption('--org <slug-or-uuid>', 'org slug or UUID (for program-name lookup + x-organization-id)')
    .option('--source <source>', 'source namespace for iam slug lookup', DEFAULT_SOURCE)
    .option('--as <email>', 'fixture-admin email for devLogin', DEFAULT_ADMIN_EMAIL)
    .action(async (opts, cmd) => {
      const { iamUrl, programsUrl, porcelain, outputJson } =
        cmd.optsWithGlobals<GlobalOpts>();

      const iamClient = new TrpcClient({ baseUrl: iamUrl });
      const orgId = await resolveGroupId(iamClient, opts.source, opts.org);
      const { cookie } = await devLogin(iamUrl, opts.as);
      const programsClient = new TrpcClient({
        baseUrl: programsUrl,
        cookie,
        headers: { 'x-organization-id': orgId },
      });

      // Resolve programId via programs.list + name match (if arg isn't a UUID).
      let programId: string;
      if (/^[0-9a-f]{8}-/.test(opts.program)) {
        programId = opts.program;
      } else {
        const resp = await programsClient.query<{ programs: Program[] }>(
          'programs.list',
          { page: 1, limit: 200 },
        );
        const p = resp.programs.find((x) => x.name === opts.program);
        if (!p) throw new Error(`program with name='${opts.program}' not found for org.`);
        programId = p.id;
      }

      // Dedup: list existing periods on this program and match by name.
      // periods.list returns a direct array (not paged).
      let existing: Period | null = null;
      try {
        const periods = await programsClient.query<Period[]>('periods.list', {
          programId,
        });
        existing = periods.find((p) => p.name === opts.name) ?? null;
      } catch {
        // Fall through — create will either succeed or duplicate-error which
        // we'd treat as hit.
      }
      if (existing) {
        logJsonOrText(
          outputJson,
          porcelain,
          { periodId: existing.id, name: existing.name, dedup: 'hit' },
          `  hit    period/${opts.name} → ${existing.id}`,
        );
        return;
      }

      const created = await programsClient.mutation<Period>('periods.create', {
        programId,
        name: opts.name,
        sortOrder: Number.parseInt(opts.sortOrder, 10),
        colorKey: opts.colorKey,
      });
      logJsonOrText(
        outputJson,
        porcelain,
        { periodId: created.id, name: created.name, dedup: 'miss' },
        `  new    period/${opts.name} → ${created.id}`,
      );
    });

  pgm
    .command('enroll')
    .description('Set program enrollment (school + section). Upsert-shaped — safe to re-run.')
    .requiredOption('--fixture-id <id>', 'fixture identifier')
    .requiredOption('--program <name-or-uuid>', 'program name or UUID')
    .requiredOption('--school <slug-or-uuid>', 'school group slug or UUID')
    .requiredOption('--section <slug-or-uuid>', 'section group slug or UUID (enrolled students)')
    .requiredOption('--org <slug-or-uuid>', 'district org (for x-organization-id + program name lookup)')
    .option('--period <name-or-uuid>', 'also assign section to this period (optional)')
    .option('--source <source>', 'source namespace for iam slug lookup', DEFAULT_SOURCE)
    .option('--as <email>', 'fixture-admin email for devLogin', DEFAULT_ADMIN_EMAIL)
    .action(async (opts, cmd) => {
      const { iamUrl, programsUrl, porcelain, outputJson } =
        cmd.optsWithGlobals<GlobalOpts>();

      const iamClient = new TrpcClient({ baseUrl: iamUrl });
      const [orgId, schoolId, sectionId] = await Promise.all([
        resolveGroupId(iamClient, opts.source, opts.org),
        resolveGroupId(iamClient, opts.source, opts.school),
        resolveGroupId(iamClient, opts.source, opts.section),
      ]);
      const { cookie } = await devLogin(iamUrl, opts.as);
      const programsClient = new TrpcClient({
        baseUrl: programsUrl,
        cookie,
        headers: { 'x-organization-id': orgId },
      });

      let programId: string;
      if (/^[0-9a-f]{8}-/.test(opts.program)) {
        programId = opts.program;
      } else {
        const resp = await programsClient.query<{ programs: Program[] }>(
          'programs.list',
          { page: 1, limit: 200 },
        );
        const p = resp.programs.find((x) => x.name === opts.program);
        if (!p) throw new Error(`program '${opts.program}' not found.`);
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

      // Optional: assign the section to a specific period.
      if (opts.period) {
        let periodId: string;
        if (/^[0-9a-f]{8}-/.test(opts.period)) {
          periodId = opts.period;
        } else {
          const periods = await programsClient.query<Period[]>('periods.list', {
            programId,
          });
          const p = periods.find((x) => x.name === opts.period);
          if (!p) throw new Error(`period '${opts.period}' not found on program.`);
          periodId = p.id;
        }
        await programsClient.mutation('enrollment.setPeriodAssignments', {
          programId,
          assignments: [{ sectionGroupId: sectionId, periodId, action: 'add' }],
        });
      }

      logJsonOrText(
        outputJson,
        porcelain,
        { programId, schoolId, sectionId, period: opts.period ?? null, dedup: 'upsert' },
        `  ok     enroll program=${programId.slice(0, 8)}... school=${opts.school} section=${opts.section}`,
      );
    });
}

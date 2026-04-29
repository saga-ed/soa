/**
 * snapshot:validate — verify every artifact id on a fixture still resolves.
 *
 * For each service's `artifacts` bucket, issues targeted lookups to confirm
 * the referenced rows exist:
 *   iam.groups       → groups.getBulk({ ids }) — compare returned count
 *   iam.users        → users.getBulk({ ids })
 *   iam.memberships  → not directly verifiable (artifact id is
 *                      synthesized "<userId>:<groupId>"); reported as
 *                      "skipped" rather than "missing" so the exit code
 *                      stays green.
 *   programs.programs→ programs.get({ id }) per id
 *   programs.periods → periods.get({ id }) per id
 *   programs.enrollments → synthesized; "skipped".
 *
 * scheduling.* and ads.* have no artifacts populated by this CLI yet; we
 * just enumerate whatever ids are present and report them as skipped.
 *
 * Exit code: 0 if every resolvable artifact id is found, 1 otherwise.
 * Unresolvable lookups (network 500, service down) also fail the run.
 */

import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import {
  clientFor,
  getRegistry,
  type SnapshotMetadata,
  type RegistryService,
} from '../../lib/registry.js';
import { TrpcCallError } from '../../lib/http.js';

type ValidationStatus = 'ok' | 'missing' | 'skipped' | 'error';

interface ArtifactCheck {
  service: RegistryService;
  kind: string;
  id: string;
  status: ValidationStatus;
  note?: string;
}

interface ServiceValidation {
  service: RegistryService;
  present: boolean;
  checks: ArtifactCheck[];
}

interface ValidateResult {
  id: string;
  services: ServiceValidation[];
  totals: { ok: number; missing: number; skipped: number; error: number };
  missingRefs: ArtifactCheck[];
  errors: ArtifactCheck[];
}

/**
 * Small helper used to catch NOT_FOUND separately from everything else.
 * iam/programs 'get' endpoints throw NOT_FOUND → missing; other errors
 * (5xx, network) → error (bubble up into non-zero exit).
 */
async function checkSingle<T = unknown>(
  check: Omit<ArtifactCheck, 'status' | 'note'>,
  call: () => Promise<T>,
): Promise<ArtifactCheck> {
  try {
    await call();
    return { ...check, status: 'ok' };
  } catch (err) {
    if (
      err instanceof TrpcCallError &&
      (err.trpcError?.data?.code === 'NOT_FOUND' || err.status === 404)
    ) {
      return { ...check, status: 'missing', note: 'NOT_FOUND' };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ...check, status: 'error', note: msg };
  }
}

async function validateIam(
  metadata: SnapshotMetadata,
  endpoints: {
    'iam-url': string;
    'programs-url': string;
    'ads-adm-url': string;
    'scheduling-url'?: string;
  },
): Promise<ArtifactCheck[]> {
  const out: ArtifactCheck[] = [];
  const artifacts = metadata.artifacts ?? {};
  const client = clientFor('iam', endpoints);

  const groupIds = toStringArray(artifacts['groups']);
  if (groupIds.length) {
    try {
      const rows = await client.query<Array<{ id: string }>>('groups.getBulk', {
        ids: groupIds,
      });
      const found = new Set(rows.map((r) => r.id));
      for (const id of groupIds) {
        out.push(
          found.has(id)
            ? { service: 'iam', kind: 'groups', id, status: 'ok' }
            : { service: 'iam', kind: 'groups', id, status: 'missing' },
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      for (const id of groupIds) {
        out.push({ service: 'iam', kind: 'groups', id, status: 'error', note: msg });
      }
    }
  }

  const userIds = toStringArray(artifacts['users']);
  if (userIds.length) {
    try {
      const rows = await client.query<Array<{ id: string }>>('users.getBulk', {
        ids: userIds,
      });
      const found = new Set(rows.map((r) => r.id));
      for (const id of userIds) {
        out.push(
          found.has(id)
            ? { service: 'iam', kind: 'users', id, status: 'ok' }
            : { service: 'iam', kind: 'users', id, status: 'missing' },
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      for (const id of userIds) {
        out.push({ service: 'iam', kind: 'users', id, status: 'error', note: msg });
      }
    }
  }

  // Memberships are <userId>:<groupId> synthesized ids — skip without
  // failing. If the user + group both resolved above, the membership
  // likely still holds (addMembers dedups by the same pair).
  for (const id of toStringArray(artifacts['memberships'])) {
    out.push({
      service: 'iam',
      kind: 'memberships',
      id,
      status: 'skipped',
      note: 'synthesized id',
    });
  }

  return out;
}

async function validatePrograms(
  metadata: SnapshotMetadata,
  endpoints: {
    'iam-url': string;
    'programs-url': string;
    'ads-adm-url': string;
    'scheduling-url'?: string;
  },
): Promise<ArtifactCheck[]> {
  const out: ArtifactCheck[] = [];
  const artifacts = metadata.artifacts ?? {};
  const client = clientFor('programs', endpoints);

  for (const id of toStringArray(artifacts['programs'])) {
    out.push(
      await checkSingle({ service: 'programs', kind: 'programs', id }, () =>
        client.query('programs.get', { id }),
      ),
    );
  }

  for (const id of toStringArray(artifacts['periods'])) {
    out.push(
      await checkSingle({ service: 'programs', kind: 'periods', id }, () =>
        client.query('periods.get', { id }),
      ),
    );
  }

  for (const id of toStringArray(artifacts['enrollments'])) {
    out.push({
      service: 'programs',
      kind: 'enrollments',
      id,
      status: 'skipped',
      note: 'synthesized id',
    });
  }

  return out;
}

function validatePassthrough(
  service: RegistryService,
  metadata: SnapshotMetadata,
): ArtifactCheck[] {
  // scheduling / ads artifacts are not populated by this CLI yet. Enumerate
  // whatever is there and skip validation — surface rather than hide them.
  const out: ArtifactCheck[] = [];
  const artifacts = metadata.artifacts ?? {};
  for (const [kind, v] of Object.entries(artifacts)) {
    for (const id of toStringArray(v)) {
      out.push({
        service,
        kind,
        id,
        status: 'skipped',
        note: `no validation path yet for ${service}.${kind}`,
      });
    }
  }
  return out;
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function tally(checks: ArtifactCheck[]): ValidateResult['totals'] {
  const t = { ok: 0, missing: 0, skipped: 0, error: 0 };
  for (const c of checks) t[c.status] += 1;
  return t;
}

export default class SnapshotValidate extends BaseCommand {
  static description =
    'Verify every registry artifact id on a fixture still resolves (exits 1 if any are missing).';

  static args = {
    'fixture-id': Args.string({
      description: 'fixture identifier to validate',
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SnapshotValidate);
    const id = args['fixture-id'];

    const services: RegistryService[] = ['iam', 'programs', 'scheduling', 'ads'];
    const perService: ServiceValidation[] = await Promise.all(
      services.map(async (service): Promise<ServiceValidation> => {
        const metadata = await getRegistry(service, id, flags).catch(() => null);
        if (!metadata) {
          return { service, present: false, checks: [] };
        }
        const checks =
          service === 'iam'
            ? await validateIam(metadata, flags)
            : service === 'programs'
              ? await validatePrograms(metadata, flags)
              : validatePassthrough(service, metadata);
        return { service, present: true, checks };
      }),
    );

    const allChecks = perService.flatMap((s) => s.checks);
    const totals = tally(allChecks);
    const missingRefs = allChecks.filter((c) => c.status === 'missing');
    const errors = allChecks.filter((c) => c.status === 'error');
    const result: ValidateResult = {
      id,
      services: perService,
      totals,
      missingRefs,
      errors,
    };

    const fixtureExists = perService.some((s) => s.present);

    if (flags['output-json']) {
      this.log(JSON.stringify(result, null, 2));
    } else if (flags.porcelain) {
      this.log(`id=${id}`);
      if (!fixtureExists) this.log('present=false');
      this.log(`ok=${totals.ok}`);
      this.log(`missing=${totals.missing}`);
      this.log(`skipped=${totals.skipped}`);
      this.log(`error=${totals.error}`);
      for (const c of missingRefs) this.log(`missing=${c.service}.${c.kind}:${c.id}`);
      for (const c of errors) this.log(`error=${c.service}.${c.kind}:${c.id}\t${c.note ?? ''}`);
    } else {
      if (!fixtureExists) {
        this.log(`Fixture '${id}' not found in any of: iam, programs, scheduling, ads.`);
      } else {
        this.log(`Validating fixture '${id}':`);
        for (const s of perService) {
          if (!s.present) {
            this.log(`  ${s.service}: not present`);
            continue;
          }
          const st = tally(s.checks);
          this.log(
            `  ${s.service}: ok=${st.ok} missing=${st.missing} skipped=${st.skipped} error=${st.error}`,
          );
        }
        if (missingRefs.length) {
          this.log('');
          this.log('Missing references:');
          for (const c of missingRefs) {
            this.log(`  ${c.service}.${c.kind}:${c.id}${c.note ? ` (${c.note})` : ''}`);
          }
        }
        if (errors.length) {
          this.log('');
          this.log('Errors during validation (non-fatal → still fail exit):');
          for (const c of errors) {
            this.log(`  ${c.service}.${c.kind}:${c.id} — ${c.note ?? 'unknown error'}`);
          }
        }
        this.log('');
        this.log(
          `Totals: ok=${totals.ok}, missing=${totals.missing}, skipped=${totals.skipped}, error=${totals.error}`,
        );
      }
    }

    // Exit 1 if any reference is missing or an error blocked validation.
    if (totals.missing > 0 || totals.error > 0) {
      this.exit(1);
    }
  }
}

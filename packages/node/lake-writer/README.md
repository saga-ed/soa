# @saga-ed/soa-lake-writer

Shared library every Saga service uses to export pseudonymised snapshots of
its own data to the SDS FERPA data lake's S3 landing zone. **Library only —
no CLI, no job runner.** Your service owns the transform (reading its own
database, deciding what a "row" is, hashing identifiers); this package owns
the parts that must stay byte-for-byte consistent across every exporter:
HMAC hashing, school-year derivation, the S3 key layout, Parquet writing,
and the dbt/Athena registration text.

It was factored out of code that was copy-pasted across 17 ingest CLIs in
`student-data-system`'s `apps/node/fixtures/src/` — the hashing and S3-key
behaviour here is a byte-for-byte port of that code, because the lake
already holds data produced by it.

## The compound-key invariant

**A bare `user_id` (or any other stable id) does NOT identify a person across
school years. Never hash it alone.** Several Saga databases are dropped and
reseeded at the start of every school year, so the same id can refer to an
unrelated person the next year. The canonical join key across the entire
lake is the compound key `{school_year, stable_external_id}`, materialized
as:

```
student_year_hash = HMAC_SHA256(salt, "{school_year}:{stable_external_id}")
```

Always produce it with [`studentYearHash`](./src/pseudonymise.ts) — never
hand-roll this HMAC. Every other bridge hash in this package
(`namespacedHash`, `recordIdHash`, `districtStudentIdHash`) takes a
namespace prefix instead, precisely so it can never be mistaken for the
compound key.

## Install

```bash
pnpm add @saga-ed/soa-lake-writer
```

## Usage: a minimal exporter script

```ts
import { PrismaClient } from '@prisma/client';
import {
  defineLandingDataset,
  requireStudentYearHash,
  studentYearHash,
  namespacedHash,
  loadSalt,
  runSnapshotExport,
  S3LandingSink,
  LocalLandingSink,
  resolveKmsKeyArn,
  ANALYTICS_KMS_SSM_PATH,
} from '@saga-ed/soa-lake-writer';

type ProgramRow = {
  school_year: string;
  source_system: 'programhub';
  student_year_hash: string;
  program_id_hash: string | null;
  ingest_run_id: string;
  ingested_at: Date;
};

const dataset = requireStudentYearHash(
  defineLandingDataset<ProgramRow>({
    name: 'session_occurrence_programhub',
    dataset: 'session_occurrence',
    sourceSystem: 'programhub',
    columns: [
      { name: 'school_year', type: 'string' },
      { name: 'source_system', type: 'string' },
      { name: 'student_year_hash', type: 'string' },
      { name: 'program_id_hash', type: 'string', optional: true },
      { name: 'ingest_run_id', type: 'string' },
      { name: 'ingested_at', type: 'timestamp' },
    ],
    fingerprint: ['program_id_hash'],
  })
);

async function* rows(prisma: PrismaClient, salt: string, schoolYear: string, runId: string) {
  const ingestedAt = new Date();
  for await (const p of prisma.participant.findMany({ where: { schoolYear } })) {
    yield {
      school_year: schoolYear,
      source_system: 'programhub' as const,
      student_year_hash: studentYearHash(salt, schoolYear, p.userId),
      program_id_hash: namespacedHash(salt, 'ph_program', p.programId),
      ingest_run_id: runId,
      ingested_at: ingestedAt,
    };
  }
}

const isProd = process.env.NODE_ENV === 'production';
const salt = await loadSalt(); // opts.salt / LAKE_SALT / Secrets Manager
const sink = isProd
  ? new S3LandingSink({
      analyticsKmsKeyArn: await resolveKmsKeyArn(ANALYTICS_KMS_SSM_PATH),
    })
  : new LocalLandingSink('./tmp/lake-preview'); // dev/preview: no prod lake access

const prisma = new PrismaClient();
await runSnapshotExport({
  dataset,
  rows: rows(prisma, salt, 'SY25-26', crypto.randomUUID()),
  sink,
});
```

## Shared dataset descriptors

`src/datasets/` ships ready-made `LandingDataset` descriptors for the first
external-source lake exports — column contracts mirrored from
`student-data-system/claude/projects/ledger-prod-lake/phase-4/dataset-catalog.md`
(the catalog is the contract for columns/semantics; this package owns only
the `LandingDataset` mechanics). Import a descriptor and its `Row` type
instead of hand-rolling `defineLandingDataset` for these datasets — that
keeps every exporter's schema, S3 location, and dbt registration text in
lockstep.

| `rosteringDatasets` key          | `programhubDatasets` key            |
| -------------------------------- | ----------------------------------- |
| `iam_group_rostering`            | `program_programhub`                |
| `iam_group_membership_rostering` | `program_school_mapping_programhub` |
| `identity_crosswalk_rostering`   | `program_period_programhub`         |
| `district_sync_config_rostering` | `program_pod_programhub`            |
|                                  | `pod_membership_programhub`         |
|                                  | `session_occurrence_programhub`     |
|                                  | `session_participant_programhub`    |

`externalDatasets` is both merged, keyed by registry name (`${dataset}_${sourceSystem}`).

Mapping a Prisma row to the identity crosswalk — the district-id bridge —
looks like:

```ts
import {
  studentYearHash,
  districtStudentIdHash,
  type IdentityCrosswalkRosteringRow,
} from '@saga-ed/soa-lake-writer';

function toCrosswalkRow(
  user: IamUser,
  districtExternalId: string | null,
  schoolYear: string,
  salt: string,
  runId: string
): IdentityCrosswalkRosteringRow {
  return {
    school_year: schoolYear,
    source_system: 'rostering',
    student_year_hash: studentYearHash(salt, schoolYear, user.id),
    org_id: user.orgId,
    // districtExternalId MUST come from auth_associations.district_external_id
    // (via resolveDistrictExternalId()) — NEVER user_profiles.user_id_label,
    // which is stale-by-construction (rostering#1128).
    district_student_id_hash: districtStudentIdHash(salt, districtExternalId),
    district_student_id_source: user.districtIdSource ?? null,
    district_student_id_available: districtExternalId != null,
    external_user_id_hash: null,
    user_role: user.role,
    user_status: user.status,
    snapshot_at: new Date(),
    ingest_run_id: runId,
    ingested_at: new Date(),
  };
}
```

## The landing-path contract

| Helper                  | Shape                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `curatedLandingKey`     | `landing/<sourceSystem>/<dataset>/school_year=<SY>/run_id=<runId>/data.parquet` (or `part-NNN.parquet`)       |
| `rawEvidenceKey`        | `raw/<sourceSystem>/<dataset>/<schoolYear>/<runId>.json` (or `.../<runId>/part-NNN.json`)                     |
| `runManifestKey`        | `manifests/<sourceSystem>/<dataset>/<runId>.json` — a **separate** top-level prefix, never inside `landing/…` |
| `landingObjectMetadata` | `{ 'sds-ingest-run-id', 'sds-source-system', 'sds-dataset', 'sds-school-year' }` on every uploaded object     |

Curated Parquet goes to `saga-sds-analytics-prod` (`ANALYTICS_BUCKET`); raw
evidence goes to `saga-sds-pii-prod` (`PII_BUCKET`), single-`PutObject` only
— `S3LandingSink.putRaw` never uses multipart, because the writer IAM role
has no `kms:Decrypt` on the PII CMK and multipart's part-reassembly needs
it. Manifests are a separate prefix so a stray non-Parquet file can never
land inside a `landing/…` partition directory an Athena external table
reads wholesale.

## The three registration points

A new landing dataset must be declared in three places in
`student-data-system`'s `infra/sds-secure-analytics/` stack, or the failure
is quiet or confusing (see that repo's `infra/sds-secure-analytics/CLAUDE.md`
for the full rationale):

1. `dbt/models/sources.yml` — the dbt source definition.
2. **This package's dataset registry** — one `defineLandingDataset(...)` call
   (plus `requireStudentYearHash(...)` for fact datasets).
3. `dbt/macros/stage_landing_sources.sql` — a hand-maintained
   `_stage_one(...)` block (the macro does not read `sources.yml`).

`defineLandingDataset` is the single source of truth; use
[`renderDbtSourceTable`](./src/dbt-render.ts) and
[`renderStageOneStanza`](./src/dbt-render.ts) to generate the text for (1)
and (3) directly from it, instead of hand-copying columns across three
files. [`compareRegistryToDbtSources`](./src/drift.ts) (the pure comparison
machinery `drift.ts` exposes) can be wired into a CI check on the consuming
repo to catch drift between (1) and (2) before it reaches Athena.

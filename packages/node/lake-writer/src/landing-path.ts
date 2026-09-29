// S3 key layout for the SDS FERPA data lake. Every writer in this
// package must produce keys through these helpers rather than
// hand-building strings — the layout is read by Athena external tables
// (see infra/sds-secure-analytics/dbt/models/sources.yml and
// dbt/macros/stage_landing_sources.sql in student-data-system) and by
// downstream run-manifest tooling, so drift here is a silent-corruption
// risk, not a cosmetic one.

import { isSchoolYear } from './school-year.js';

export const ANALYTICS_BUCKET = 'saga-sds-analytics-prod';
export const PII_BUCKET = 'saga-sds-pii-prod';
export const ANALYTICS_KMS_SSM_PATH = '/sds/prod/secure-analytics/kms/analytics-key-arn';
export const PII_KMS_SSM_PATH = '/sds/prod/secure-analytics/kms/pii-key-arn';
export const DEFAULT_REGION = 'us-west-2';

/**
 * Every source system permitted to land data in the lake. `salesforce`,
 * `renaissance`, `saga_connect`, and `manual` are the legs that exist
 * today (student-data-system's fixtures CLIs); the rest are reserved for
 * the shared-library consumers this package was factored out for.
 */
export type SourceSystem =
  | 'salesforce'
  | 'renaissance'
  | 'saga_connect'
  | 'manual'
  | 'ledger_api'
  | 'ads_adm'
  | 'surveys'
  | 'programhub'
  | 'rostering';

const DATASET_NAME_RE = /^[a-z][a-z0-9_]*$/;

function assertDatasetName(dataset: string): void {
  if (!DATASET_NAME_RE.test(dataset)) {
    throw new Error(
      `landing-path: dataset name "${dataset}" must match ${DATASET_NAME_RE} ` +
        '(lowercase, starts with a letter, letters/digits/underscore only)'
    );
  }
}

function assertSchoolYear(schoolYear: string): void {
  if (!isSchoolYear(schoolYear)) {
    throw new Error(`landing-path: school_year "${schoolYear}" is not a valid SYxx-yy label`);
  }
}

function partSuffix(part: number | undefined): string {
  if (part == null) return '';
  return `part-${String(part).padStart(3, '0')}`;
}

export interface CuratedLandingKeyArgs {
  sourceSystem: SourceSystem;
  /** Bare dataset name, e.g. `student_identity_xwalk` — NOT the `_app`/`_sf`-suffixed registry key. */
  dataset: string;
  schoolYear: string;
  runId: string;
  /** When set, the file is landed as one part of a multi-file partition. */
  part?: number;
}

/**
 * `landing/<sourceSystem>/<dataset>/school_year=<SY>/run_id=<runId>/data.parquet`
 * (or `part-000.parquet` when `part` is given). This is the curated,
 * Athena-external-table-visible location — only Parquet belongs here.
 */
export function curatedLandingKey(args: CuratedLandingKeyArgs): string {
  const { sourceSystem, dataset, schoolYear, runId, part } = args;
  assertDatasetName(dataset);
  assertSchoolYear(schoolYear);
  const filename = part != null ? `${partSuffix(part)}.parquet` : 'data.parquet';
  return `landing/${sourceSystem}/${dataset}/school_year=${schoolYear}/run_id=${runId}/${filename}`;
}

export interface RawEvidenceKeyArgs {
  sourceSystem: SourceSystem;
  dataset: string;
  schoolYear: string;
  runId: string;
  /** When set, the raw evidence is chunked into numbered parts. */
  chunk?: number;
}

/**
 * `raw/<sourceSystem>/<dataset>/<schoolYear>/<runId>.json` (or,
 * chunked, `raw/<sourceSystem>/<dataset>/<schoolYear>/<runId>/part-000.json`).
 * Lands in the PII bucket — the un-pseudonymised evidence backing a
 * curated export, for audit.
 */
export function rawEvidenceKey(args: RawEvidenceKeyArgs): string {
  const { sourceSystem, dataset, schoolYear, runId, chunk } = args;
  assertDatasetName(dataset);
  assertSchoolYear(schoolYear);
  if (chunk == null) {
    return `raw/${sourceSystem}/${dataset}/${schoolYear}/${runId}.json`;
  }
  return `raw/${sourceSystem}/${dataset}/${schoolYear}/${runId}/${partSuffix(chunk)}.json`;
}

export interface RunManifestKeyArgs {
  sourceSystem: SourceSystem;
  /** Bare dataset name, e.g. `student_identity_xwalk` — same segment `curatedLandingKey`/`rawEvidenceKey` use, NOT the `_<source>`-suffixed registry key. */
  dataset: string;
  runId: string;
}

/**
 * `manifests/<sourceSystem>/<dataset>/<runId>.json`. IMPORTANT: manifests
 * live under a SEPARATE `manifests/` prefix, never inside `landing/…` —
 * Athena external tables read every object under their table location,
 * so a JSON manifest dropped inside a `landing/…` partition directory
 * would corrupt the table (a non-Parquet file under a Hive-partitioned
 * external table location).
 */
export function runManifestKey(args: RunManifestKeyArgs): string {
  const { sourceSystem, dataset, runId } = args;
  assertDatasetName(dataset);
  return `manifests/${sourceSystem}/${dataset}/${runId}.json`;
}

export interface LandingObjectMetadataArgs {
  runId: string;
  sourceSystem: SourceSystem;
  dataset: string;
  schoolYear: string;
}

/**
 * The S3 object metadata every landing/raw upload carries, exactly as
 * the fixtures CLIs set it today (`sds-ingest-run-id`, `sds-source-system`,
 * `sds-dataset`, `sds-school-year`).
 */
export function landingObjectMetadata(args: LandingObjectMetadataArgs): Record<string, string> {
  return {
    'sds-ingest-run-id': args.runId,
    'sds-source-system': args.sourceSystem,
    'sds-dataset': args.dataset,
    'sds-school-year': args.schoolYear,
  };
}

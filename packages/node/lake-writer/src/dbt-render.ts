// The lake requires every landing dataset to be declared in THREE
// places (see infra/sds-secure-analytics/CLAUDE.md's "Adding a landing
// source" section in student-data-system):
//
//   1. dbt/models/sources.yml            — the dbt source definition.
//   2. this package's dataset registry   — the Parquet schema.
//   3. dbt/macros/stage_landing_sources.sql — a hand-maintained
//      `_stage_one(...)` block (the macro does NOT read sources.yml).
//
// This module renders (2) into text for (1) and (3), so a new dataset
// only needs to be declared ONCE (via `defineLandingDataset`) and the
// dbt-side text can be generated rather than hand-copied — eliminating
// the class of drift the fixtures repo's landing-schema-drift.test.ts
// exists to catch after the fact.
//
// Deliberately plain string templating — no yaml dependency, so the
// output is exactly what you'd hand-write and diff cleanly against the
// existing files.

import { ANALYTICS_BUCKET } from './landing-path.js';
import { athenaType, type LandingDataset } from './parquet-writer.js';

function needsYamlQuoting(s: string): boolean {
  return /^[\s'"[{#&*!|>%@`]|[:#]\s|\s$|^$/.test(s) || /: /.test(s);
}

function yamlScalar(s: string): string {
  if (!needsYamlQuoting(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Render the `tables:` entry for one dataset, in the shape
 * `dbt/models/sources.yml`'s `sources: - name: landing` block expects.
 * Splice the returned text directly under that source's `tables:` key.
 * `school_year` is excluded from `columns:` — it's declared under
 * `external.partitions` instead, matching dbt-external-tables'
 * CREATE-TABLE-vs-PARTITIONED-BY split.
 */
export function renderDbtSourceTable<Row>(
  dataset: LandingDataset<Row>,
  opts: { bucket?: string } = {}
): string {
  const bucket = opts.bucket ?? ANALYTICS_BUCKET;
  const location = `s3://${bucket}/landing/${dataset.sourceSystem}/${dataset.dataset}/`;

  const lines: string[] = [];
  lines.push(`      - name: ${dataset.name}`);
  lines.push(`        external:`);
  lines.push(`          location: ${location}`);
  lines.push(`          file_format: parquet`);
  lines.push(`          tbl_properties: "('parquet.compression'='SNAPPY')"`);
  lines.push(`          partitions:`);
  lines.push(`            - name: school_year`);
  lines.push(`              data_type: string`);
  lines.push(`        columns:`);
  for (const col of dataset.columns) {
    if (col.name === 'school_year') continue;
    lines.push(`          - name: ${col.name}`);
    lines.push(`            data_type: ${athenaType(col.type).toLowerCase()}`);
    if (col.description) {
      lines.push(`            description: ${yamlScalar(col.description)}`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * Render the `{{ _stage_one(...) }}` Jinja block for one dataset, in the
 * shape `dbt/macros/stage_landing_sources.sql`'s `stage_landing_sources`
 * macro body expects. `school_year` is excluded from `columns=[...]` —
 * it's supplied separately via `partitions=[('school_year','STRING')]`,
 * matching `_stage_one`'s `PARTITIONED BY` handling.
 */
export function renderStageOneStanza<Row>(
  dataset: LandingDataset<Row>,
  opts: { bucket?: string; landingSchemaVar?: string } = {}
): string {
  const bucket = opts.bucket ?? ANALYTICS_BUCKET;
  const schemaVar = opts.landingSchemaVar ?? 'landing_schema';
  const location = `s3://${bucket}/landing/${dataset.sourceSystem}/${dataset.dataset}/`;

  const colLines = dataset.columns
    .filter(c => c.name !== 'school_year')
    .map(c => `         ('${c.name}', '${athenaType(c.type)}'),`);

  const lines: string[] = [];
  lines.push(`  {{ _stage_one(`);
  lines.push(`       database='awsdatacatalog',`);
  lines.push(`       schema=${schemaVar},`);
  lines.push(`       table='${dataset.name}',`);
  lines.push(`       location='${location}',`);
  lines.push(`       columns=[`);
  lines.push(...colLines);
  lines.push(`       ],`);
  lines.push(`       partitions=[('school_year', 'STRING')],`);
  lines.push(`  ) }}`);
  return lines.join('\n') + '\n';
}

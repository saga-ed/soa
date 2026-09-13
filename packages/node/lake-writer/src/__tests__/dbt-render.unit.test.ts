import { describe, expect, it } from 'vitest';

import { renderDbtSourceTable, renderStageOneStanza } from '../dbt-render.js';
import { defineLandingDataset } from '../parquet-writer.js';

type TestWidgetRow = {
  school_year: string;
  source_system: 'manual';
  student_year_hash: string;
  value: string;
  ingest_run_id: string;
  ingested_at: Date;
};

const dataset = defineLandingDataset<TestWidgetRow>({
  name: 'test_widget_manual',
  dataset: 'test_widget',
  sourceSystem: 'manual',
  columns: [
    { name: 'school_year', type: 'string' },
    { name: 'source_system', type: 'string', description: 'Provenance literal.' },
    { name: 'student_year_hash', type: 'string' },
    { name: 'value', type: 'string', optional: true },
    { name: 'ingest_run_id', type: 'string' },
    { name: 'ingested_at', type: 'timestamp' },
  ],
  fingerprint: ['value'],
});

describe('renderDbtSourceTable', () => {
  const yaml = renderDbtSourceTable(dataset);

  it('names the table after the registry key', () => {
    expect(yaml).toContain('- name: test_widget_manual');
  });

  it('sets the external location under the source system + dataset segment', () => {
    expect(yaml).toContain('location: s3://saga-sds-analytics-prod/landing/manual/test_widget/');
  });

  it('sets file_format + compression tbl_properties', () => {
    expect(yaml).toContain('file_format: parquet');
    expect(yaml).toContain("tbl_properties: \"('parquet.compression'='SNAPPY')\"");
  });

  it('declares school_year as a partition, and only as a partition', () => {
    expect(yaml).toContain('partitions:');
    expect(yaml).toContain('data_type: string');
    const occurrences = (yaml.match(/- name: school_year/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it('lowercases the athena type for each non-partition column', () => {
    expect(yaml).toContain('- name: student_year_hash');
    expect(yaml).toContain('- name: value');
    expect(yaml).toContain('- name: ingested_at');
    expect(yaml).toContain('data_type: timestamp');
  });

  it('carries the column description when present', () => {
    expect(yaml).toContain('description: Provenance literal.');
  });

  it('respects a custom bucket', () => {
    const custom = renderDbtSourceTable(dataset, { bucket: 'my-bucket' });
    expect(custom).toContain('location: s3://my-bucket/landing/manual/test_widget/');
  });
});

describe('renderStageOneStanza', () => {
  const jinja = renderStageOneStanza(dataset);

  it('opens a _stage_one(...) call and closes it', () => {
    expect(jinja).toContain('{{ _stage_one(');
    expect(jinja.trim().endsWith(') }}')).toBe(true);
  });

  it('names the table and location', () => {
    expect(jinja).toContain("table='test_widget_manual'");
    expect(jinja).toContain("location='s3://saga-sds-analytics-prod/landing/manual/test_widget/'");
  });

  it('excludes school_year from columns=[...] and carries it only in partitions=[...]', () => {
    const columnsBlock = jinja.slice(jinja.indexOf('columns=['), jinja.indexOf('partitions='));
    expect(columnsBlock).not.toContain("('school_year',");
    expect(jinja).toContain("partitions=[('school_year', 'STRING')]");
  });

  it('lists every non-partition column as a (name, ATHENA_TYPE) tuple', () => {
    expect(jinja).toContain("('student_year_hash', 'STRING')");
    expect(jinja).toContain("('value', 'STRING')");
    expect(jinja).toContain("('ingested_at', 'TIMESTAMP')");
  });

  it('respects a custom landing-schema Jinja variable name', () => {
    const custom = renderStageOneStanza(dataset, { landingSchemaVar: 'my_schema_var' });
    expect(custom).toContain('schema=my_schema_var');
  });
});

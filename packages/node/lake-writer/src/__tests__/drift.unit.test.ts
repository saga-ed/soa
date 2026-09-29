import { describe, expect, it } from 'vitest';

import { compareRegistryToDbtSources, type DbtSourcesFile, type DbtTable } from '../drift.js';
import { defineLandingDataset, requireStudentYearHash } from '../parquet-writer.js';

type TestWidgetRow = {
  school_year: string;
  source_system: 'manual';
  student_year_hash: string;
  value: string;
  ingest_run_id: string;
  ingested_at: Date;
};

const dataset = requireStudentYearHash(
  defineLandingDataset<TestWidgetRow>({
    name: 'test_widget_manual',
    dataset: 'test_widget',
    sourceSystem: 'manual',
    columns: [
      { name: 'school_year', type: 'string' },
      { name: 'source_system', type: 'string' },
      { name: 'student_year_hash', type: 'string' },
      { name: 'value', type: 'string' },
      { name: 'ingest_run_id', type: 'string' },
      { name: 'ingested_at', type: 'timestamp' },
    ],
    fingerprint: ['value'],
  })
);

const registry = { test_widget_manual: dataset };

function baseTable(): DbtTable {
  return {
    name: 'test_widget_manual',
    external: { partitions: [{ name: 'school_year', data_type: 'string' }] },
    columns: [
      { name: 'source_system', data_type: 'string' },
      { name: 'student_year_hash', data_type: 'string' },
      { name: 'value', data_type: 'string' },
      { name: 'ingest_run_id', data_type: 'string' },
      { name: 'ingested_at', data_type: 'timestamp' },
    ],
  };
}

function sourcesYmlWith(...tables: DbtTable[]): DbtSourcesFile {
  return { sources: [{ name: 'landing', tables }] };
}

describe('compareRegistryToDbtSources', () => {
  it('reports no problems when the registry and sources.yml agree', () => {
    const { problems } = compareRegistryToDbtSources(registry, sourcesYmlWith(baseTable()));
    expect(problems).toEqual([]);
  });

  it('reports a missing column when sources.yml drops one the registry has (deliberate mismatch)', () => {
    const table = baseTable();
    table.columns = (table.columns ?? []).filter(c => c.name !== 'value');
    const { problems } = compareRegistryToDbtSources(registry, sourcesYmlWith(table));
    expect(problems.some(p => p.includes('value'))).toBe(true);
  });

  it('reports a registry dataset missing its own declared fingerprint column', () => {
    // A dataset whose `fingerprint` references a column the schema itself
    // never declares — self-consistency, independent of sources.yml.
    const badFingerprintDataset = defineLandingDataset<TestWidgetRow>({
      name: 'test_widget_manual',
      dataset: 'test_widget',
      sourceSystem: 'manual',
      columns: [
        { name: 'school_year', type: 'string' },
        { name: 'source_system', type: 'string' },
        { name: 'ingest_run_id', type: 'string' },
        { name: 'ingested_at', type: 'timestamp' },
      ],
      fingerprint: ['value'],
    });
    const { problems } = compareRegistryToDbtSources(
      { test_widget_manual: badFingerprintDataset },
      sourcesYmlWith({
        name: 'test_widget_manual',
        columns: [
          { name: 'source_system', data_type: 'string' },
          { name: 'ingest_run_id', data_type: 'string' },
          { name: 'ingested_at', data_type: 'timestamp' },
        ],
        external: { partitions: [{ name: 'school_year', data_type: 'string' }] },
      })
    );
    expect(problems.some(p => p.includes('fingerprint'))).toBe(true);
  });

  it('reports a coarse type-category mismatch', () => {
    const table = baseTable();
    const valueCol = (table.columns ?? []).find(c => c.name === 'value');
    expect(valueCol).toBeDefined();
    valueCol!.data_type = 'double';
    const { problems } = compareRegistryToDbtSources(registry, sourcesYmlWith(table));
    expect(problems.some(p => p.includes('type-category drift'))).toBe(true);
  });

  it('reports a registry dataset with no matching sources.yml table', () => {
    const { problems } = compareRegistryToDbtSources(registry, sourcesYmlWith());
    expect(problems.some(p => p.includes('has no sources.yml table'))).toBe(true);
  });

  it('reports a sources.yml table with no matching registry dataset', () => {
    const orphanTable: DbtTable = { name: 'orphan_dataset', columns: [] };
    const { problems } = compareRegistryToDbtSources(
      registry,
      sourcesYmlWith(baseTable(), orphanTable)
    );
    expect(
      problems.some(p => p.includes('orphan_dataset') && p.includes('no registry entry'))
    ).toBe(true);
  });

  it('ignores a sources.yml table named in ignoreTables', () => {
    const dimTable: DbtTable = { name: 'attendance_status_legend', columns: [] };
    const { problems } = compareRegistryToDbtSources(
      registry,
      sourcesYmlWith(baseTable(), dimTable),
      { ignoreTables: ['attendance_status_legend'] }
    );
    expect(problems).toEqual([]);
  });

  it('reports overlap between columns and partitions', () => {
    const table = baseTable();
    table.columns = [...(table.columns ?? []), { name: 'school_year', data_type: 'string' }];
    const { problems } = compareRegistryToDbtSources(registry, sourcesYmlWith(table));
    expect(problems.some(p => p.includes('overlap'))).toBe(true);
  });
});

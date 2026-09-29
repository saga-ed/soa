import parquet from '@dsnp/parquetjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runSnapshotExport } from '../export.js';
import { curatedLandingKey, runManifestKey } from '../landing-path.js';
import { defineLandingDataset, requireStudentYearHash } from '../parquet-writer.js';
import { LocalLandingSink } from '../sink.js';

type TestWidgetRow = {
  school_year: string;
  source_system: 'manual';
  student_year_hash: string;
  value: string;
  ingest_run_id: string;
  ingested_at: Date;
};

const testDataset = requireStudentYearHash(
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

describe('PartitionedParquetWriter + runSnapshotExport + LocalLandingSink', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'lake-writer-test-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('writes 3 rows across 2 school years, lands each partition, and writes a manifest', async () => {
    const runId = 'run-test-1';
    const ingestedAt = new Date('2026-05-01T00:00:00.000Z');
    const rows: TestWidgetRow[] = [
      {
        school_year: 'SY25-26',
        source_system: 'manual',
        student_year_hash: 'h1',
        value: 'a',
        ingest_run_id: runId,
        ingested_at: ingestedAt,
      },
      {
        school_year: 'SY25-26',
        source_system: 'manual',
        student_year_hash: 'h2',
        value: 'b',
        ingest_run_id: runId,
        ingested_at: ingestedAt,
      },
      {
        school_year: 'SY24-25',
        source_system: 'manual',
        student_year_hash: 'h3',
        value: 'c',
        ingest_run_id: runId,
        ingested_at: ingestedAt,
      },
    ];

    const sink = new LocalLandingSink(rootDir);
    const result = await runSnapshotExport<TestWidgetRow>({
      dataset: testDataset,
      rows,
      sink,
      runId,
      ingestedAt,
    });

    expect(result.runId).toBe(runId);
    expect(result.partitions).toHaveLength(2);

    const sy2526 = result.partitions.find(p => p.schoolYear === 'SY25-26');
    const sy2425 = result.partitions.find(p => p.schoolYear === 'SY24-25');
    expect(sy2526?.rowCount).toBe(2);
    expect(sy2425?.rowCount).toBe(1);

    const expectedKey2526 = curatedLandingKey({
      sourceSystem: 'manual',
      dataset: 'test_widget',
      schoolYear: 'SY25-26',
      runId,
    });
    expect(sy2526?.key).toBe(expectedKey2526);

    // Read the landed Parquet file back and assert row content + count.
    const filePath = join(rootDir, sy2526!.key);
    const reader = await parquet.ParquetReader.openFile(filePath);
    const cursor = reader.getCursor();
    const readRows: Array<Record<string, unknown>> = [];
    let record: Record<string, unknown> | null;
    while ((record = await cursor.next())) {
      readRows.push(record);
    }
    await reader.close();

    expect(readRows).toHaveLength(2);
    expect(readRows.map(r => r.value).sort()).toEqual(['a', 'b']);
    expect(readRows.every(r => r.school_year === 'SY25-26')).toBe(true);

    // Metadata sidecar file (LocalLandingSink's `<key>.meta.json` convention).
    const metaRaw = await readFile(`${filePath}.meta.json`, 'utf8');
    expect(JSON.parse(metaRaw)).toEqual({
      'sds-ingest-run-id': runId,
      'sds-source-system': 'manual',
      'sds-dataset': 'test_widget',
      'sds-school-year': 'SY25-26',
    });

    // Run manifest.
    const manifestKey = runManifestKey({
      sourceSystem: 'manual',
      dataset: 'test_widget',
      runId,
    });
    expect(manifestKey.startsWith('landing/')).toBe(false);
    const manifestRaw = await readFile(join(rootDir, manifestKey), 'utf8');
    const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
    expect(manifest.runId).toBe(runId);
    expect(manifest.dataset).toBe('test_widget_manual');
    expect(manifest.sourceSystem).toBe('manual');
    expect(manifest.hashRecipeVersion).toBe(1);
    expect(manifest.partitions).toHaveLength(2);
    expect(manifest.columns).toContainEqual({ name: 'value', type: 'STRING' });
  });
});

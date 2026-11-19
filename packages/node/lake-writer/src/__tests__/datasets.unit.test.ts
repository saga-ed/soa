import parquet from '@dsnp/parquetjs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { compareRegistryToDbtSources, type DbtSourcesFile } from '../drift.js';
import { renderDbtSourceTable, renderStageOneStanza } from '../dbt-render.js';
import {
  externalDatasets,
  cohortProgramhubDataset,
  iamGroupRosteringDataset,
  identityCrosswalkRosteringDataset,
  programhubDatasets,
  rosteringDatasets,
  type CohortProgramhubRow,
  type IamGroupRosteringRow,
  type IdentityCrosswalkRosteringRow,
} from '../datasets/index.js';
import { runSnapshotExport } from '../export.js';
import { curatedLandingKey, runManifestKey } from '../landing-path.js';
import { LocalLandingSink } from '../sink.js';

const entries = Object.entries(externalDatasets);

describe('externalDatasets registry', () => {
  it('defines every descriptor without throwing, and the registry has exactly the expected 12 entries', () => {
    expect(entries).toHaveLength(12);
    for (const [, dataset] of entries) {
      expect(dataset.schema).toBeDefined();
      expect(dataset.columnNames.length).toBeGreaterThan(0);
    }
  });

  it('splits into 4 rostering + 8 programhub datasets', () => {
    expect(Object.keys(rosteringDatasets)).toHaveLength(4);
    expect(Object.keys(programhubDatasets)).toHaveLength(8);
  });

  it('registry keys equal `${dataset}_${sourceSystem}` for every entry', () => {
    for (const [key, dataset] of entries) {
      expect(key).toBe(dataset.name);
      expect(dataset.name).toBe(`${dataset.dataset}_${dataset.sourceSystem}`);
    }
  });

  it('every declared fingerprint column exists in its own schema', () => {
    for (const [key, dataset] of entries) {
      const columnNames = new Set(dataset.columnNames);
      for (const fp of dataset.fingerprint) {
        expect(
          columnNames.has(fp),
          `${key}: fingerprint column "${fp}" missing from its own schema`
        ).toBe(true);
      }
    }
  });

  it('no two datasets in the same source share an identical fingerprint set', () => {
    const bySource = new Map<string, Array<{ key: string; fingerprint: string }>>();
    for (const [key, dataset] of entries) {
      const fingerprint = [...dataset.fingerprint].sort().join('|');
      const list = bySource.get(dataset.sourceSystem) ?? [];
      list.push({ key, fingerprint });
      bySource.set(dataset.sourceSystem, list);
    }
    for (const [sourceSystem, list] of bySource) {
      const seen = new Map<string, string>();
      for (const { key, fingerprint } of list) {
        const clashKey = seen.get(fingerprint);
        expect(
          clashKey,
          `${sourceSystem}: "${key}" and "${clashKey}" share an identical fingerprint set (${fingerprint})`
        ).toBeUndefined();
        seen.set(fingerprint, key);
      }
    }
  });
});

describe('renderDbtSourceTable / renderStageOneStanza over every descriptor', () => {
  for (const [key, dataset] of entries) {
    it(`${key}: both renderers produce text containing the dataset's S3 location`, () => {
      const location = `s3://saga-sds-analytics-prod/landing/${dataset.sourceSystem}/${dataset.dataset}/`;

      const yaml = renderDbtSourceTable(dataset);
      expect(yaml).toContain(location);

      const jinja = renderStageOneStanza(dataset);
      expect(jinja).toContain(location);
    });
  }
});

describe('compareRegistryToDbtSources round-trip through rendered YAML', () => {
  it('reports zero problems when the sources object is built from the descriptors themselves', () => {
    const tablesYaml = entries.map(([, dataset]) => renderDbtSourceTable(dataset)).join('');
    const sourcesYamlText = `sources:\n  - name: landing\n    tables:\n${tablesYaml}`;
    const sourcesFromRenderedYaml = parseYaml(sourcesYamlText) as DbtSourcesFile;

    const { problems } = compareRegistryToDbtSources(externalDatasets, sourcesFromRenderedYaml);
    expect(problems).toEqual([]);
  });
});

describe('end-to-end: runSnapshotExport of identity_crosswalk_rostering into a LocalLandingSink', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'lake-writer-datasets-test-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('lands a data.parquet under the expected key and writes a manifest under manifests/rostering/identity_crosswalk/', async () => {
    const runId = 'run-crosswalk-1';
    const ingestedAt = new Date('2026-09-13T00:00:00.000Z');
    const snapshotAt = ingestedAt;
    const rows: IdentityCrosswalkRosteringRow[] = [
      {
        school_year: 'SY25-26',
        source_system: 'rostering',
        student_year_hash: 'hash-1',
        org_id: 'org-1',
        district_student_id_hash: 'district-hash-1',
        district_student_id_source: 'CLEVER',
        district_student_id_available: true,
        state_student_id_hash: 'state-hash-1',
        state_student_id_source: 'CLEVER',
        state_student_id_available: true,
        state_student_id_conflict: false,
        external_user_id_hash: null,
        user_role: 'STUDENT',
        user_status: 'active',
        snapshot_at: snapshotAt,
        ingest_run_id: runId,
        ingested_at: ingestedAt,
      },
      {
        school_year: 'SY25-26',
        source_system: 'rostering',
        student_year_hash: 'hash-2',
        org_id: 'org-1',
        district_student_id_hash: null,
        district_student_id_source: null,
        district_student_id_available: false,
        state_student_id_hash: null,
        state_student_id_source: null,
        state_student_id_available: false,
        state_student_id_conflict: false,
        external_user_id_hash: null,
        user_role: 'TUTOR',
        user_status: 'active',
        snapshot_at: snapshotAt,
        ingest_run_id: runId,
        ingested_at: ingestedAt,
      },
    ];

    const sink = new LocalLandingSink(rootDir);
    const result = await runSnapshotExport<IdentityCrosswalkRosteringRow>({
      dataset: identityCrosswalkRosteringDataset,
      rows,
      sink,
      runId,
      ingestedAt,
    });

    expect(result.partitions).toHaveLength(1);
    const expectedKey = curatedLandingKey({
      sourceSystem: 'rostering',
      dataset: 'identity_crosswalk',
      schoolYear: 'SY25-26',
      runId,
    });
    expect(expectedKey).toBe(
      `landing/rostering/identity_crosswalk/school_year=SY25-26/run_id=${runId}/data.parquet`
    );
    expect(result.partitions[0]?.key).toBe(expectedKey);
    expect(result.partitions[0]?.rowCount).toBe(2);

    const parquetStat = await stat(join(rootDir, expectedKey));
    expect(parquetStat.isFile()).toBe(true);

    const manifestKey = runManifestKey({
      sourceSystem: 'rostering',
      dataset: 'identity_crosswalk',
      runId,
    });
    expect(manifestKey.startsWith('manifests/rostering/identity_crosswalk/')).toBe(true);
    const manifestRaw = await readFile(join(rootDir, manifestKey), 'utf8');
    const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
    expect(manifest.runId).toBe(runId);
    expect(manifest.dataset).toBe('identity_crosswalk_rostering');
    expect(manifest.sourceSystem).toBe('rostering');
  });
});

describe('point-in-time validity columns on the entity-state datasets', () => {
  const validityDatasets = [
    'iam_group_rostering',
    'program_programhub',
    'program_period_programhub',
    'program_pod_programhub',
    'cohort_programhub',
  ] as const;

  for (const key of validityDatasets) {
    it(`${key}: valid_from / valid_until are optional timestamps outside the fingerprint`, () => {
      const dataset = externalDatasets[key];
      expect(dataset.columnNames).toEqual(expect.arrayContaining(['valid_from', 'valid_until']));
      for (const col of ['valid_from', 'valid_until']) {
        const field = dataset.schema.fields[col];
        expect(field, `${key}.${col}`).toBeDefined();
        expect(field?.repetitionType, `${key}.${col} optional`).toBe('OPTIONAL');
        expect(field?.originalType, `${key}.${col} type`).toBe('TIMESTAMP_MILLIS');
      }
      expect(dataset.fingerprint).not.toContain('valid_from');
      expect(dataset.fingerprint).not.toContain('valid_until');
    });
  }

  it('reports drift when sources.yml drops a validity column the registry declares', () => {
    const dataset = externalDatasets.program_programhub;
    const yaml = `sources:\n  - name: landing\n    tables:\n${renderDbtSourceTable(dataset)}`;
    const sources = parseYaml(yaml) as DbtSourcesFile;
    const table = sources.sources[0]?.tables[0];
    if (!table?.columns) throw new Error('rendered table has no columns');
    table.columns = table.columns.filter(c => c.name !== 'valid_until');

    const { problems } = compareRegistryToDbtSources({ program_programhub: dataset }, sources);
    expect(problems.some(p => p.includes('valid_until'))).toBe(true);
  });
});

describe('end-to-end: cohort_programhub write/read round-trip with null validity', () => {
  it('lands a row with null valid_from / valid_until and reads it back', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'lake-writer-cohort-test-'));
    try {
      const runId = 'run-cohort-1';
      const ingestedAt = new Date('2026-09-13T00:00:00.000Z');
      const rows: CohortProgramhubRow[] = [
        {
          school_year: 'SY25-26',
          source_system: 'programhub',
          cohort_id: 'cohort-1',
          period_id: 'period-1',
          program_id: 'program-1',
          version: 1,
          deleted_at: null,
          created_at: ingestedAt,
          updated_at: ingestedAt,
          valid_from: null,
          valid_until: null,
          snapshot_at: ingestedAt,
          ingest_run_id: runId,
          ingested_at: ingestedAt,
        },
      ];
      const result = await runSnapshotExport<CohortProgramhubRow>({
        dataset: cohortProgramhubDataset,
        rows,
        sink: new LocalLandingSink(rootDir),
        runId,
        ingestedAt,
      });
      expect(result.partitions).toHaveLength(1);

      const reader = await parquet.ParquetReader.openFile(join(rootDir, result.partitions[0]!.key));
      const cursor = reader.getCursor();
      const read: Array<Record<string, unknown>> = [];
      let record: Record<string, unknown> | null;
      while ((record = await cursor.next())) read.push(record);
      await reader.close();

      expect(read).toHaveLength(1);
      expect(read[0]?.cohort_id).toBe('cohort-1');
      expect(read[0]?.valid_from ?? null).toBeNull();
      expect(read[0]?.valid_until ?? null).toBeNull();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

describe('end-to-end: iam_group_rostering write/read round-trip with null validity', () => {
  it('lands a row with null valid_from / valid_until and reads it back', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'lake-writer-iamgroup-test-'));
    try {
      const runId = 'run-iamgroup-1';
      const ingestedAt = new Date('2026-09-13T00:00:00.000Z');
      const validFrom = new Date('2026-08-01T00:00:00.000Z');
      const validUntil = new Date('2026-12-31T00:00:00.000Z');
      const rows: IamGroupRosteringRow[] = [
        {
          school_year: 'SY25-26',
          source_system: 'rostering',
          group_id: 'group-1',
          parent_group_id: null,
          org_id: 'group-1',
          kind: 'district',
          display_name: 'Example District',
          status: 'ACTIVE',
          source: null,
          source_id: null,
          created_at: ingestedAt,
          updated_at: ingestedAt,
          valid_from: null,
          valid_until: null,
          snapshot_at: ingestedAt,
          ingest_run_id: runId,
          ingested_at: ingestedAt,
        },
        {
          school_year: 'SY25-26',
          source_system: 'rostering',
          group_id: 'group-2',
          parent_group_id: 'group-1',
          org_id: 'group-1',
          kind: 'school',
          display_name: 'Example School',
          status: 'ACTIVE',
          source: null,
          source_id: null,
          created_at: ingestedAt,
          updated_at: ingestedAt,
          valid_from: validFrom,
          valid_until: validUntil,
          snapshot_at: ingestedAt,
          ingest_run_id: runId,
          ingested_at: ingestedAt,
        },
      ];
      const result = await runSnapshotExport<IamGroupRosteringRow>({
        dataset: iamGroupRosteringDataset,
        rows,
        sink: new LocalLandingSink(rootDir),
        runId,
        ingestedAt,
      });
      expect(result.partitions).toHaveLength(1);

      const reader = await parquet.ParquetReader.openFile(join(rootDir, result.partitions[0]!.key));
      const cursor = reader.getCursor();
      const read: Array<Record<string, unknown>> = [];
      let record: Record<string, unknown> | null;
      while ((record = await cursor.next())) read.push(record);
      await reader.close();

      expect(read).toHaveLength(2);
      const nullRow = read.find(r => r.group_id === 'group-1');
      const stampedRow = read.find(r => r.group_id === 'group-2');
      expect(nullRow?.valid_from ?? null).toBeNull();
      expect(nullRow?.valid_until ?? null).toBeNull();
      expect(stampedRow?.valid_from).toEqual(validFrom);
      expect(stampedRow?.valid_until).toEqual(validUntil);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

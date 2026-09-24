import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { compareRegistryToDbtSources, type DbtSourcesFile } from '../drift.js';
import { renderDbtSourceTable, renderStageOneStanza } from '../dbt-render.js';
import {
  externalDatasets,
  identityCrosswalkRosteringDataset,
  programhubDatasets,
  rosteringDatasets,
  type IdentityCrosswalkRosteringRow,
} from '../datasets/index.js';
import { runSnapshotExport } from '../export.js';
import { curatedLandingKey, runManifestKey } from '../landing-path.js';
import { LocalLandingSink } from '../sink.js';

const entries = Object.entries(externalDatasets);

describe('externalDatasets registry', () => {
  it('defines every descriptor without throwing, and the registry has exactly the expected 11 entries', () => {
    expect(entries).toHaveLength(11);
    for (const [, dataset] of entries) {
      expect(dataset.schema).toBeDefined();
      expect(dataset.columnNames.length).toBeGreaterThan(0);
    }
  });

  it('splits into 4 rostering + 7 programhub datasets', () => {
    expect(Object.keys(rosteringDatasets)).toHaveLength(4);
    expect(Object.keys(programhubDatasets)).toHaveLength(7);
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

import { describe, expect, it } from 'vitest';

import {
  curatedLandingKey,
  landingObjectMetadata,
  rawEvidenceKey,
  runManifestKey,
} from '../landing-path.js';

describe('curatedLandingKey', () => {
  it('builds the data.parquet key', () => {
    expect(
      curatedLandingKey({
        sourceSystem: 'salesforce',
        dataset: 'participation',
        schoolYear: 'SY25-26',
        runId: 'run-1',
      })
    ).toBe('landing/salesforce/participation/school_year=SY25-26/run_id=run-1/data.parquet');
  });

  it('builds a zero-padded part key when `part` is given', () => {
    expect(
      curatedLandingKey({
        sourceSystem: 'programhub',
        dataset: 'session_occurrence',
        schoolYear: 'SY25-26',
        runId: 'run-2',
        part: 3,
      })
    ).toBe(
      'landing/programhub/session_occurrence/school_year=SY25-26/run_id=run-2/part-003.parquet'
    );
  });

  it('throws on an invalid dataset name', () => {
    expect(() =>
      curatedLandingKey({
        sourceSystem: 'salesforce',
        dataset: 'Bad-Name',
        schoolYear: 'SY25-26',
        runId: 'run-1',
      })
    ).toThrow();
  });

  it('throws on an invalid school_year', () => {
    expect(() =>
      curatedLandingKey({
        sourceSystem: 'salesforce',
        dataset: 'participation',
        schoolYear: '2025-2026',
        runId: 'run-1',
      })
    ).toThrow();
  });
});

describe('rawEvidenceKey', () => {
  it('builds the un-chunked raw evidence key', () => {
    expect(
      rawEvidenceKey({
        sourceSystem: 'saga_connect',
        dataset: 'student_identity_xwalk',
        schoolYear: 'SY25-26',
        runId: 'run-1',
      })
    ).toBe('raw/saga_connect/student_identity_xwalk/SY25-26/run-1.json');
  });

  it('builds a chunked raw evidence key', () => {
    expect(
      rawEvidenceKey({
        sourceSystem: 'saga_connect',
        dataset: 'transcript',
        schoolYear: 'SY25-26',
        runId: 'run-1',
        chunk: 2,
      })
    ).toBe('raw/saga_connect/transcript/SY25-26/run-1/part-002.json');
  });
});

describe('runManifestKey', () => {
  it('builds the manifest key under the manifests/ prefix, never landing/', () => {
    const key = runManifestKey({
      sourceSystem: 'ledger_api',
      dataset: 'assessment',
      runId: 'run-9',
    });
    expect(key).toBe('manifests/ledger_api/assessment/run-9.json');
    expect(key.startsWith('landing/')).toBe(false);
  });
});

describe('landingObjectMetadata', () => {
  it('builds the exact S3 metadata keys the fixtures CLIs set today', () => {
    expect(
      landingObjectMetadata({
        runId: 'run-1',
        sourceSystem: 'salesforce',
        dataset: 'participation',
        schoolYear: 'SY25-26',
      })
    ).toEqual({
      'sds-ingest-run-id': 'run-1',
      'sds-source-system': 'salesforce',
      'sds-dataset': 'participation',
      'sds-school-year': 'SY25-26',
    });
  });
});

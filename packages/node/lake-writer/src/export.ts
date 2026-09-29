// Thin orchestration: the entry point exporters call once their rows are
// already pseudonymised. Streams rows into per-school_year Parquet
// files, uploads each partition, then writes a run manifest recording
// what happened.

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { curatedLandingKey, landingObjectMetadata, runManifestKey } from './landing-path.js';
import { athenaType, PartitionedParquetWriter, type LandingDataset } from './parquet-writer.js';
import { HASH_RECIPE_VERSION } from './pseudonymise.js';
import type { LandingSink } from './sink.js';

/** Generate a fresh run id (v4 UUID) for a `runSnapshotExport` call. */
export function newRunId(): string {
  return randomUUID();
}

export interface RunSnapshotExportArgs<Row extends { school_year: string }> {
  dataset: LandingDataset<Row>;
  rows: AsyncIterable<Row> | Iterable<Row>;
  sink: LandingSink;
  runId?: string;
  ingestedAt?: Date;
  /** Reuse an existing tmp dir instead of creating (and cleaning up) one. */
  tmpDir?: string;
  /** Extra fields merged into the run manifest before the fixed fields below. */
  manifest?: Record<string, unknown>;
}

export interface RunSnapshotExportPartition {
  schoolYear: string;
  rowCount: number;
  key: string;
}

export interface RunSnapshotExportResult {
  runId: string;
  partitions: RunSnapshotExportPartition[];
}

/**
 * Streams `rows` through a `PartitionedParquetWriter`, uploads one
 * curated object per school_year at `curatedLandingKey(...)` (with
 * `landingObjectMetadata`), then writes a run manifest at
 * `runManifestKey(...)`. Cleans up any tmp dir it created itself, in
 * `finally`.
 *
 * This function does NOT hash anything. Callers must pseudonymise every
 * row (via pseudonymise.ts) in their own transform step before handing
 * rows here — `runSnapshotExport` trusts the rows it's given and will
 * happily land raw PII in the analytics bucket if you let it.
 */
export async function runSnapshotExport<Row extends { school_year: string }>(
  args: RunSnapshotExportArgs<Row>
): Promise<RunSnapshotExportResult> {
  const { dataset, rows, sink } = args;
  const runId = args.runId ?? newRunId();
  const ingestedAt = args.ingestedAt ?? new Date();

  const ownedTmpDir = args.tmpDir == null;
  const tmpDir = args.tmpDir ?? (await mkdtemp(join(tmpdir(), 'lake-writer-')));

  try {
    const writer = new PartitionedParquetWriter<Row>(dataset, tmpDir);
    for await (const row of rows as AsyncIterable<Row>) {
      await writer.append(row);
    }
    const closed = await writer.closeAll();

    const partitions: RunSnapshotExportPartition[] = [];
    for (const part of closed) {
      const key = curatedLandingKey({
        sourceSystem: dataset.sourceSystem,
        dataset: dataset.dataset,
        schoolYear: part.schoolYear,
        runId,
      });
      await sink.putCurated({
        key,
        filePath: part.path,
        metadata: landingObjectMetadata({
          runId,
          sourceSystem: dataset.sourceSystem,
          dataset: dataset.dataset,
          schoolYear: part.schoolYear,
        }),
      });
      partitions.push({ schoolYear: part.schoolYear, rowCount: part.rowCount, key });
    }

    const manifestKey = runManifestKey({
      sourceSystem: dataset.sourceSystem,
      // Bare dataset segment — same as curatedLandingKey/rawEvidenceKey,
      // NOT dataset.name (the `_<source>`-suffixed registry key, which
      // belongs in the manifest BODY below, not the S3 key).
      dataset: dataset.dataset,
      runId,
    });
    await sink.putManifest({
      key: manifestKey,
      body: {
        ...(args.manifest ?? {}),
        runId,
        dataset: dataset.name,
        sourceSystem: dataset.sourceSystem,
        ingestedAt: ingestedAt.toISOString(),
        partitions: partitions.map(p => ({
          schoolYear: p.schoolYear,
          rowCount: p.rowCount,
          key: p.key,
        })),
        columns: dataset.columns.map(c => ({ name: c.name, type: athenaType(c.type) })),
        hashRecipeVersion: HASH_RECIPE_VERSION,
      },
    });

    return { runId, partitions };
  } finally {
    if (ownedTmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
}

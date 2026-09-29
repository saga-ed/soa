// Snappy-compressed Parquet writing for the SDS FERPA data lake landing
// zone. Wraps @dsnp/parquetjs (pure-JS, no native deps) behind a small
// registry-driven API: callers declare a dataset's shape once with
// `defineLandingDataset`, and get back a `LandingDataset` that carries
// both the Parquet schema (for writing) and the column/partition
// metadata `dbt-render.ts` and `drift.ts` need.
//
// Ported from apps/node/fixtures/src/writers/parquet-writer.ts in
// student-data-system — same per-field SNAPPY compression convention,
// same Parquet <-> Athena type mapping.

import { join } from 'node:path';
import parquet, { type ParquetType, type SchemaDefinition } from '@dsnp/parquetjs';

import type { SourceSystem } from './landing-path.js';

/** The library-level column types every landing dataset is built from. */
export type LandingColumnType = 'string' | 'double' | 'int64' | 'boolean' | 'timestamp';

const PARQUET_TYPE: Record<LandingColumnType, ParquetType> = {
  string: 'UTF8',
  double: 'DOUBLE',
  int64: 'INT64',
  boolean: 'BOOLEAN',
  timestamp: 'TIMESTAMP_MILLIS',
};

const ATHENA_TYPE: Record<LandingColumnType, string> = {
  string: 'STRING',
  double: 'DOUBLE',
  int64: 'BIGINT',
  boolean: 'BOOLEAN',
  timestamp: 'TIMESTAMP',
};

/** Map a `LandingColumnType` to its Athena/Hive SQL type name. */
export function athenaType(t: LandingColumnType): string {
  return ATHENA_TYPE[t];
}

export interface LandingColumnDef<Row> {
  name: keyof Row & string;
  type: LandingColumnType;
  /** Nullable in Parquet + Athena. Defaults to required (false). */
  optional?: boolean;
  /** Human-readable description, surfaced verbatim by dbt-render.ts. */
  description?: string;
}

export interface LandingPartitionDef {
  name: 'school_year';
  type: 'string';
}

export interface LandingDatasetDef<Row> {
  /** Registry key, e.g. `session_occurrence_programhub` — matches the dbt source table name. */
  name: string;
  /** Bare S3 path segment, e.g. `session_occurrence` — see landing-path.ts. */
  dataset: string;
  sourceSystem: SourceSystem;
  columns: ReadonlyArray<LandingColumnDef<Row>>;
  /** 2-4 columns unique to this dataset among all registered datasets — see drift.ts. */
  fingerprint: readonly string[];
}

export interface LandingDataset<Row> extends LandingDatasetDef<Row> {
  schema: InstanceType<typeof parquet.ParquetSchema>;
  columnNames: string[];
  partitions: readonly [LandingPartitionDef];
}

const REQUIRED_COLUMNS: ReadonlyArray<{ name: string; type: LandingColumnType }> = [
  { name: 'school_year', type: 'string' },
  { name: 'source_system', type: 'string' },
  { name: 'ingest_run_id', type: 'string' },
  { name: 'ingested_at', type: 'timestamp' },
];

/**
 * Declare a landing dataset: validates the structural columns every
 * dataset must carry (`school_year`, `source_system`, `ingest_run_id`,
 * `ingested_at` — all required), builds the `@dsnp/parquetjs`
 * `ParquetSchema`, and returns the full `LandingDataset` descriptor.
 *
 * Does NOT require `student_year_hash` — dimension/reference tables
 * legitimately lack a per-student grain. Fact datasets (anything with a
 * student-year grain) should additionally call `requireStudentYearHash`
 * on the result.
 */
export function defineLandingDataset<Row extends Record<string, unknown>>(
  def: LandingDatasetDef<Row>
): LandingDataset<Row> {
  const byName = new Map<string, LandingColumnDef<Row>>(def.columns.map(c => [c.name, c]));

  for (const required of REQUIRED_COLUMNS) {
    const col = byName.get(required.name);
    if (!col) {
      throw new Error(
        `defineLandingDataset(${def.name}): missing required column "${required.name}"`
      );
    }
    if (col.type !== required.type) {
      throw new Error(
        `defineLandingDataset(${def.name}): column "${required.name}" must be type ` +
          `"${required.type}", got "${col.type}"`
      );
    }
    if (col.optional) {
      throw new Error(
        `defineLandingDataset(${def.name}): column "${required.name}" must be required (non-optional)`
      );
    }
  }

  const schemaFields: SchemaDefinition = {};
  for (const col of def.columns) {
    schemaFields[col.name] = {
      type: PARQUET_TYPE[col.type],
      compression: 'SNAPPY',
      ...(col.optional ? { optional: true } : {}),
    };
  }
  const schema = new parquet.ParquetSchema(schemaFields);

  return {
    ...def,
    schema,
    columnNames: def.columns.map(c => c.name),
    partitions: [{ name: 'school_year', type: 'string' }],
  };
}

/**
 * Enforce that a fact dataset (one with a per-student-year grain) also
 * declares the compound-key join column `student_year_hash` as a
 * required string. Call this on the result of `defineLandingDataset`
 * for anything that isn't a pure dimension table.
 */
export function requireStudentYearHash<Row>(def: LandingDataset<Row>): LandingDataset<Row> {
  const col = def.columns.find(c => c.name === 'student_year_hash');
  if (!col) {
    throw new Error(
      `requireStudentYearHash(${def.name}): missing required column "student_year_hash" ` +
        '(the compound {school_year, stable_external_id} join key — see pseudonymise.ts)'
    );
  }
  if (col.type !== 'string' || col.optional) {
    throw new Error(
      `requireStudentYearHash(${def.name}): "student_year_hash" must be a required string column`
    );
  }
  return def;
}

/** Write every row of `rows` to a single Parquet file at `outputPath`. */
export async function writeParquetFile<Row>(
  dataset: LandingDataset<Row>,
  outputPath: string,
  rows: AsyncIterable<Row> | Iterable<Row>
): Promise<{ rowCount: number }> {
  const writer = await parquet.ParquetWriter.openFile(dataset.schema, outputPath);
  let rowCount = 0;
  for await (const row of rows as AsyncIterable<Row>) {
    await writer.appendRow(row as unknown as Record<string, unknown>);
    rowCount++;
  }
  await writer.close();
  return { rowCount };
}

interface OpenPartitionWriter {
  writer: InstanceType<typeof parquet.ParquetWriter>;
  path: string;
  rowCount: number;
}

/**
 * Streams rows into one Parquet file PER `school_year` encountered,
 * opening each lazily on first append. Port of the `appendPartitioned` /
 * `closeAll` pair from
 * apps/node/fixtures/src/bin/ingest-sds-transcript.ts — the shape every
 * multi-school-year ingest CLI in student-data-system already uses.
 */
export class PartitionedParquetWriter<Row extends { school_year: string }> {
  private readonly writers = new Map<string, OpenPartitionWriter>();

  constructor(
    private readonly dataset: LandingDataset<Row>,
    private readonly tmpDir: string
  ) {}

  async append(row: Row): Promise<void> {
    let w = this.writers.get(row.school_year);
    if (!w) {
      const path = join(this.tmpDir, `${this.dataset.dataset}-${row.school_year}.parquet`);
      const writer = await parquet.ParquetWriter.openFile(this.dataset.schema, path);
      w = { writer, path, rowCount: 0 };
      this.writers.set(row.school_year, w);
    }
    await w.writer.appendRow(row as unknown as Record<string, unknown>);
    w.rowCount++;
  }

  /** Close every open partition writer and return per-partition stats. */
  async closeAll(): Promise<Array<{ schoolYear: string; path: string; rowCount: number }>> {
    const out: Array<{ schoolYear: string; path: string; rowCount: number }> = [];
    for (const [schoolYear, w] of this.writers) {
      await w.writer.close();
      out.push({ schoolYear, path: w.path, rowCount: w.rowCount });
    }
    return out;
  }
}

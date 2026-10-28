// Export cursor persisted in the service's own Postgres: lake S3 IAM is
// write-only, so state cannot live in the lake.

import type { SqlLike } from './pg-like.js';

export interface ExportCursor {
  watermark: Date;
  runId: string;
  updatedAt: Date;
}

export interface ExportCursorStore {
  read(job: string): Promise<ExportCursor | null>;
  write(job: string, c: { watermark: Date; runId: string }): Promise<void>;
}

/** Copy into the service's migration. */
export const LAKE_EXPORT_STATE_DDL =
  'CREATE TABLE IF NOT EXISTS lake_export_state (job text PRIMARY KEY, watermark timestamptz NOT NULL, run_id text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())';

const IDENT = /^[a-z_][a-z0-9_]*$/;

interface CursorRow {
  watermark: Date | string;
  run_id: string;
  updated_at: Date | string;
}

export class PgExportCursorStore implements ExportCursorStore {
  constructor(
    private readonly sql: SqlLike,
    private readonly table = 'lake_export_state',
  ) {
    if (!IDENT.test(table)) throw new Error(`invalid table identifier: ${table}`);
  }

  async read(job: string): Promise<ExportCursor | null> {
    const res = await this.sql.query<CursorRow>(
      `SELECT watermark, run_id, updated_at FROM ${this.table} WHERE job = $1`,
      [job],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      watermark: new Date(row.watermark),
      runId: row.run_id,
      updatedAt: new Date(row.updated_at),
    };
  }

  async write(job: string, c: { watermark: Date; runId: string }): Promise<void> {
    await this.sql.query(
      `INSERT INTO ${this.table} (job, watermark, run_id, updated_at) VALUES ($1, $2, $3, now()) ` +
        'ON CONFLICT (job) DO UPDATE SET watermark = EXCLUDED.watermark, run_id = EXCLUDED.run_id, updated_at = now()',
      [job, c.watermark, c.runId],
    );
  }
}

export class InMemoryExportCursorStore implements ExportCursorStore {
  private readonly cursors = new Map<string, ExportCursor>();

  async read(job: string): Promise<ExportCursor | null> {
    return this.cursors.get(job) ?? null;
  }

  async write(job: string, c: { watermark: Date; runId: string }): Promise<void> {
    this.cursors.set(job, { ...c, updatedAt: new Date() });
  }
}

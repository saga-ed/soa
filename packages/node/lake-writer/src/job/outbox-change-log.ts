// Distinct aggregate ids touched in a window, read from the transactional
// outbox plus its archive. Identifiers are config-only and validated.

import type { SqlLike } from './pg-like.js';

const IDENT = /^[a-z_][a-z0-9_]*$/;

export interface OutboxColumns {
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
}

export interface CollectOutboxAggregateIdsArgs {
  sql: SqlLike;
  since: Date;
  until: Date;
  aggregateTypes: string[];
  table?: string;
  archiveTable?: string;
  columns?: OutboxColumns;
}

const DEFAULT_COLUMNS: OutboxColumns = {
  aggregateType: 'aggregate_type',
  aggregateId: 'aggregate_id',
  occurredAt: 'occurred_at',
};

function ident(value: string): string {
  if (!IDENT.test(value)) throw new Error(`invalid SQL identifier: ${value}`);
  return value;
}

/** Window is (since, until]. */
export async function collectOutboxAggregateIds(
  args: CollectOutboxAggregateIdsArgs,
): Promise<string[]> {
  const table = ident(args.table ?? 'outbox_event');
  const archive = ident(args.archiveTable ?? 'outbox_event_archive');
  const cols = args.columns ?? DEFAULT_COLUMNS;
  const type = ident(cols.aggregateType);
  const id = ident(cols.aggregateId);
  const at = ident(cols.occurredAt);

  const branch = (t: string) =>
    `SELECT ${id} AS aggregate_id FROM ${t} WHERE ${at} > $1 AND ${at} <= $2 AND ${type} = ANY($3)`;
  const text = `SELECT DISTINCT aggregate_id FROM (${branch(table)} UNION ALL ${branch(archive)}) t`;

  const res = await args.sql.query<{ aggregate_id: string }>(text, [
    args.since,
    args.until,
    args.aggregateTypes,
  ]);
  return res.rows.map((r) => r.aggregate_id);
}

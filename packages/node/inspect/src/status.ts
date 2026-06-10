import type { ConsumerStatus, OutboxStatus } from './wire.js';

/**
 * Minimal SQL runner so services can back status providers with whatever
 * client they already hold — a pg Pool (`(sql) => pool.query(sql).then(r => r.rows)`)
 * or Prisma (`(sql) => prisma.$queryRawUnsafe(sql)`). Statements are
 * package-authored constants over validated identifiers; no caller input
 * reaches the SQL text.
 */
export type SqlQuery = (sql: string) => Promise<Array<Record<string, unknown>>>;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function assertIdentifier(table: string): void {
    if (!IDENTIFIER.test(table)) {
        throw new Error(`soa-inspect: invalid table identifier '${table}'`);
    }
}

function toIso(value: unknown): string | null {
    if (value == null) return null;
    if (value instanceof Date) return value.toISOString();
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function toInt(value: unknown): number {
    const n = typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
    return Number.isFinite(n) ? n : 0;
}

/** True for "relation does not exist" from pg (42P01) or Prisma raw-query wrappers. */
function isUndefinedTable(err: unknown): boolean {
    const e = err as { code?: string; meta?: { code?: string }; message?: string };
    return (
        e?.code === '42P01' ||
        e?.meta?.code === '42P01' ||
        /relation .* does not exist/i.test(e?.message ?? '')
    );
}

/**
 * Publisher watermark for services on the canonical `outbox_event` table
 * (@saga-ed/soa-event-outbox). Returns null if the table doesn't exist —
 * callers can wire this unconditionally and non-publishers report no outbox.
 */
export function canonicalOutboxStatus(query: SqlQuery, table = 'outbox_event'): () => Promise<OutboxStatus | null> {
    assertIdentifier(table);
    const sql =
        `SELECT max(occurred_at) AS head_occurred_at, ` +
        `max(published_at) AS last_published_at, ` +
        `(count(*) FILTER (WHERE published_at IS NULL))::int AS unpublished_count ` +
        `FROM ${table}`;
    return async () => {
        let rows: Array<Record<string, unknown>>;
        try {
            rows = await query(sql);
        } catch (err) {
            if (isUndefinedTable(err)) return null;
            throw err;
        }
        const row = rows[0] ?? {};
        return {
            headOccurredAt: toIso(row.head_occurred_at),
            lastPublishedAt: toIso(row.last_published_at),
            unpublishedCount: toInt(row.unpublished_count),
        };
    };
}

/**
 * Consumer watermarks for services on the canonical `consumed_events` table
 * (@saga-ed/soa-event-consumer). One row per consumer_name; [] if the table
 * doesn't exist (service projects nothing).
 */
export function canonicalConsumerStatus(query: SqlQuery, table = 'consumed_events'): () => Promise<ConsumerStatus[]> {
    assertIdentifier(table);
    const sql =
        `SELECT consumer_name, max(processed_at) AS last_processed_at, count(*)::int AS consumed_count ` +
        `FROM ${table} GROUP BY consumer_name ORDER BY consumer_name`;
    return async () => {
        let rows: Array<Record<string, unknown>>;
        try {
            rows = await query(sql);
        } catch (err) {
            if (isUndefinedTable(err)) return [];
            throw err;
        }
        return rows.map((row) => ({
            consumerName: String(row.consumer_name),
            lastProcessedAt: toIso(row.last_processed_at),
            consumedCount: toInt(row.consumed_count),
        }));
    };
}

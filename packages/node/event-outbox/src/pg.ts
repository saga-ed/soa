import type { EventEnvelope } from '@saga-ed/soa-event-envelope';

/**
 * pg-style outbox writer — the `query(sql, params)` counterpart to
 * {@link writeOutbox}, which only accepts a Prisma `$executeRaw` tagged-template
 * executor.
 *
 * Some consumer/request paths hand a `pg` `PoolClient`-shaped client
 * (`query(sql, params)`) rather than a Prisma tx — e.g. an EventConsumer
 * dispatching a projection write inside its own pg transaction. Those callers
 * can't use `writeOutbox`. This variant performs the same INSERT against the
 * same `outbox_event` columns using a parameterized pg query.
 *
 * The column list / parameter casts here are shape-equivalent to the canonical
 * INSERT in `writeOutbox` (write-outbox.ts) — keep them in sync if that
 * contract changes.
 */
export interface PgStyleTx {
    query: (sql: string, params: unknown[]) => Promise<unknown>;
}

export async function writeOutboxPg(tx: PgStyleTx, envelope: EventEnvelope): Promise<void> {
    await tx.query(
        `INSERT INTO outbox_event (
            event_id, aggregate_type, aggregate_id,
            event_type, event_version, payload, meta, occurred_at
         ) VALUES (
            $1::uuid, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::timestamptz
         )`,
        [
            envelope.eventId,
            envelope.aggregateType,
            envelope.aggregateId,
            envelope.eventType,
            envelope.eventVersion,
            JSON.stringify(envelope.payload),
            envelope.meta ? JSON.stringify(envelope.meta) : null,
            envelope.occurredAt,
        ],
    );
}

import type { EventEnvelope } from '@saga-ed/soa-event-envelope';

// Minimal duck-typed interface for any tx client that exposes Prisma's
// `$executeRaw` template-tag method. The intent is that services pass their
// own `Prisma.TransactionClient` here without needing to import a specific
// service's generated Prisma client into this package.
export interface SqlTagExecutor {
    $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

/**
 * Append an envelope to outbox_event in the same transaction as the domain
 * write. Caller is responsible for the surrounding Prisma `$transaction`.
 *
 * `meta` is persisted alongside payload so traceparent + correlationId
 * captured at write-time survives the (potentially milliseconds-later)
 * relay publish — that's how the consumer sees the original request's
 * trace as parent. See packages/envelope's buildEnvelope for the
 * auto-capture path that snapshots the active OTel context.
 */
export async function writeOutbox(
    tx: SqlTagExecutor,
    envelope: EventEnvelope,
): Promise<void> {
    const metaJson = envelope.meta ? JSON.stringify(envelope.meta) : null;
    await tx.$executeRaw`
        INSERT INTO outbox_event (
            event_id, aggregate_type, aggregate_id,
            event_type, event_version, payload, meta, occurred_at
        ) VALUES (
            ${envelope.eventId}::uuid,
            ${envelope.aggregateType},
            ${envelope.aggregateId},
            ${envelope.eventType},
            ${envelope.eventVersion},
            ${JSON.stringify(envelope.payload)}::jsonb,
            ${metaJson}::jsonb,
            ${envelope.occurredAt}::timestamptz
        )
    `;
}

import { randomUUID } from 'node:crypto';
import { context, propagation } from '@opentelemetry/api';
import { z } from 'zod';

// W3C TraceContext requires that `tracestate` only ride along with a
// `traceparent`. The refine catches an orphan `tracestate` at parse time
// rather than letting OTel's propagator silently discard it (which would
// look like trace continuity bug instead of a malformed envelope).
export const EventEnvelopeMetaSchema = z
    .object({
        traceparent: z.string().optional(),
        tracestate: z.string().optional(),
        correlationId: z.string().optional(),
        causationId: z.string().optional(),
    })
    .strip()
    .refine((m) => !(m.tracestate && !m.traceparent), {
        message: 'tracestate requires traceparent (W3C TraceContext)',
        path: ['tracestate'],
    });

export type EventEnvelopeMeta = z.infer<typeof EventEnvelopeMetaSchema>;

// Per D5, the envelope shape itself is treated as v1: any change
// requires coordinated migration across all publishers and consumers.
export const EventEnvelopeSchema = z
    .object({
        eventId: z.string().uuid(),
        eventType: z.string().min(1),
        eventVersion: z.number().int().positive(),
        aggregateType: z.string().min(1),
        aggregateId: z.string().min(1),
        occurredAt: z.string().datetime({ offset: true }),
        payload: z.record(z.unknown()),
        meta: EventEnvelopeMetaSchema.optional(),
    })
    .strip();

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export interface PayloadDescriptor<T> {
    eventType: string;
    eventVersion: number;
    payloadSchema: z.ZodType<T>;
}

/**
 * Build an envelope and snapshot the active OTel trace context into
 * `meta.traceparent`/`meta.tracestate` so the relay-published message
 * carries enough W3C TraceContext for the consumer to chain its CONSUMER
 * span under the original request span.
 *
 * If no SDK is registered (e.g., in tests without tracing), `propagation.inject`
 * is a no-op — `meta` simply stays empty and tracing degrades gracefully.
 *
 * Callers can pass `meta` explicitly to override (e.g., to inject a
 * cross-system traceparent received over HTTP).
 */
export function buildEnvelope<T extends Record<string, unknown>>(args: {
    eventType: string;
    eventVersion: number;
    aggregateType: string;
    aggregateId: string;
    payload: T;
    meta?: EventEnvelopeMeta;
    occurredAt?: Date;
    eventId?: string;
}): EventEnvelope {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);

    const mergedMeta: EventEnvelopeMeta = { ...carrier, ...(args.meta ?? {}) };
    const meta = Object.keys(mergedMeta).length > 0 ? mergedMeta : undefined;

    return EventEnvelopeSchema.parse({
        eventId: args.eventId ?? randomUUID(),
        eventType: args.eventType,
        eventVersion: args.eventVersion,
        aggregateType: args.aggregateType,
        aggregateId: args.aggregateId,
        occurredAt: (args.occurredAt ?? new Date()).toISOString(),
        payload: args.payload,
        meta,
    });
}

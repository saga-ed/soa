import { describe, expect, it } from 'vitest';
import {
    EventEnvelopeMetaSchema,
    EventEnvelopeSchema,
    buildEnvelope,
} from '../index.js';

describe('EventEnvelopeSchema', () => {
    it('validates a minimal envelope', () => {
        const env = buildEnvelope({
            eventType: 'identity.user.created',
            eventVersion: 1,
            aggregateType: 'user',
            aggregateId: '00000000-0000-4000-8000-000000000001',
            payload: { userId: 'u1' },
        });
        expect(env.eventType).toBe('identity.user.created');
        expect(env.eventVersion).toBe(1);
        expect(env.payload).toEqual({ userId: 'u1' });
    });

    it('rejects non-positive version', () => {
        const result = EventEnvelopeSchema.safeParse({
            eventId: '00000000-0000-4000-8000-000000000001',
            eventType: 'foo',
            eventVersion: 0,
            aggregateType: 'thing',
            aggregateId: 'a',
            occurredAt: new Date().toISOString(),
            payload: {},
        });
        expect(result.success).toBe(false);
    });

    it('rejects empty eventType', () => {
        const result = EventEnvelopeSchema.safeParse({
            eventId: '00000000-0000-4000-8000-000000000001',
            eventType: '',
            eventVersion: 1,
            aggregateType: 'thing',
            aggregateId: 'a',
            occurredAt: new Date().toISOString(),
            payload: {},
        });
        expect(result.success).toBe(false);
    });

    it('strips unknown top-level fields (forward compat)', () => {
        const env = EventEnvelopeSchema.parse({
            eventId: '00000000-0000-4000-8000-000000000001',
            eventType: 'foo',
            eventVersion: 1,
            aggregateType: 'thing',
            aggregateId: 'a',
            occurredAt: new Date().toISOString(),
            payload: {},
            futureField: 'should be stripped',
        });
        expect((env as Record<string, unknown>).futureField).toBeUndefined();
    });
});

describe('EventEnvelopeMetaSchema', () => {
    it('accepts traceparent + tracestate together', () => {
        const result = EventEnvelopeMetaSchema.safeParse({
            traceparent: '00-aaaa-bbbb-01',
            tracestate: 'rojo=00f067aa0ba902b7',
        });
        expect(result.success).toBe(true);
    });

    it('accepts traceparent alone', () => {
        const result = EventEnvelopeMetaSchema.safeParse({
            traceparent: '00-aaaa-bbbb-01',
        });
        expect(result.success).toBe(true);
    });

    it('rejects orphan tracestate (W3C invariant)', () => {
        const result = EventEnvelopeMetaSchema.safeParse({
            tracestate: 'rojo=00f067aa0ba902b7',
        });
        expect(result.success).toBe(false);
    });

    it('accepts empty meta', () => {
        const result = EventEnvelopeMetaSchema.safeParse({});
        expect(result.success).toBe(true);
    });
});

describe('buildEnvelope', () => {
    it('omits meta entirely when no carrier and no override are present', () => {
        const env = buildEnvelope({
            eventType: 'foo.bar',
            eventVersion: 1,
            aggregateType: 'thing',
            aggregateId: 'a',
            payload: {},
        });
        // Without an active OTel SDK in this test env, propagation.inject is
        // a no-op, so no carrier merges in. The contract is meta === undefined
        // (not an empty object) — adopters check `if (env.meta)` to gate
        // re-injection on the wire.
        expect(env.meta).toBeUndefined();
    });

    it('explicit meta override wins over (and supplements) the active-context carrier', () => {
        const env = buildEnvelope({
            eventType: 'foo.bar',
            eventVersion: 1,
            aggregateType: 'thing',
            aggregateId: 'a',
            payload: {},
            meta: {
                traceparent: '00-cafebabecafebabecafebabecafebabe-1234567812345678-01',
                correlationId: 'corr-123',
            },
        });
        expect(env.meta?.traceparent).toBe(
            '00-cafebabecafebabecafebabecafebabe-1234567812345678-01',
        );
        expect(env.meta?.correlationId).toBe('corr-123');
    });

    it('uses the supplied occurredAt and eventId when provided', () => {
        const at = new Date('2026-01-02T03:04:05.000Z');
        const id = '00000000-0000-4000-8000-00000000abcd';
        const env = buildEnvelope({
            eventId: id,
            occurredAt: at,
            eventType: 'foo.bar',
            eventVersion: 1,
            aggregateType: 'thing',
            aggregateId: 'a',
            payload: {},
        });
        expect(env.eventId).toBe(id);
        expect(env.occurredAt).toBe(at.toISOString());
    });
});

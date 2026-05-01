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

import { describe, expect, it } from 'vitest';
import {
    buildEnvelope,
    canonicalBytes,
    canonicalize,
    computeHmac,
    decideSignature,
    SIGNATURE_METRIC,
    signEnvelope,
    verifyEnvelope,
    type EventEnvelope,
    type SignatureKeyResolver,
} from '../index.js';

const SECRET = 'do-not-use-in-prod-shared-secret';

const baseEnv = (): EventEnvelope =>
    buildEnvelope({
        eventType: 'identity.user.created',
        eventVersion: 1,
        aggregateType: 'user',
        aggregateId: 'u-1',
        eventId: '00000000-0000-4000-8000-000000000001',
        occurredAt: new Date('2026-05-07T00:00:00.000Z'),
        payload: { userId: 'u-1', name: 'Alice', org: 'd-42' },
    });

describe('canonicalize', () => {
    it('serializes primitives', () => {
        expect(canonicalize(null)).toBe('null');
        expect(canonicalize(true)).toBe('true');
        expect(canonicalize(42)).toBe('42');
        expect(canonicalize('hi')).toBe('"hi"');
    });

    it('preserves array order', () => {
        expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
    });

    it('sorts object keys lexicographically', () => {
        expect(canonicalize({ b: 2, a: 1, c: 3 })).toBe(
            '{"a":1,"b":2,"c":3}',
        );
    });

    it('is recursive', () => {
        expect(canonicalize({ b: [{ y: 1, x: 2 }], a: 0 })).toBe(
            '{"a":0,"b":[{"x":2,"y":1}]}',
        );
    });

    it('produces identical output for differently-keyed equivalent objects', () => {
        expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
    });

    it('drops undefined / function / symbol values from objects (matches JSON.stringify)', () => {
        const sym = Symbol('x');
        const obj = { a: 1, b: undefined, c: () => 0, d: sym, e: 2 };
        expect(canonicalize(obj)).toBe('{"a":1,"e":2}');
    });

    it('replaces undefined / function / symbol with null in arrays (matches JSON.stringify)', () => {
        const sym = Symbol('x');
        expect(canonicalize([1, undefined, () => 0, sym, 2])).toBe(
            '[1,null,null,null,2]',
        );
    });

    it('throws on top-level undefined', () => {
        expect(() => canonicalize(undefined)).toThrow(TypeError);
    });

    it('throws on BigInt', () => {
        expect(() => canonicalize({ a: 1n })).toThrow(TypeError);
    });

    it('throws on circular references', () => {
        const obj: Record<string, unknown> = { a: 1 };
        obj.self = obj;
        expect(() => canonicalize(obj)).toThrow(/circular/i);
    });

    it('handles non-ASCII keys and values consistently', () => {
        const a = canonicalize({ é: 'naïve', ñ: 1 });
        const b = canonicalize({ ñ: 1, é: 'naïve' });
        expect(a).toBe(b);
        // The canonical form must include the actual characters (not hex
        // escapes) — JSON.stringify by default leaves non-ASCII in place.
        expect(a).toContain('"é"');
    });
});

describe('canonicalBytes', () => {
    it('joins fields with newlines in the documented order', () => {
        const env = baseEnv();
        const bytes = canonicalBytes(env).toString('utf8');
        const lines = bytes.split('\n');
        expect(lines[0]).toBe(env.eventId);
        expect(lines[1]).toBe(env.eventType);
        expect(lines[2]).toBe(String(env.eventVersion));
        expect(lines[3]).toBe(env.aggregateType);
        expect(lines[4]).toBe(env.aggregateId);
        expect(lines[5]).toBe(env.occurredAt);
        // Last line is canonicalized payload
        expect(lines[6]).toBe(canonicalize(env.payload));
    });
});

describe('computeHmac', () => {
    it('is deterministic for identical inputs', () => {
        const env = baseEnv();
        expect(computeHmac(env, SECRET)).toBe(computeHmac(env, SECRET));
    });

    it('changes if any field changes', () => {
        const a = baseEnv();
        const b = { ...a, eventType: 'identity.user.updated' };
        expect(computeHmac(a, SECRET)).not.toBe(computeHmac(b, SECRET));
    });

    it('changes with a different secret', () => {
        const env = baseEnv();
        expect(computeHmac(env, SECRET)).not.toBe(computeHmac(env, 'other'));
    });

    it('accepts a Buffer secret', () => {
        const env = baseEnv();
        expect(computeHmac(env, SECRET)).toBe(
            computeHmac(env, Buffer.from(SECRET, 'utf8')),
        );
    });
});

describe('signEnvelope', () => {
    it('returns a new envelope with meta.signature populated', () => {
        const env = baseEnv();
        const signed = signEnvelope(env, { keyId: 'rostering/v1', secret: SECRET });
        expect(env.meta?.signature).toBeUndefined();
        expect(signed.meta?.signature).toEqual({
            alg: 'HS256',
            keyId: 'rostering/v1',
            value: expect.any(String),
        });
    });

    it('preserves existing meta fields', () => {
        const env: EventEnvelope = {
            ...baseEnv(),
            meta: {
                traceparent: '00-aaaa-bbbb-01',
                correlationId: 'corr-1',
            },
        };
        const signed = signEnvelope(env, { keyId: 'k1', secret: SECRET });
        expect(signed.meta?.traceparent).toBe('00-aaaa-bbbb-01');
        expect(signed.meta?.correlationId).toBe('corr-1');
        expect(signed.meta?.signature?.keyId).toBe('k1');
    });
});

describe('verifyEnvelope', () => {
    const resolver: SignatureKeyResolver = (keyId) =>
        keyId === 'k1' ? SECRET : null;

    it('returns valid on round-trip', async () => {
        const env = signEnvelope(baseEnv(), { keyId: 'k1', secret: SECRET });
        const result = await verifyEnvelope(env, resolver);
        expect(result.ok).toBe(true);
        expect(result.status).toBe('valid');
    });

    it('returns absent when no signature is present', async () => {
        const result = await verifyEnvelope(baseEnv(), resolver);
        expect(result.ok).toBe(false);
        expect(result.status).toBe('absent');
    });

    it('returns unknown_key on a key the resolver does not know', async () => {
        const env = signEnvelope(baseEnv(), { keyId: 'k-unknown', secret: SECRET });
        const result = await verifyEnvelope(env, resolver);
        expect(result.status).toBe('unknown_key');
    });

    it('returns invalid when payload is tampered', async () => {
        const env = signEnvelope(baseEnv(), { keyId: 'k1', secret: SECRET });
        const tampered: EventEnvelope = {
            ...env,
            payload: { ...env.payload, name: 'Mallory' },
        };
        const result = await verifyEnvelope(tampered, resolver);
        expect(result.status).toBe('invalid');
    });

    it('returns invalid when the signature value itself is bit-flipped', async () => {
        // Pins the comparison path. A regression where verify returned
        // ok=true on length-match-but-value-mismatch would pass the
        // payload-tamper test (since payload tampering also flips the
        // computed value) but fail this one.
        const env = signEnvelope(baseEnv(), { keyId: 'k1', secret: SECRET });
        const sig = env.meta!.signature!;
        // Flip one base64url char while preserving length
        const flipped = sig.value[0] === 'A' ? 'B' : 'A';
        const tampered: EventEnvelope = {
            ...env,
            meta: {
                ...env.meta,
                signature: {
                    ...sig,
                    value: flipped + sig.value.slice(1),
                },
            },
        };
        const result = await verifyEnvelope(tampered, resolver);
        expect(result.status).toBe('invalid');
    });

    it('full envelope without signature still parses end-to-end (back-compat)', async () => {
        // Pins ADR 0003's promise that pre-signature envelopes continue
        // to flow. Validates the *whole* envelope (not just meta), then
        // checks the verifier reports 'absent'.
        const env = baseEnv();
        const parsed = (await import('../index.js')).EventEnvelopeSchema.parse(env);
        expect(parsed.eventType).toBe(env.eventType);
        const result = await verifyEnvelope(parsed, resolver);
        expect(result.status).toBe('absent');
        expect(result.ok).toBe(false);
    });

    it('returns invalid for unsupported alg', async () => {
        const env = baseEnv();
        const tampered: EventEnvelope = {
            ...env,
            meta: {
                ...env.meta,
                signature: {
                    alg: 'HS256' as const,
                    keyId: 'k1',
                    value: 'AAAA',
                },
            },
        };
        // Force-cast to inject an alg the schema doesn't allow at parse time
        // but we want to test runtime defense:
        (tampered.meta!.signature as { alg: string }).alg = 'RS256';
        const result = await verifyEnvelope(tampered, resolver);
        expect(result.status).toBe('invalid');
    });
});

describe('decideSignature', () => {
    const resolver: SignatureKeyResolver = (keyId) =>
        keyId === 'k1' ? SECRET : null;

    it('off mode always allows', async () => {
        const env = baseEnv();
        const d = await decideSignature(env, resolver, 'off');
        expect(d.action).toBe('allow');
    });

    it('off mode reports `absent` when no signature is present', async () => {
        const d = await decideSignature(baseEnv(), resolver, 'off');
        expect(d.status).toBe('absent');
        expect(d.keyId).toBeNull();
    });

    it('off mode reports `unverified` when a signature IS present (does not lie about presence)', async () => {
        // Operator running 'off' should still be able to see "producers
        // are emitting signatures" via the metric — distinct from
        // "wire is unsigned". Otherwise dashboards lie during a phased
        // rollout.
        const signed = signEnvelope(baseEnv(), { keyId: 'k1', secret: SECRET });
        const d = await decideSignature(signed, resolver, 'off');
        expect(d.status).toBe('unverified');
        expect(d.keyId).toBe('k1');
        expect(d.action).toBe('allow');
    });

    it('shadow allows valid, logs invalid', async () => {
        const valid = signEnvelope(baseEnv(), { keyId: 'k1', secret: SECRET });
        expect((await decideSignature(valid, resolver, 'shadow')).action).toBe(
            'allow',
        );
        expect((await decideSignature(baseEnv(), resolver, 'shadow')).action).toBe(
            'log',
        );
    });

    it('enforce rejects on absent', async () => {
        const d = await decideSignature(baseEnv(), resolver, 'enforce');
        expect(d.action).toBe('reject');
        expect(d.status).toBe('absent');
    });

    it('enforce rejects on unknown_key', async () => {
        const env = signEnvelope(baseEnv(), { keyId: 'k-unknown', secret: SECRET });
        const d = await decideSignature(env, resolver, 'enforce');
        expect(d.action).toBe('reject');
        expect(d.status).toBe('unknown_key');
    });

    it('exposes the canonical metric name', () => {
        expect(SIGNATURE_METRIC).toBe('saga_event_signature_status');
    });
});

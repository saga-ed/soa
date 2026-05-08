import { createHmac, timingSafeEqual } from 'node:crypto';
import type { EventEnvelope } from './index.js';
import type {
    EventSignature,
    SignatureMode,
    SignatureStatus,
} from './signature.js';

/**
 * HMAC-SHA256 signing for event envelopes per ADR 0003.
 *
 * Signature is computed over canonical bytes: envelope identity fields
 * (eventId, eventType, eventVersion, aggregateType, aggregateId,
 * occurredAt) joined with '\n', followed by `canonicalize(payload)`.
 *
 * `canonicalize` is JCS-inspired, not strict RFC 8785: object keys
 * sorted in UTF-16 code-unit order, no whitespace, JSON-spec escapes.
 * Sufficient for byte-identical reproduction within Saga's trust
 * boundary (both sides run Node V8). For RFC 8785 interop, swap
 * `canonicalize` — everything else here is unchanged.
 */

const isJsonHole = (v: unknown): boolean =>
    v === undefined || typeof v === 'symbol' || typeof v === 'function';

/**
 * Deterministic JSON serialization. Matches `JSON.stringify` for
 * non-JSON values (drop in objects, null in arrays, throws on BigInt).
 * Throws on circular references and on a hole at the top level.
 */
export function canonicalize(value: unknown): string {
    const seen = new WeakSet<object>();
    const walk = (v: unknown): string => {
        if (typeof v === 'bigint') {
            throw new TypeError('canonicalize: BigInt is not JSON-serializable');
        }
        if (isJsonHole(v)) {
            throw new TypeError(
                'canonicalize: undefined / symbol / function are not allowed at top level',
            );
        }
        if (v === null) return 'null';
        if (typeof v !== 'object') return JSON.stringify(v);
        if (seen.has(v)) {
            throw new TypeError('canonicalize: circular reference detected');
        }
        seen.add(v);
        try {
            if (Array.isArray(v)) {
                const parts = v.map((item) => (isJsonHole(item) ? 'null' : walk(item)));
                return `[${parts.join(',')}]`;
            }
            const keys = Object.keys(v as Record<string, unknown>).sort();
            const parts: string[] = [];
            for (const k of keys) {
                const child = (v as Record<string, unknown>)[k];
                if (isJsonHole(child)) continue;
                parts.push(`${JSON.stringify(k)}:${walk(child)}`);
            }
            return `{${parts.join(',')}}`;
        } finally {
            seen.delete(v);
        }
    };
    return walk(value);
}

/**
 * Build the canonical bytes the signature is computed over. Exported for
 * test parity and for cross-language reimplementations.
 */
export function canonicalBytes(envelope: EventEnvelope): Buffer {
    const lines = [
        envelope.eventId,
        envelope.eventType,
        String(envelope.eventVersion),
        envelope.aggregateType,
        envelope.aggregateId,
        envelope.occurredAt,
        canonicalize(envelope.payload),
    ];
    return Buffer.from(lines.join('\n'), 'utf8');
}

/**
 * Compute the HMAC-SHA256 signature value (base64url-encoded) over the
 * canonical bytes. The output is just the signature value; callers wrap
 * it with `keyId` and `alg` to form a full {@link EventSignature}.
 */
export function computeHmac(
    envelope: EventEnvelope,
    secret: Buffer | string,
): string {
    const keyBuf = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret;
    const hmac = createHmac('sha256', keyBuf);
    hmac.update(canonicalBytes(envelope));
    return hmac.digest('base64url');
}

/**
 * Sign an envelope. Returns a *new* envelope with `meta.signature`
 * populated. The original envelope is not mutated.
 *
 * The producing service is responsible for key rotation: when a new key
 * is rolled out, callers update `keyId` and `secret` together.
 */
export function signEnvelope(
    envelope: EventEnvelope,
    args: { keyId: string; secret: Buffer | string },
): EventEnvelope {
    const value = computeHmac(envelope, args.secret);
    const signature: EventSignature = {
        alg: 'HS256',
        keyId: args.keyId,
        value,
    };
    return {
        ...envelope,
        meta: {
            ...(envelope.meta ?? {}),
            signature,
        },
    };
}

/**
 * Resolves a signing key by `keyId`. Returns the secret bytes, or `null`
 * if the key is unknown. Implementations typically wrap an SSM cache.
 */
export type SignatureKeyResolver = (
    keyId: string,
) => Buffer | string | null | Promise<Buffer | string | null>;

export interface VerifyResult {
    readonly status: SignatureStatus;
    /**
     * `true` only when status is 'valid'. Convenience for callers that do
     * not need to switch on every status.
     */
    readonly ok: boolean;
    /**
     * The keyId that was attempted. Useful for metric labels even on
     * 'unknown_key' / 'invalid'.
     */
    readonly keyId: string | null;
}

/**
 * Verify an envelope's signature. Pure async function — does not log,
 * emit metrics, or throw. Combine with `SignatureMode` at the call site
 * to decide whether to reject.
 *
 * Status values:
 *   - 'absent'      — no signature on the envelope
 *   - 'unknown_key' — keyId is not known to the resolver
 *   - 'invalid'     — signature does not match
 *   - 'valid'       — signature matches
 */
export async function verifyEnvelope(
    envelope: EventEnvelope,
    resolveKey: SignatureKeyResolver,
): Promise<VerifyResult> {
    const sig = envelope.meta?.signature;
    if (!sig) {
        return { status: 'absent', ok: false, keyId: null };
    }
    if (sig.alg !== 'HS256') {
        // We currently only support HS256. Anything else is treated as
        // 'invalid' — the envelope had a signature, but not one we can
        // verify under the current contract.
        return { status: 'invalid', ok: false, keyId: sig.keyId };
    }
    const secret = await resolveKey(sig.keyId);
    if (secret === null) {
        return { status: 'unknown_key', ok: false, keyId: sig.keyId };
    }
    const expected = computeHmac(envelope, secret);
    const aBuf = Buffer.from(expected);
    const bBuf = Buffer.from(sig.value);
    if (aBuf.length !== bBuf.length) {
        return { status: 'invalid', ok: false, keyId: sig.keyId };
    }
    const equal = timingSafeEqual(aBuf, bBuf);
    return {
        status: equal ? 'valid' : 'invalid',
        ok: equal,
        keyId: sig.keyId,
    };
}

/**
 * Combine `verifyEnvelope` with the configured mode to produce a single
 * decision. The decision is pure — emitting the metric and rejecting are
 * the caller's job (mirrors the two-headers pattern).
 */
export type SignatureAction = 'allow' | 'log' | 'reject';

export interface SignatureDecision {
    readonly action: SignatureAction;
    readonly mode: SignatureMode;
    readonly status: SignatureStatus;
    readonly keyId: string | null;
}

export async function decideSignature(
    envelope: EventEnvelope,
    resolveKey: SignatureKeyResolver,
    mode: SignatureMode,
): Promise<SignatureDecision> {
    if (mode === 'off') {
        // Don't verify — but report what is actually on the wire so
        // the metric distinguishes "no signature emitted" (producer
        // hasn't migrated) from "signature present but verifier
        // disabled by policy".
        const sig = envelope.meta?.signature;
        return {
            action: 'allow',
            mode,
            status: sig ? 'unverified' : 'absent',
            keyId: sig?.keyId ?? null,
        };
    }
    const v = await verifyEnvelope(envelope, resolveKey);
    if (v.ok) {
        return { action: 'allow', mode, status: v.status, keyId: v.keyId };
    }
    return {
        action: mode === 'enforce' ? 'reject' : 'log',
        mode,
        status: v.status,
        keyId: v.keyId,
    };
}

/**
 * Canonical metric name for the signature shadow→enforce migration.
 * Recommended labels: { producer, status, keyId? }
 */
export const SIGNATURE_METRIC = 'saga_event_signature_status' as const;

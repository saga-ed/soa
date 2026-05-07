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
 * The signature is computed over the canonical byte representation:
 *
 *   eventId        ┐
 *   eventType      │
 *   eventVersion   │  joined with '\n', UTF-8
 *   aggregateType  │
 *   aggregateId    │
 *   occurredAt     │
 *   canonical(payload) ┘
 *
 * `canonical(payload)` is a deterministic JSON serialization with object
 * keys sorted in lexicographic UTF-16 order, no whitespace, and JSON-spec
 * escapes. This is sufficient for byte-identical reproduction across
 * producer and consumer (which is what HMAC needs); we do not aim for
 * full RFC 8785 (JCS) compatibility because we control both sides.
 *
 * Compatibility note: if Saga ever needs to interop with a counterparty
 * that requires RFC 8785, swap `canonicalize` for a JCS implementation —
 * the rest of this file does not change.
 */

/**
 * Deterministic JSON serialization. Recursively sorts object keys
 * (UTF-16 code-unit lexicographic order), preserves array order, and
 * matches `JSON.stringify` semantics for non-JSON values:
 *   - `undefined` / function / symbol values: dropped from objects,
 *     replaced with `null` in arrays (per JSON spec).
 *   - `BigInt`: throws (consistent with `JSON.stringify`).
 *   - Circular references: throws (own implementation; we cannot
 *     rely on `JSON.stringify` for the recursion).
 *
 * Compatibility note: this implementation is *JCS-inspired*, not
 * strictly RFC 8785. It is sufficient for byte-identical reproduction
 * across producer and consumer within Saga's trust boundary (both run
 * Node V8). If we ever interop with a counterparty that requires
 * strict RFC 8785, swap this function for a JCS implementation —
 * everything else in this file is unchanged.
 */
export function canonicalize(value: unknown): string {
    return canonicalizeWithSeen(value, new WeakSet<object>());
}

function canonicalizeWithSeen(
    value: unknown,
    seen: WeakSet<object>,
): string {
    if (typeof value === 'bigint') {
        throw new TypeError(
            'canonicalize: BigInt is not JSON-serializable',
        );
    }
    // Top-level undefined / symbol / function are not legal JSON values;
    // a caller that hands us one is misusing the canonical-bytes
    // contract. Throw rather than return invalid output.
    if (
        value === undefined ||
        typeof value === 'symbol' ||
        typeof value === 'function'
    ) {
        throw new TypeError(
            'canonicalize: undefined / symbol / function are not allowed at top level',
        );
    }
    if (value === null) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (seen.has(value)) {
        throw new TypeError('canonicalize: circular reference detected');
    }
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            const parts = value.map((v) => canonicalizeArrayItem(v, seen));
            return `[${parts.join(',')}]`;
        }
        // Object: sort keys, drop entries whose value is undefined / symbol /
        // function (matches `JSON.stringify` behavior).
        const keys = Object.keys(value as Record<string, unknown>).sort();
        const parts: string[] = [];
        for (const k of keys) {
            const v = (value as Record<string, unknown>)[k];
            if (
                v === undefined ||
                typeof v === 'symbol' ||
                typeof v === 'function'
            ) {
                continue;
            }
            parts.push(`${JSON.stringify(k)}:${canonicalizeWithSeen(v, seen)}`);
        }
        return `{${parts.join(',')}}`;
    } finally {
        seen.delete(value);
    }
}

function canonicalizeArrayItem(
    v: unknown,
    seen: WeakSet<object>,
): string {
    if (
        v === undefined ||
        typeof v === 'symbol' ||
        typeof v === 'function'
    ) {
        return 'null';
    }
    return canonicalizeWithSeen(v, seen);
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

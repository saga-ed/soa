import { z } from 'zod';

/**
 * Optional event signature per ADR 0003.
 *
 * Producers populate this when a signing key is configured; consumers
 * verify in shadow mode (default) or enforce mode. The presence of this
 * field is optional today and back-compatible with envelopes that pre-date
 * the addition.
 *
 * The signature value is base64url-encoded HMAC-SHA256 over the canonical
 * byte representation:
 *
 *   eventId || "\n" || eventType || "\n" || eventVersion || "\n" ||
 *   aggregateType || "\n" || aggregateId || "\n" || occurredAt || "\n" ||
 *   canonicalJSON(payload)
 *
 * `canonicalJSON` is JCS-inspired, not strictly RFC 8785 — see
 * `./signing.ts:canonicalize` for the exact algorithm and the
 * sufficient-within-trust-boundary rationale. The signing library lives
 * in `./signing.ts`; this file owns only the schema and the mode types.
 */
// HS256 produces a 32-byte HMAC; base64url with no padding is 43 chars.
// Pin the length so a malformed signature is rejected at parse time
// rather than producing a misleading 'invalid' on length-mismatch
// later (which would be a small timing oracle).
export const EventSignatureSchema = z
    .object({
        alg: z.literal('HS256'),
        keyId: z.string().min(1),
        value: z.string().length(43),
    })
    .strip();

export type EventSignature = z.infer<typeof EventSignatureSchema>;

/**
 * Verifier modes per ADR 0003 § "Consumer behavior".
 *
 * - off: ignore the signature field entirely
 * - shadow: verify if present, log on missing/invalid, do not reject
 * - enforce: verify, reject on missing/invalid
 */
export type SignatureMode = 'off' | 'shadow' | 'enforce';

export const SignatureModeSchema = z.enum(['off', 'shadow', 'enforce']);

/**
 * Status reported per envelope by the verifier (used for the
 * saga_event_signature_status metric).
 *
 *   - 'absent'      — no signature on the envelope
 *   - 'valid'       — signature verified
 *   - 'invalid'     — signature present but does not match
 *   - 'unknown_key' — signature.keyId is not in the resolver
 *   - 'unverified'  — signature present but mode='off' so it was not
 *                     checked. Distinct from 'absent' so dashboards
 *                     can tell "no signature on the wire" from
 *                     "verifier disabled by policy".
 */
export type SignatureStatus =
    | 'absent'
    | 'valid'
    | 'invalid'
    | 'unknown_key'
    | 'unverified';

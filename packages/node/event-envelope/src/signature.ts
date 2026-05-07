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
 * Where canonicalJSON is RFC 8785 JSON Canonicalization Scheme. The signing
 * library (lands in P4) computes this; this file owns only the schema.
 */
export const EventSignatureSchema = z
    .object({
        alg: z.literal('HS256'),
        keyId: z.string().min(1),
        value: z.string().min(1),
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
 */
export type SignatureStatus =
    | 'absent'
    | 'valid'
    | 'invalid'
    | 'unknown_key';

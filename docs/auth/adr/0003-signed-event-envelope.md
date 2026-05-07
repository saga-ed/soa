# ADR 0003 — Signed event envelope (HMAC-SHA256)

**Status:** Accepted
**Date:** 2026-05-07
**Concept primer:** [`saga-dash/docs/auth/concepts.md` § 9 (Events and integrity)](https://github.com/saga-ed/saga-dash/blob/main/docs/auth/concepts.md#9-events-and-integrity)

## Context

Saga services exchange events via RabbitMQ using the outbox pattern. Today the envelope (`@saga-ed/soa-event-envelope`) carries no signature: any process able to publish to the broker can produce a message that consumers will accept and project. This is a forge/replay risk that grows with operational scale (preview environments, cross-account sharing, broker misconfiguration).

The current `EVENT_PREVIEW_TAG` mechanism provides *soft* isolation between PR previews via exchange/queue name suffixes. It is not cryptographically enforced — a misconfigured producer/consumer can cross-pollinate.

## Decision

The envelope schema gains an **optional** `meta.signature` field:

```ts
{
  alg: 'HS256',
  keyId: string,           // identifier in SSM, e.g. "rostering/v1"
  value: string             // base64url HMAC-SHA256 over canonical bytes
}
```

The signature is computed over the canonical byte representation of:

```
eventId || "\n" || eventType || "\n" || eventVersion || "\n" || aggregateType || "\n" || aggregateId || "\n" || occurredAt || "\n" || canonicalJSON(payload)
```

Where `canonicalJSON` is RFC 8785 (JSON Canonicalization Scheme) on the payload object.

### Producer behavior

- If a signing key is configured (env / SSM): sign every envelope.
- If no key is configured: emit envelopes with `meta.signature = undefined` (back-compat).
- Producer rotates keys by writing the new key with a new `keyId` and overlapping the rollout (publish with new key while consumers still verify against old, then drop old).

### Consumer behavior

Modes (per consumer service, default is **shadow**):

- **off** — do not look at the signature field. Useful for local dev where keys aren't seeded.
- **shadow** — verify if present, but do not reject; emit metric on missing/invalid.
- **enforce** — verify, reject on missing or invalid.

Metric: `saga_event_signature_status{producer, status}` where status ∈ {`absent`, `valid`, `invalid`, `unknown_key`}.

### Key management

- Keys live in AWS SSM Parameter Store under `/saga/<env>/event-signing/<producer>/<keyId>`.
- Each producer has its own key family. Consumers fetch all known keys for a producer's family at boot and on a 5-minute cache refresh.
- Keys are 32-byte random values, base64-encoded.
- Rotation is deploy-coordinated: publish new keyId, wait for cache refresh in all consumers, switch producer to new keyId, decommission old after retention window.

### Why HMAC, not ECDSA

Symmetric HMAC is sufficient because:
- All producers and all consumers are inside the Saga trust boundary.
- HMAC is faster and the key material is simpler to manage.
- If we ever cross a trust boundary (vendor-to-vendor events), this ADR will be superseded by an ECDSA-based variant.

## Consequences

**Positive:**
- Defense-in-depth against broker compromise / cross-PR contamination beyond the soft preview-tag.
- Optional field means zero migration cost — existing events remain valid; rollout is per-producer.
- Shadow mode lets each consumer ship metrics before flipping enforce.

**Negative:**
- Adds a small CPU cost per publish/consume (negligible for HMAC-SHA256).
- Key distribution is now an operational concern (SSM); manageable with existing config patterns.

## Alternatives considered

- **TLS to broker (server-side only):** insufficient. Protects in transit but doesn't authenticate the producer to the consumer.
- **Producer mTLS to broker:** complementary, not a substitute. Broker compromise still allows forging.
- **Per-message asymmetric signature (ECDSA):** higher cost, no marginal benefit inside the trust boundary.
- **Mandatory signature (no `optional`):** rejected for migration cost. Optional + shadow mode + per-consumer enforce flips lets each service migrate independently.

## References

- RFC 8785 — JSON Canonicalization Scheme
- ADR 0001 — JWT claim shape (related signing-key management pattern)

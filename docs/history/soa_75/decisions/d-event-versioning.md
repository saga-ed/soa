# d-event-versioning — Frozen-forever schemas, integer-versioned

RESOLVED 2026-04-30: Model A. Each `(eventType, version)` has a schema that is immutable once committed to `tools/contract-check/published/`. Any wire-shape change (additive or breaking) → new integer version. Consumers pin precise versions.

## Context

Two coherent versioning philosophies exist for event schemas:

- **Model A — "Version = exact wire shape, frozen forever":** any byte-level change to a schema requires a new version number.
- **Model B — "Version = MAJOR; additive evolution within a version is allowed":** schemas evolve in-place when changes are backward-compatible (Avro / Protobuf style).

## Options considered

| Concern | Model A | Model B |
|---|---|---|
| CI rule | trivial: `git diff` + flag check | needs structural-diff classifier (additive vs breaking) |
| Version count | higher | lower |
| Pinning fidelity | exact | looser |
| Match to industry default | less common | more common |
| Rollout cost for additive change | same dual-emit dance as breaking | lower |
| CI tooling we'd have to maintain | none beyond a flag check | ~100 LOC structural diff classifier (or external dep) |

## Recommendation

**Model A — frozen-forever.** Reasons:

1. **Trivial CI rule.** "Did `published/<x>-v<n>.json` change without `--bump`? Fail." Twelve-year-old understandable.
2. **No structural-diff classifier to maintain** — the tool surface is one Node script.
3. **Pinning is honest.** Consumer pinning "v1" means exactly that one schema; no ambiguity.
4. **One rollout dance for all changes** — easier for the team to internalize.

The cost (more snapshot files in git) is fine at our scale.

## Envelope shape

```typescript
{
  eventId: string;        // UUID, for consumer idempotency dedup
  eventType: string;      // e.g., "identity.user.created"
  eventVersion: number;   // integer ≥ 1
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;     // ISO-8601 UTC
  payload: Record<string, unknown>;  // validated by (eventType, eventVersion) → schema
  meta?: {
    traceparent?: string; correlationId?: string; causationId?: string;
  };
}
```

## Rules

- Zod default `.strip()` for payloads — unknown fields silently dropped (gentle forward compat).
- Schemas committed to `tools/contract-check/published/<eventType>-v<version>.json` are immutable.
- Consumer `consumed-events.json` lists exact pinned versions; mismatch at runtime → DLQ with `ConsumerVersionMismatch`.

## Bump categories (rollout planning, not CI rules)

- **Transparent bump:** added optional field; no consumer cares yet. Same dual-emit dance with lower urgency.
- **Explicit bump:** rename / retype / semantic change; consumer parsing code must update.

## Phase 3 PR sequence for a breaking bump

1. Publisher adds v2 schema file (no behavior change).
2. Publisher flips dual-emit flag; both v1 and v2 flow.
3. Consumer adds v2 parsing + pins `[1, 2]`.
4. CI confirms all consumers pin v2; publisher drops v1 emission.
5. Consumer drops v1 from pin; v1 schema moves to `published/retired/`.

Each PR is small, reviewable, independently deployable, independently rollbackable.

## Related artifacts

- POC plan: `/home/spaul/.claude/plans/fancy-finding-dream.md` § D5
- Sibling decision: `d-contract-testing.md`
- Reference for ledger-api's `eventVersion` field: `student-data-system/packages/node/ledger-db/src/prisma/schema.prisma:217-232`

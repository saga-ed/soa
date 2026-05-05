# d-contract-testing — Hybrid: publisher snapshot + consumer pins + runtime validation

RESOLVED 2026-04-30: Three layers, zero new infra: (1) publisher snapshot-diff in CI, (2) per-consumer `consumed-events.json` declarations cross-checked in CI, (3) Zod runtime validation at consume time.

## Context

Two failure modes the POC must prevent reaching production:

1. **Silent shape change** — publisher's PR refactors a Zod schema; the wire shape changes; nobody notices until a consumer crashes in prod.
2. **Stranded consumer** — publisher drops support for `eventType.v1`; consumer still pins to v1; first event after deploy → DLQ.

## Options considered

| Approach | Catches silent shape change | Catches stranded consumer | Catches bad payload at runtime | Infra |
|---|---|---|---|---|
| A. Snapshot-diff only | ✅ in CI | ❌ | ❌ | none |
| B. AsyncAPI / Confluent / Apicurio registry | ✅ in CI | ⚠️ if registry tracks consumers | ❌ | server |
| C. Pact-style consumer-driven contracts | ✅ in CI | ✅ in CI | ❌ | broker |
| D. Runtime validation only | ❌ | ❌ | ✅ DLQ | none |
| **E. Hybrid (A + small addition + D)** *(chosen)* | ✅ in CI | ✅ in CI | ✅ DLQ | **none** |

## Recommendation

**Option E — Hybrid.** Three layers:

### Layer 1 — Publisher snapshot (catches silent shape changes)

- `pnpm contract:export` → `zod-to-json-schema` over every event × version → `tools/contract-check/published/<eventType>-v<version>.json`.
- Committed to git. Modifying an existing `-v<n>.json` fails CI.
- Adding new files (publishing a new version) requires explicit `--bump` flag + CHANGELOG entry.

### Layer 2 — Consumer pins (catches stranded consumers)

- Each consumer commits `apps/<consumer>/consumed-events.json`:
  ```json
  {
    "consumer": "admissions-svc",
    "supports": [
      { "eventType": "identity.user.created", "versions": [1, 2] },
      { "eventType": "catalog.program.created", "versions": [1] }
    ]
  }
  ```
- CI cross-check (`tools/contract-check/check.ts`): every consumer-declared `(eventType, version)` must exist in `published/`. Publisher PR that removes a version still pinned by a consumer → CI fails with the consumer named.

### Layer 3 — Runtime validation (catches bad payloads)

- Consumer Zod-validates each incoming event against its declared version's schema.
- Unknown version → DLQ with `ConsumerVersionMismatch` error.

## Why we ruled out alternatives

- **AsyncAPI registry** — overkill for an all-TS internal-only monorepo; another spec format and another server to maintain.
- **Pact broker** — broker infra cost too high for the scale; the hybrid achieves equivalent coverage with files in git.
- **Runtime-only** — fails the "catch at 4 months" goal; failures land in production.

## Free wins

- Snapshot files + consumer pins are exactly the inputs needed for the auto-generated event catalog (Phase 4).
- The PR diff IS the schema change — reviewers see exactly what changed without leaving GitHub.

## Related artifacts

- POC plan: `/home/spaul/.claude/plans/fancy-finding-dream.md` § D6
- Sibling decision: `d-event-versioning.md` (frozen-forever)
- Sibling decision: `d-event-package-shape.md` (per-family)

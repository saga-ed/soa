# d-preview-deploy-isolation — Two-axis isolation for shared-infra preview deploys

**Status:** RESOLVED 2026-05-05 — Postgres `?schema=pr_<n>` (with libpq search_path shim) + RabbitMQ `EVENT_PREVIEW_TAG=pr-<n>` exchange/queue/consumer suffix. Lifted from rostering #138 and program-hub #60 after both adopters independently invented the same pattern.

## Context

The POC (soa_event_driven_example) demonstrates the event-driven primitives but only against a single dev compose stack. Real deployment introduces a constraint the POC didn't face: **multiple PR-preview environments share one Postgres instance and one RabbitMQ broker**, and each PR needs its own isolated routing island so that:

- A PR-preview's outbox writes don't appear in another PR's projection
- A PR-preview's consumer doesn't drain a queue another PR is publishing to
- Cleanup on PR close is mechanical (no orphaned exchanges, no orphaned schema rows)

iam-api in rostering #138 and programs-api / scheduling-api in program-hub #60 each independently arrived at the same two-axis isolation model. This decision codifies it as the canonical pattern for the soa fleet.

## Options considered

| Option | What it gives | Why not |
|---|---|---|
| **Schema-per-PR Postgres + tag-per-PR RabbitMQ** *(recommended — what adopters chose)* | One database, one broker, full per-PR isolation, mechanical cleanup | Requires a libpq search_path shim because node-postgres ignores Prisma's `?schema=` URL param |
| Database-per-PR | Strong isolation, no schema leakage | Per-PR DB provisioning is slow (~1 min RDS create); shared db-host model would need many small DBs; cleanup more complex |
| Single shared schema + row-level tenant column | No DDL per PR | Defeats the purpose — Prisma migrations would conflict between PRs; outbox rows would interleave |
| Broker-per-PR | Trivial isolation | Cost (Amazon MQ broker per PR is wildly expensive); not viable |
| Single shared exchange + consumer filter | Simple wiring | Cross-PR contamination if any consumer mis-binds; no broker-side enforcement |

## Recommendation (resolved)

**Two coordinated axes, both keyed off the same `EVENT_PREVIEW_TAG` env var:**

### Axis 1 — Postgres schema-per-PR

Each PR-preview deploy gets its own Postgres schema named `pr_<num>`. Migrations run scoped to the schema. Both Prisma's request-path client and the outbox relay's pg pool resolve to the same schema.

**The libpq shim:** node-postgres (used by `@saga-ed/soa-event-outbox`'s OutboxRelay pool) ignores Prisma's `?schema=…` URL parameter. Translation:

```typescript
const dbUrl = new URL(databaseUrl);
const schema = dbUrl.searchParams.get('schema');
const pool = new Pool({
  connectionString: databaseUrl,
  max: 2,
  ...(schema ? { options: `-c search_path=${schema}` } : {}),
});
```

Without the shim, unqualified table names like `FROM outbox_event` fall through to the default search_path, miss per-PR schema tables, and the relay silently no-ops or hits the wrong schema.

This helper should live in `@saga-ed/soa-event-outbox` so the next adopter doesn't reinvent it (see implementation lift in companion work).

**Pool sizing:** the outbox relay pool is dedicated and small (`max=2`). It must not contend with request-path Prisma traffic, especially under preview-environment multi-tenancy where many PRs share a single Postgres instance.

### Axis 2 — RabbitMQ tag-per-PR

When `EVENT_PREVIEW_TAG` is set (e.g., `pr-142`), every exchange, queue, and consumer name gets the tag suffixed:

```typescript
const previewTag = (process.env.EVENT_PREVIEW_TAG ?? '').trim();
const tagged = (name: string): string =>
  previewTag ? `${name}.${previewTag}` : name;

// Publisher side:
new OutboxRelay({ exchange: tagged(IAM_EXCHANGE), ... });
// → 'iam.events' in prod, 'iam.events.pr-142' in preview

// Consumer side:
new EventConsumer({
  exchange: tagged(IAM_EXCHANGE),
  queue: tagged(IAM_USER_PROJECTION_QUEUE),
  consumerTag: tagged('programs-iam-projection'),
  ...
});
```

Both the publisher and consumer side must apply the tag. A consumer in PR-142 that binds to the un-tagged `iam.events` exchange would receive prod traffic.

This helper should live in a place importable by both `@saga-ed/soa-event-outbox` and `@saga-ed/soa-event-consumer` — likely a small new utility export, or duplicated trivially in both packages.

### Cleanup contract on PR close

The combination requires a two-step teardown when a PR closes or merges:

1. **Drop schema:** `DROP SCHEMA IF EXISTS pr_<num> CASCADE` against the shared Postgres.
2. **Delete tagged broker objects:** for each `<name>.pr-<num>` exchange/queue, delete via the Amazon MQ management API.

Without step 2, orphaned exchanges and queues accumulate on the broker, which is cheap until it isn't (Amazon MQ has resource limits). This cleanup is the responsibility of the iac repo's preview-deploy automation; it does not exist yet (see Outstanding work below).

## Why both axes (not just one)

- **DB-only isolation** wouldn't prevent cross-PR routing on the broker. Two PRs publishing to `iam.events` race for the same consumers.
- **Broker-only isolation** wouldn't prevent migration conflicts. Prisma migrations would either run unconditionally (clobbering) or skip (drifting from the per-PR schema layout).
- **Together** they make a PR-preview a fully self-contained eventing stack on shared infrastructure.

## Local-vs-prod divergences

- Production uses `EVENT_PREVIEW_TAG=""` (empty); the `tagged()` helper is a no-op and exchanges/queues use their canonical names.
- Production uses the default Postgres database / public schema (no `?schema=` param). The libpq shim is also a no-op.
- Local dev (single developer compose stack) typically uses no preview tag; behaves like prod.
- CI integration tests can opt into a tag (e.g., `EVENT_PREVIEW_TAG=ci-${RUN_ID}`) for fully isolated runs.

## Outstanding work

- **iac side not yet built:** preview-deploy plumbing (per-PR ALB listener band, ephemeral target group, schema provisioning lambda, broker cleanup hook) is not in iac. Currently only the application-side plumbing exists.
- **Cleanup automation:** application code can read `EVENT_PREVIEW_TAG` but has no responsibility for cleanup. A scheduled lambda or PR-close hook in iac will need to enumerate `*.pr-<closed-num>` exchanges and `pr_<closed-num>` schemas and tear them down.
- **Broker-resource caps:** as PR-preview adoption grows, Amazon MQ exchange/queue counts per broker will need monitoring. Set an alert on broker resource counts; consider a max-PRs-in-preview policy.

## Related artifacts

**Adopter implementations (current source of truth):**
- `apps/node/iam-api/src/inversify.config.ts` (rostering #138) — outbox pool with libpq shim, tagged exchange
- `apps/node/programs-api/src/inversify.config.ts` (program-hub #60) — outbox pool, tagged publisher + consumer
- `apps/node/scheduling-api/src/inversify.config.ts` (program-hub #60) — same pattern, both publisher and multi-exchange consumer

**To be lifted into soa:**
- `@saga-ed/soa-event-outbox` — `createOutboxPool(databaseUrl)` helper exporting the libpq shim
- `@saga-ed/soa-event-outbox` and `@saga-ed/soa-event-consumer` — shared `applyPreviewTag(name)` helper

**Related decisions:**
- `d-broker-choice.md` — RabbitMQ rationale
- `d-consumer-resilience.md` — non-fatal broker startup, idempotent handlers (companion patterns also surfaced by adopters)

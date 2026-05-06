# d-consumer-resilience — Operational patterns for event consumers

**Status:** RESOLVED 2026-05-05, extended 2026-05-06 — Idempotent UPSERT handlers, soft-delete projections (when historical resolution matters), non-fatal broker startup in non-prod, OTel `initTracing` as the first import, **and one queue per event family** (added 2026-05-06 from program-hub #62). Lifted from rostering #138 and program-hub #60/#62 after adopters independently arrived at this set.

**Source PRs:** [rostering #138](https://github.com/saga-ed/rostering/pull/138) (iam-api outbox + iam-events; patterns 1–4) · [program-hub #60](https://github.com/saga-ed/program-hub/pull/60) (programs-api, scheduling-api outbox + projections; patterns 1–4) · [program-hub #62](https://github.com/saga-ed/program-hub/pull/62) (group-projection consumer split — pattern 5)

## Context

`@saga-ed/soa-event-consumer` provides the primitives — Zod-validated handlers, `consumed_events` dedup table, DLQ wiring — but says nothing about the operational shape of a *real* consumer. Both adopters discovered the same set of resilience patterns the hard way:

1. Events arrive out of order (a `user.updated` before a `user.created`).
2. Source aggregates get deleted but downstream rows still need to resolve them (a calendar event referencing a deleted program).
3. The broker is sometimes unavailable; request-path traffic must not stop just because consumers can't connect.
4. OTel must be initialized before *any* module that calls `trace.getTracer()` at module load — otherwise spans silently no-op.

This document codifies the operational pattern set so the next adopter has a checklist instead of a rediscovery.

## The pattern set

### 1. Idempotent UPSERT handlers (out-of-order delivery is the default)

Event ordering is **not guaranteed** even within a single source aggregate, because:

- The outbox relay batches writes and a second-batch row can be acknowledged before a first-batch row that's stuck on a transient broker error.
- Multiple OutboxRelay instances (rare but possible during deploys) can race.
- A consumer's retry queue can deliver an old envelope after a newer one was already processed.

**Convention:** every projection handler must use `INSERT … ON CONFLICT DO UPDATE` (or equivalent UPSERT) so that the projection converges to the correct state regardless of arrival order.

```typescript
// In programs-api iam-projection (program-hub #60):
async handle(_envelope, payload, tx) {
  await tx.query(
    `INSERT INTO user_projection (id, status, created_at, updated_at)
     VALUES ($1::uuid, $2, $3::timestamptz, $3::timestamptz)
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status,
       updated_at = EXCLUDED.updated_at`,
    [payload.id, payload.status, payload.updatedAt],
  );
}
```

If a `user.updated` arrives first, the row is inserted with `status` = updated value. When `user.created` arrives later, ON CONFLICT updates only the fields it owns — the projection has converged.

**Anti-pattern:** straight `INSERT` followed by separate `UPDATE`, with a "row not found" branch. This produces a brittle handler that fails on out-of-order delivery and produces partial state.

### 2. Soft-delete projection rows when historical resolution matters

When a domain `*.deleted` event arrives, the handler has a choice:

- **DELETE the projection row** — clean, but breaks downstream foreign-key resolution.
- **UPDATE … SET deleted_at = now()** — preserves the row for historical lookups.

The right choice depends on whether downstream queries need to resolve references to deleted aggregates. In program-hub #60, scheduling-api's calendar events hold foreign keys to programs; if the program is deleted, the calendar event still needs to render "Program X (deleted)" rather than "Program null". Soft-delete preserves that.

```typescript
// scheduling-api programs-projection (program-hub #60):
const programDeletedHandler: EventHandler<ProgramDeletedV1Payload> = {
  eventType: ProgramDeletedV1.eventType,
  eventVersion: ProgramDeletedV1.eventVersion,
  payloadSchema: ProgramDeletedV1.payloadSchema,
  async handle(_envelope, payload, tx) {
    await tx.query(
      `UPDATE program_projection
       SET deleted_at = $1::timestamptz, updated_at = NOW()
       WHERE id = $2::uuid`,
      [payload.deletedAt, payload.id],
    );
  },
};
```

**When to use hard-DELETE:** when the projection is purely a cache (e.g., a name lookup with no FK references), and downstream queries should treat absence as "doesn't exist." Be explicit in the handler comment which case applies.

#### Decision matrix — soft-delete vs hard-delete projection rows

Pick once per projection table, document the choice in the handler. Tradeoffs:

| Question | Soft-delete (`deleted_at IS NOT NULL`) | Hard-delete (`DELETE FROM`) |
|---|---|---|
| Downstream FKs reference this row? | required | not viable |
| Need to render "Foo (deleted)" in UI? | yes | no |
| Need historical reporting / audit? | yes | no |
| Read-path can simply `WHERE deleted_at IS NULL`? | yes | n/a (row gone) |
| Storage growth concern? | grows monotonically (prune later) | bounded |
| Concurrent re-create event after delete? | UPSERT clears `deleted_at` | INSERT works trivially |
| Out-of-order delivery (delete arrives first, then create)? | needs careful UPSERT | row not found is fine — just INSERT |

**Worked examples from the fleet:**

| Projection | Choice | Why |
|---|---|---|
| scheduling-api `program_projection` (from `programs.program.deleted`) | soft | `calendar_event` rows hold FK; UI shows "Program X (deleted)" |
| program-hub `group_projection` (from `iam.group.deleted`) | soft | enrollment + membership rows hold FK; same reasoning |
| program-hub `iam_user_projection` (cache for displayName lookup, no FK) | hard | pure read cache; absent user = "unknown user" is acceptable |
| hypothetical analytics consumer (denormalized warehouse table, replaces full snapshot daily) | hard | rebuilt nightly; soft-delete adds no value |

**Rule of thumb:** if any other table in the same database holds a foreign-key to this projection, soft-delete. If not, hard-delete is fine and saves storage.

**One subtlety — out-of-order delete-then-create:** if a `*.deleted` event is processed before the `*.created` (rare but possible per pattern 1), the soft-delete `UPDATE` is a no-op (row doesn't exist yet). The subsequent `*.created` `INSERT` should set `deleted_at = NULL` defensively (or use UPSERT with `deleted_at = EXCLUDED.deleted_at`). Hard-delete sidesteps this entirely — the create just inserts.

### 3. Non-fatal broker startup in non-production

Both adopters wrap OutboxRelay and EventConsumer startup in a try/catch that logs but does not throw — except in production:

```typescript
try {
  await connectionManager.connect();
  outboxRelay = container.get<OutboxRelay>('OutboxRelay');
  await outboxRelay.start();
} catch (err) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`OutboxRelay startup failed in production: ${err.message}`);
  }
  logger.warn('OutboxRelay startup failed — events will accumulate, retry on broker reconnect', err);
}
```

**Rationale:** request-path mutations still succeed (they write to the outbox table inside the request transaction). The relay catches up when the broker comes back. Crashing the service on broker unavailability would break dev/staging environments where the broker is more flaky than the service.

**In production, fail loud.** A production service that "soft fails" event publication will accumulate outbox debt invisibly until alerting catches it. The startup crash is the alert.

### 4. OTel initialization MUST be the first import in `main.ts`

`@saga-ed/soa-event-outbox` and `@saga-ed/soa-event-consumer` (and many other packages) call `trace.getTracer()` at module-load time. If OTel has not been initialized when those imports resolve, the tracer is a no-op and no spans are emitted from those modules — for the rest of the process lifetime.

**Convention:** `initTracing(serviceName)` is the *very first statement* in `main.ts`, before any application imports.

```typescript
// CORRECT:
import { initTracing, shutdownTracing } from '@saga-ed/soa-observability';
const tracingHandle = initTracing('iam-api');

// Now everything else can import freely:
import { container } from './inversify.config.js';
import { ConnectionManager } from '@saga-ed/soa-rabbitmq';
// ...

// WRONG:
import { container } from './inversify.config.js'; // imports outbox → grabs no-op tracer
import { initTracing } from '@saga-ed/soa-observability';
initTracing('iam-api'); // too late — tracers were already cached
```

**Symptom of getting it wrong:** spans simply don't appear in Jaeger / X-Ray for outbox publish or consume operations. The HTTP request span shows up; the event-driven hop is invisible. Easy to mis-diagnose as "broker not propagating context."

This footgun should be loud-documented in `@saga-ed/soa-observability`'s README and `d-observability.md` (see follow-ups in companion docs work).

### 5. One consumer queue per event family (isolate poison messages by domain)

When a service consumes events from more than one publisher domain — e.g., programs-api consumes both `iam.*` (group memberships) and `programs.*` (its own group projections) — bind a **separate `EventConsumer` to a separate queue per family**, rather than multiplexing both families through one queue.

**Why this matters:** if a poison message lands in one family, the queue stalls (retries → DLQ, but the front of the queue is held while the offending message is being retried). A multiplexed queue stalls *both* families when only one is sick. A pair of queues isolates the failure.

**Source:** program-hub #62 introduced `GroupProjectionConsumer` on a queue distinct from the existing `IamProjectionConsumer` precisely to prevent group-membership poison messages from blocking iam-projection processing. Earlier program-hub #60 had been single-queue per service; the split happened the moment the service consumed from a second family.

**Rule of thumb:**

> A consumer service should bind one `EventConsumer` per upstream event family it consumes. Two families → two `EventConsumer` instances → two distinct queues. Three families → three.

**When this is overkill:** a service consuming a single family — bind one. Don't pre-split.

**Wiring shape (Inversify):**

```typescript
// container.ts — programs-api
container.bind(EventConsumer)
  .toDynamicValue((ctx) =>
    new EventConsumer({
      queueName: 'programs-api.iam-projection',
      handlers: iamProjectionHandlers,
      ...
    }))
  .whenTargetTagged('family', 'iam');

container.bind(EventConsumer)
  .toDynamicValue((ctx) =>
    new EventConsumer({
      queueName: 'programs-api.group-projection',
      handlers: groupProjectionHandlers,
      ...
    }))
  .whenTargetTagged('family', 'groups');
```

The corresponding README guidance lives in `@saga-ed/soa-event-consumer` (Session A1 adds it). The DLQ topology is per-queue, so each family also gets its own DLQ — alerting fires on the specific family that's sick.

## Operational gaps not yet addressed

- **DLQ alerting:** events that fail repeatedly land on the DLQ but no `events_in_dlq` alert is wired. Adopters should add a Prometheus alert on DLQ depth > 0 sustained, but this is per-service today. A canonical rule template would help.
- **Consumer lag dashboards:** `outbox_unpublished_count` and `consumed_events_count` gauges exist but no shared Grafana dashboard yet captures lag per (publisher, consumer) pair. Defer until a third adopter — pattern is clear once we have it.
- **Schema-version mismatch handling:** consumers fail loudly on `ConsumerVersionMismatch` (good — explicit pin). But there's no documented runbook for "publisher emitted v2, my consumer pinned v1, what now." Should be covered in `d-event-versioning.md` follow-up.
- **Bulk-mutation events:** scheduling-api's `regenerate` and `setHolidays` operations would emit thousands of per-event envelopes. Currently they don't emit at all. Decision-prep moved to its own doc — see `d-bulk-mutation-events.md` (PENDING) for the four-option breakdown.

## Related artifacts

**Adopter implementations (current source of truth):**
- `apps/node/programs-api/src/event-handlers/iam-projection.ts` — UPSERT handlers
- `apps/node/scheduling-api/src/event-handlers/programs-projection.ts` — soft-delete pattern
- `apps/node/{iam,programs,scheduling}-api/src/main.ts` — OTel-first-import + non-fatal startup

**Related decisions:**
- `d-preview-deploy-isolation.md` — companion operational pattern (preview-tag isolation)
- `d-publisher-migration.md` — companion publisher-side patterns
- `d-observability.md` — should be updated to call out the import-order requirement
- `d-event-versioning.md` — schema mismatch handling belongs there

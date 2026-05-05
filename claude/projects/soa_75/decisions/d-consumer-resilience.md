# d-consumer-resilience — Operational patterns for event consumers

**Status:** RESOLVED 2026-05-05 — Idempotent UPSERT handlers, soft-delete projections (when historical resolution matters), non-fatal broker startup in non-prod, OTel `initTracing` as the first import. Lifted from rostering #138 and program-hub #60 after both adopters independently arrived at the same set.

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

## Operational gaps not yet addressed

- **DLQ alerting:** events that fail repeatedly land on the DLQ but no `events_in_dlq` alert is wired. Adopters should add a Prometheus alert on DLQ depth > 0 sustained, but this is per-service today. A canonical rule template would help.
- **Consumer lag dashboards:** `outbox_unpublished_count` and `consumed_events_count` gauges exist but no shared Grafana dashboard yet captures lag per (publisher, consumer) pair. Defer until a third adopter — pattern is clear once we have it.
- **Schema-version mismatch handling:** consumers fail loudly on `ConsumerVersionMismatch` (good — explicit pin). But there's no documented runbook for "publisher emitted v2, my consumer pinned v1, what now." Should be covered in `d-event-versioning.md` follow-up.
- **Bulk-mutation events:** scheduling-api's `regenerate` and `setHolidays` operations would emit thousands of per-event envelopes. Currently they don't emit at all. Open question: bulk summary events (`schedule.regenerated.v1` carrying a count + range) vs per-event envelopes vs neither.

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

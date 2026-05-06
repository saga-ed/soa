# d-publisher-migration — Migration patterns for outbox publishers

**Status:** RESOLVED 2026-05-05 — Interactive `$transaction` for outbox writes, wire-format enum mapping with runtime validation, dual-write coexistence path (when migrating off a legacy outbox), bulk-mutation strategy still open. Lifted from rostering #138 and program-hub #60.

**Source PRs:** [rostering #138](https://github.com/saga-ed/rostering/pull/138) (iam-api `$transaction` migration + dual-write with legacy `event_outbox`) · [program-hub #60](https://github.com/saga-ed/program-hub/pull/60) (programs-api + scheduling-api migration; bulk-mutation gap surfaced by scheduling-api `setHolidays` / `regenerate`)

## Context

Adding outbox publishing to an existing service is more invasive than the POC suggests. The POC's services are greenfield: every mutation already runs inside `prisma.$transaction(async (tx) => { … })` and the outbox write slots in cleanly. Real services have:

- `prisma.$transaction([…])` array form (no `tx` parameter exposed)
- Domain enums that don't match the wire format you want to publish
- Existing legacy outbox tables / event-emitter services that must coexist during cutover
- Bulk operations that would emit thousands of events if naively wired

This doc captures the migration patterns adopters used. Treat it as a checklist for the next service onboarding to outbox publishing.

## The migration patterns

### 1. Array-form `$transaction` → interactive form

`writeOutbox(tx, envelope)` requires the `tx` parameter from Prisma's interactive transaction. The array form doesn't expose one. Refactor every mutation that needs to publish:

```typescript
// BEFORE (array form — works with Prisma but no tx access):
await this.prisma.$transaction([
  this.prisma.calendarEvent.update({ where: { id }, data: { cancelled: true } }),
  this.prisma.recurrenceRule.update({ where: { id: ruleId }, data: { exdates: { push: date } } }),
]);

// AFTER (interactive form — tx available for writeOutbox):
await this.prisma.$transaction(async (tx) => {
  await tx.calendarEvent.update({ where: { id }, data: { cancelled: true } });
  await tx.recurrenceRule.update({ where: { id: ruleId }, data: { exdates: { push: date } } });
  await writeOutbox(tx, buildEnvelope({
    eventType: CalendarEventCancelledV1.eventType,
    eventVersion: CalendarEventCancelledV1.eventVersion,
    aggregateType: 'calendar_event',
    aggregateId: id,
    payload: CalendarEventCancelledV1.payloadSchema.parse({ id, ... }),
  }));
});
```

**Performance equivalence:** both forms serialize against the same row locks. The interactive form is slightly more chatty over the wire (multiple round-trips vs one batched statement) but the difference is negligible for service-layer mutations.

**Source:** scheduling-api `cancelEvent` (program-hub #60).

### 2. Wire-format enum mapping with runtime validation

Domain enums in the database often differ from the wire format you want consumers to receive. iam-api's UserStatus is `ACTIVE | INACTIVE | DELETED` (uppercase, Prisma convention); the wire schema in `@saga-ed/iam-events` declares `'active' | 'inactive' | 'deleted'` (lowercase, JSON convention).

**Convention:** a small mapping helper at the publisher edge, with a runtime fallback that throws on unknown values:

```typescript
// In rostering iam-api user.data.ts:
function userStatusOnWire(status: string): UserStatusOnWire {
  const lower = status.toLowerCase();
  if (lower === 'active' || lower === 'inactive' || lower === 'deleted') {
    return lower as UserStatusOnWire;
  }
  throw new Error(`Unknown user status: ${status}`);
}
```

**Rationale:** the throw is a future-proofing tripwire. If a developer later adds `SUSPENDED` to the DB enum without updating the wire mapping or the wire schema, the *publish* fails — loudly, before a malformed event reaches the bus. The alternative (a silent string passthrough) would publish `"SUSPENDED"` to consumers who can't decode it.

**Where to put it:** alongside the publisher's data layer (e.g., `*.data.ts`), not in the events package. The events package is the wire contract; the mapping is publisher-internal.

### 3. Dual-write coexistence with a legacy outbox

When migrating off a pre-existing outbox / event-emitter system, write to *both* tables in the same transaction until consumers have moved over:

```typescript
// In rostering iam-api (during migration window):
await prisma.$transaction(async (tx) => {
  // Domain mutation:
  const created = await tx.user.create({ data: {...} });

  // Legacy outbox (old in-process consumers):
  await tx.eventOutbox.create({ data: {
    eventName: 'user.created',
    payload: legacyShape(created),
  }});

  // New outbox (cross-service RabbitMQ):
  await writeOutbox(tx as unknown as SqlTagExecutor, buildEnvelope({
    eventType: IamUserCreatedV1.eventType,
    eventVersion: IamUserCreatedV1.eventVersion,
    aggregateType: 'user',
    aggregateId: created.id,
    payload: IamUserCreatedV1.payloadSchema.parse({ id: created.id, status: created.status, createdAt: created.createdAt }),
  }));
});
```

**Both writes ride the same `prisma.$transaction`** so atomicity holds: either both event records are written or neither. The migration plan is then:

1. Phase 1 (current — rostering #138): dual-write, no consumers cut over
2. Phase 2: cut over consumers one-at-a-time to the new bus
3. Phase 3: stop writing to the legacy outbox, retire it

**Don't dual-write forever.** Set a target retirement date when starting Phase 1; otherwise the dual-write becomes infrastructure debt indistinguishable from a feature.

### 4. Bulk-mutation strategy (OPEN)

scheduling-api's `setHolidays` and `regenerate` operations modify thousands of calendar events per call. Naively emitting per-event envelopes would:

- Overwhelm consumers with bursts (10k+ messages in seconds)
- Produce huge outbox tables and slow the relay
- Make consumer projections rebuild slowly

Currently, **these bulk operations don't emit anything**. This is a deliberate deferral. Three options, all unresolved:

| Option | Pro | Con |
|---|---|---|
| **Per-event envelopes anyway** | Consumers get full fidelity | Burst overload, large outbox |
| **Bulk summary event** (e.g., `schedule.regenerated.v1` with `{rangeStart, rangeEnd, count}`) | Single envelope, consumers re-fetch range | Loses per-event detail; consumers need a re-fetch path |
| **Don't emit; consumers poll** | Simplest | Stale projections; defeats the point of event-driven |

**Recommendation:** when the third adopter encounters a bulk operation, design around bulk summary events with an explicit re-fetch contract (the consumer hits the publisher's read API to load affected rows). Document the pattern as `d-bulk-mutation-events.md` at that point.

## Other migration considerations

### OTel initialization order

Already covered in `d-consumer-resilience.md`, but applies equally to publisher services: `initTracing(serviceName)` must be the first import in `main.ts`. Outbox-relay spans depend on it.

### Outbox pool sizing

Use a dedicated `max=2` pool for the OutboxRelay, separate from request-path Prisma. See `d-preview-deploy-isolation.md` for the helper that bundles this with the libpq schema shim.

### Per-publisher event packages

Each publishing service owns a per-family events package: `@saga-ed/iam-events`, `@saga-ed/programs-events`, `@saga-ed/scheduling-events`. The package declares the wire schemas (Zod), the event type constants, and the version pin. See `d-event-package-shape.md`.

## Related artifacts

**Adopter implementations:**
- `apps/node/iam-api/src/sectors/user/user.data.ts` (rostering #138) — dual-write + enum mapping
- `apps/node/scheduling-api/src/services/calendar-events.service.ts` (program-hub #60) — interactive `$transaction` refactor
- `apps/node/programs-api/src/services/*` (program-hub #60) — greenfield publisher (no migration needed)

**Related decisions:**
- `d-preview-deploy-isolation.md` — outbox pool helper
- `d-consumer-resilience.md` — companion consumer-side patterns
- `d-event-package-shape.md` — events-package conventions
- `d-event-versioning.md` — schema versioning rules that the wire mapping must respect

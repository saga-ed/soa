# @saga-ed/soa-event-consumer

Idempotent RabbitMQ consumer with a `consumed_events` dedup table, Zod-
validated handlers, OTel trace propagation, and DLQ wiring. Pairs with
`@saga-ed/soa-event-outbox` on the publisher side and
`@saga-ed/soa-event-envelope` for the on-wire schema.

```typescript
import { EventConsumer, type EventHandler } from '@saga-ed/soa-event-consumer';
```

## Queue topology — one consumer per event family

**Rule:** if a service consumes more than one event family (e.g. `iam.*`
and `programs.*`), bind one `EventConsumer` per family to a separate
queue. Don't multiplex families on a single queue.

A poison message in family A — a payload that fails validation, a handler
that throws on every retry, a malformed envelope — backs up against the
queue's prefetch. Anything else on that queue waits behind it. If `iam.*`
and `programs.*` share a queue, an `iam.*` poison stalls `programs.*`
projections too.

Splitting per family bounds the blast radius: a poison in `iam.*` blocks
only `iam.*` consumption; the `programs.*` projection keeps converging.
Each `EventConsumer` holds its own `consumed_events` row range and
prefetch budget, so the per-queue retry storm doesn't bleed into the
other family.

```typescript
const iamConsumer = new EventConsumer({
    queueName: 'programs-api.iam-projection',
    handlers: iamProjectionHandlers,
    /* … */
});
const programsConsumer = new EventConsumer({
    queueName: 'programs-api.programs-projection',
    handlers: programsProjectionHandlers,
    /* … */
});
```

Canonical example: `program-hub` PR #62, which split
`GroupProjectionConsumer` from `IamProjectionConsumer` after a poison
message in one family stalled the other.

The decision-doc rule lives in
[`d-consumer-resilience.md`](../../../claude/projects/soa_75/decisions/d-consumer-resilience.md)
pattern 5.

## Idempotent UPSERT handlers — projection pattern

**Rule:** every projection handler must use `INSERT … ON CONFLICT DO UPDATE`
(or equivalent UPSERT). Never blind `INSERT` followed by `UPDATE`.

Event ordering is **not guaranteed**, even within a single source aggregate:

- The outbox relay batches writes; second-batch rows can ack before a
  first-batch row stuck on a transient broker error.
- Multiple `OutboxRelay` instances during a deploy can race.
- A consumer's retry queue can deliver an old envelope after a newer one
  was already processed.

UPSERT lets the projection converge regardless of arrival order. The
`consumed_events` dedup table guarantees each event applies at most
once; UPSERT guarantees the *resulting state* is correct even when events
arrive out of order.

### Worked example

```typescript
const iamUserUpdatedHandler: EventHandler<IamUserUpdatedV1Payload> = {
    eventType: IamUserUpdatedV1.eventType,
    eventVersion: IamUserUpdatedV1.eventVersion,
    payloadSchema: IamUserUpdatedV1.payloadSchema,
    async handle(_envelope, payload, tx) {
        // UPSERT: if `user.updated` arrives before `user.created` (rare
        // but possible under broker retries), insert a skeleton row with
        // the most recent `updated_at`. The later `user.created` event's
        // ON CONFLICT will fix `created_at` without clobbering `updated_at`.
        await tx.query(
            `INSERT INTO user_projection (id, status, created_at, updated_at)
             VALUES ($1::uuid, $2, $3::timestamptz, $3::timestamptz)
             ON CONFLICT (id) DO UPDATE SET
                 status = EXCLUDED.status,
                 updated_at = EXCLUDED.updated_at`,
            [payload.id, payload.status, payload.updatedAt],
        );
    },
};
```

### Anti-pattern

```typescript
// DON'T: brittle on out-of-order delivery and produces partial state.
async handle(_envelope, payload, tx) {
    const existing = await tx.query('SELECT 1 FROM user_projection WHERE id = $1', [payload.id]);
    if (existing.rowCount === 0) {
        await tx.query('INSERT INTO user_projection (...) VALUES (...)', [...]);
    } else {
        await tx.query('UPDATE user_projection SET ... WHERE id = $1', [...]);
    }
}
```

### A note on column choice in `ON CONFLICT DO UPDATE`

Per-handler, set only the columns that handler *owns*. A `*.updated`
handler should not overwrite `created_at`; a `*.created` handler should
not overwrite a more recent `updated_at`. The convergent steady state is
each event leaving its imprint and nothing more.

For soft-delete vs hard-delete projection rows on `*.deleted` events,
see
[`d-consumer-resilience.md`](../../../claude/projects/soa_75/decisions/d-consumer-resilience.md)
pattern 2 (decision matrix + worked examples).

## See also

- `@saga-ed/soa-event-outbox` — transactional outbox + relay.
- `@saga-ed/soa-event-envelope` — Zod envelope schema (`type`, `version`,
  `traceparent`, `payload`).
- `@saga-ed/soa-event-test-harness` — Postgres + RabbitMQ container helpers
  + `id()` UUID-shaped seed for fixture IDs.
- `@saga-ed/soa-rabbitmq` — `ConnectionManager` with `failureMode` for
  broker-startup behavior.

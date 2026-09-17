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

## Recovering dead letters — targeted replay

When a consumer dead-letters messages for a reason that has since been
fixed (a deploy overlap, a database deadlock, a dependency that was
briefly down), somebody has to put them back. Doing that through the
RabbitMQ management UI needs the broker admin credential and network
reach into the VPC, which almost nobody has.

`inspectDeadLetterQueue` and `replayDeadLetters` do it over plain AMQP on
the service's **own** broker credentials — no management HTTP API, no
admin secret.

```typescript
import {
    DLQ_REPLAY_CLI_OPTIONS,
    filterFromCliValues,
    formatReplayReport,
    replayDeadLetters,
} from '@saga-ed/soa-event-consumer';

const args = filterFromCliValues(values, {
    // The types THIS service has decided are safe to re-run. See
    // "what not to replay" below — this list is a judgement, not a default.
    eventTypes: ['iam.persona_assignment.added', 'iam.persona_assignment.removed'],
});

const result = await replayDeadLetters({
    connectionManager,          // @saga-ed/soa-rabbitmq ConnectionManager
    dlqQueue: 'iam.events.dlq.queue',
    targetQueue: 'coach-api.instance-creation',
    filter: args.filter,
    approve: args.approve,      // without this it is a dry run
    confirm: args.confirm,      // the value the dry run printed
    logger,
});
console.log(formatReplayReport(result));

// A publish failure is REPORTED, not thrown — the run stops where it stands and
// tells you which messages went. Map it to an exit code, or a runbook step that
// half-succeeded will look like a clean run to whatever called it.
if (result.failure) process.exitCode = 1;
// A dry run that selected something: 2, so "found work" is distinguishable
// from "nothing to do" without parsing the report.
else if (!result.approved && result.selection.selected.length > 0) process.exitCode = 2;
```

A refusal — no filter, a stale confirmation, a truncated scan — throws
`DlqReplayRefusedError` instead, carrying a `reason` a caller can map to
its own exit code without having to tell it apart from a broker error.

### Nothing is ever acked or deleted

Both operations read with `basic.get(noAck: false)` and requeue
everything at the end, so the dead-letter queue is left exactly as
found. A replay **publishes a copy** to the target queue and leaves the
original in place. A botched run can therefore duplicate a message
(harmless — see below) but can never lose one. **Emptying the DLQ stays a
broker-admin action** and is deliberately not something this tool can do.

### Targeting is mandatory

`validateFilter` refuses to run unless the caller supplies at least one
of:

| Filter | Flag | Effect |
|---|---|---|
| `eventTypes` | `--event-type` (repeatable) | Exact match on `envelope.eventType` |
| `eventIds` | `--event-id` (repeatable) | Exact match on `envelope.eventId` |
| `deadLetteredAfter` / `deadLetteredBefore` | `--since` / `--until` | Window on the most recent `x-death` time |

Two more narrow the run but **cannot stand in for a target**:

- `firstDeathQueue` (`--first-death-queue`) defaults to the target queue,
  so it always has a value and could never refuse anything.
- `maxMessages` (`--max`) defaults to 25 and is capped at 500. A cap
  bounds the damage; it does not say what you meant to select.

A replay additionally needs `approve` **and** a `confirm` value that the
dry run printed. The confirmation is a digest of the destination plus the
ordered event ids selected; the approve recomputes it from a fresh read
of the queue and refuses if anything has changed since the dry run.

### Safe with a shared dead-letter queue

Several services dead-letter into one queue (every consumer of
`iam.events` shares `iam.events.dlq.queue`), and a service's broker user
can technically read all of it. Every filter runs **before** anything is
published, and a message whose first death was another service's queue is
never republished.

Replay publishes to the **default exchange** with the target queue's name
as the routing key, so the copy reaches that one queue and nowhere else —
the difference between "put my 15 messages back" and "re-broadcast 15
events to everyone who was listening at the time".

### Why replaying into an EventConsumer is safe

`processEnvelope` inserts `(consumer_name, event_id)` into
`consumed_events` in the **same transaction** as the handler's projection
write, and both commit or both roll back. So:

- An event that already succeeded has a committed row. The replayed copy
  hits `ON CONFLICT DO NOTHING`, inserts nothing, and is acked without
  running the handler. Redelivery is a no-op, not a double-apply.
- An event that **failed** has no row — the insert rolled back with the
  handler. The replayed copy runs the handler as if it were new.

### What is NOT safe to replay generically

Events that **replace a whole projection** rather than amend it: a
persona's full permission set, a full policy set, "here is the complete
list of X for aggregate Y". If a newer one already landed, replaying the
older one rewinds the projection to a stale snapshot — and
`consumed_events` will not stop it, because the old event has its own
event id and has never been processed, so it looks brand new.
`consumed_events` gives at-most-once-per-event, **not** ordering.

This package deliberately does not guess which types those are; guessing
wrong is silent data corruption. The `eventTypes` allowlist is how the
service that owns the handlers states which types it is willing to have
re-run. For coach-api that is the two `persona_assignment` events (each
opens or closes one interval row, keyed on the iam membership row id, and
then reconciles) and **not** `persona_definition.upserted` or
`persona_policies.upserted`, which carry a whole permission or policy set.

Two further messages are never selected, whatever the filter says:

- a body that is not a parseable envelope — there is no event type to
  check and no event id to dedup on, and the consumer would poison-nack
  it straight back;
- a message with no readable death time, when a time window was given.

### Integration tests

The unit tests fake the channel. `src/__tests__/dlq-replay.int.test.ts`
runs the same paths against a real broker — including what RabbitMQ
actually writes into `x-death`, and that the DLQ really is unchanged
afterwards:

```bash
docker run -d --rm --name dlq-replay-rabbit -p 45672:5672 rabbitmq:3-management
pnpm --filter @saga-ed/soa-event-consumer test:int
```

Point `RABBITMQ_TEST_URL` elsewhere to use an existing broker.

## See also

- `@saga-ed/soa-event-outbox` — transactional outbox + relay.
- `@saga-ed/soa-event-envelope` — Zod envelope schema (`type`, `version`,
  `traceparent`, `payload`).
- `@saga-ed/soa-event-test-harness` — Postgres + RabbitMQ container helpers
  + `id()` UUID-shaped seed for fixture IDs.
- `@saga-ed/soa-rabbitmq` — `ConnectionManager` with `failureMode` for
  broker-startup behavior.

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

A service's own entry point is the whole thing:

```typescript
import { parseArgs } from 'node:util';
import { DLQ_REPLAY_CLI_OPTIONS, runDlqReplayCli } from '@saga-ed/soa-event-consumer';

const { values } = parseArgs({ options: DLQ_REPLAY_CLI_OPTIONS });

process.exitCode = await runDlqReplayCli({
    values,
    connection: connectionManager, // @saga-ed/soa-rabbitmq ConnectionManager
    dlqQueue: 'iam.events.dlq.queue',
    targetQueue: 'coach-api.instance-creation',
    defaults: {
        // The types THIS service has decided are safe to re-run. See
        // "what not to replay" below — this list is a judgement, not a default.
        eventTypes: ['iam.persona_assignment.added', 'iam.persona_assignment.removed'],
    },
    logger,
});
```

`runDlqReplayCli` prints the report and returns the exit code, so a
runbook step that half-succeeded cannot look like a clean run to whatever
called it:

| Code | Meaning |
|---|---|
| `0` | Did what was asked; nothing outstanding. |
| `1` | A refusal, or a replay that stopped on a failed publish. |
| `2` | A dry run that selected messages — work found, nothing published. |

A refusal — no filter, a stale confirmation, a truncated scan — is
printed with the `reason` that `DlqReplayRefusedError` carries, and exits
`1`. Every refusal is written to leave the operator with a next step; see
"the three refusals an approve passes" below. Anything else (a broker
error, a bug) propagates with its stack.

**It closes the connection.** `runDlqReplayCli` takes ownership of the
connection it is given and closes it on every path, including refusals,
so the process ends by itself. This matters more than it sounds: an open
AMQP socket keeps Node's event loop alive, so a CLI that merely finishes
its work just sits there, and `process.exit()` to get around that
discards whatever else was still pending. Don't pass a connection the
process still needs.

Call `inspectDeadLetterQueue` / `replayDeadLetters` directly instead when
the caller is a long-running service that owns its connection — those
take a `DlqChannelSource`, which has no `close()`, precisely so they
cannot close somebody else's connection.

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

`runDlqReplayCli`'s `defaults.eventTypes` fills `eventTypes` when the
operator names none, so it **does** count as a target. Through a
service's CLI, a run with no flags is therefore not refused: it selects
that service's own dead letters of its allowed types, oldest first, up to
`--max`, and still needs the confirmation to publish. Name the incident
with a window or ids anyway.

A replay additionally needs `approve` **and** a `confirm` value that the
dry run printed. The confirmation is a short digest of the destination
plus the **sorted** event ids selected; the approve recomputes it from a
fresh read of the queue and refuses if anything has changed since the dry
run.

The dry-run report is the **only** place that value is printed. A
mismatch echoes back what you supplied and does not print the current
one, and nothing logs it — otherwise `--approve --confirm anything` would
be a way of fetching it, and the next command would publish with nobody
having read a report. Reading the report is the whole point of the step.

### Which messages get picked does not depend on queue order

A scan holds every message it reads unacked and requeues the lot at the
end, so the approve is always reading a queue the dry run just
reshuffled. Nothing is allowed to depend on that order:

- the `--max` cap sorts the matches by **death time, then event id**, and
  keeps the oldest — so two runs over the same messages pick the same
  ones, in the same order, however they came off the queue;
- the replay publishes in that order, which is also the right order to
  put events back in;
- the confirmation hashes the ids sorted, so the same set always hashes
  the same.

Without all three, more matches than `--max` produced a different
selection each run, a different confirmation each run, and an approve
refused as "the queue has changed" that no amount of retrying could
clear.

**A cap that bit does not advance on a re-run.** Nothing is ever acked,
so the originals are still on the dead-letter queue afterwards and the
same command selects the same oldest batch again. To reach the rest,
raise `--max` or move `--since` past the batch you just replayed. The
report says so whenever it reports an `over-max` skip.

### The three refusals an approve passes, in order

`scan-truncated`, then `nothing-selected`, then `confirmation-mismatch`.
The order is deliberate and each one has to leave the operator with
something they can do:

1. **`scan-truncated`** — the scan stopped before the end of the queue,
   so this run saw only part of it and a different run would select
   something else. Checked first: otherwise the mismatch below fires on
   every attempt, says the queue changed when nothing has, and hides the
   refusal that explains what to do. The message names how much of the
   queue was read, and either asks for a bigger `--scan-limit` when one
   would reach or points at `--event-id` when none would.
2. **`nothing-selected`** — the filter matched nothing. Carries the skip
   counts (`3 not-target-queue, 1 event-type-not-allowed`) so the
   refusal, which prints no report, still explains itself.
3. **`confirmation-mismatch`** — the guard every publish passes. Last,
   because it is only meaningful once the selection is reproducible and
   non-empty.

### A queue too deep to scan

`--scan-limit` is capped at `SCAN_LIMIT_CEILING` (10,000): the cap bounds
what one run holds unacked, on this side and on the broker, during
exactly the incident that made the queue deep. So "raise `--scan-limit`
past the queue depth" is advice that can run out.

There is one way through that works at any depth. **When the filter names
`eventIds` and every one of them was selected, exactly once, a truncated
scan is allowed to proceed.** The selected set is then the list the
operator typed, one message per id.

The guarantee is worth stating precisely, because the loose version is
not true. Any two runs that are **allowed through** select the same
messages and mint the same confirmation. A run that happens to see a
second copy of a named id does not quietly select something different —
it refuses, and names the id. So the outcomes are "same answer" or "a
refusal that says why", never "a different answer that looks the same".

Both halves of the rule matter. A named id that was not found means
another copy may be sitting outside the part of the queue this run read.
A named id selected **twice** means the queue holds more than one copy —
which this tool creates itself, when a replayed copy fails again and
dead-letters next to the original — and then one run could hash one copy
and another two. Either way the run is refused and the message names the
ids concerned.

The verdict and those ids come from one place, `DlqSelection.namedIdCoverage`,
so the refusal cannot contradict the rule that raised it, and the dry
run's "an approve is allowed" line cannot promise something the approve
then refuses.

If the messages you need are not in the part of the queue a scan can
reach at all, that is past what a targeted replay can do: it needs a
broker-admin drain or a purpose-built backfill, and the refusal says so
rather than sending you round the loop again.

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

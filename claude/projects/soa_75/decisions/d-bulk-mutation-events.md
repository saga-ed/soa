# d-bulk-mutation-events — How to publish events from bulk mutations

**Status:** PENDING — four options below; pick one before scheduling-api's `setHolidays` / `regenerate` paths cut over to outbox publishing. Forced by the third adopter; same shape will recur in admissions / ledger fan-outs.

**Source PRs / triggers:** [program-hub #60](https://github.com/saga-ed/program-hub/pull/60) — scheduling-api's bulk operations are wired through outbox-publishing infrastructure but the `setHolidays` and `regenerate` paths currently emit **nothing** (deliberate deferral pending this decision).

**Related:** `d-publisher-migration.md` § 4 (which sketches the same three options at lower resolution and points at this doc).

## Context

scheduling-api has two operations that mutate hundreds-to-thousands of `calendar_event` rows per call:

- **`setHolidays`** — for a given school + date range, mark every regularly-scheduled session on a holiday date as cancelled. Typical scope: ~500 events per school year × ~20 schools = up to ~10k mutations per call.
- **`regenerate`** — when a schedule template changes, drop and re-create every materialized event in the affected window. Typical scope: 5k–20k mutations.

Naively wired through `writeOutbox(tx, ...)` per row, each call would write thousands of outbox rows in one transaction, then the relay would publish thousands of messages to RabbitMQ in a tight burst. The pattern is symmetric to other adopters' bulk paths (admissions roll-forward, ledger end-of-month posting) so whatever this picks becomes the fleet convention.

The three failure modes to avoid:

1. **Broker burst** — RabbitMQ accepts bursts but consumers and downstream queues don't drain at burst speed. Per-PR preview brokers will stall; production AWS MQ will throttle.
2. **Outbox bloat** — single transaction with 10k inserts holds row locks for seconds; relay falls behind for minutes; outbox table grows hundreds of MB before pruning.
3. **Stale consumers** — if events are skipped, projections drift from publisher state and read-API consumers (like programs-api `/v2`) return stale data without noticing.

A "good" answer keeps consumers eventually consistent with the publisher, doesn't blow up the broker, and doesn't reintroduce the synchronous coupling we're moving away from.

## Options

### A. Per-event envelopes (status-quo emit-everything)

Every row mutation in the bulk path writes one outbox envelope, identical to how single-row mutations work.

**How it works.** `setHolidays` iterates affected events, calls `writeOutbox(tx, ...)` per cancellation. Outbox table gains 10k rows. Relay batches and publishes them at its configured rate (currently ~100 msg/s per adopter).

**Pros:**
- Maximum semantic fidelity — consumers see every state change with full context
- Idempotency works trivially per-row (UPSERT by `aggregateId`)
- Per-aggregate ordering preserved via outbox sequence
- No new event-shape vocabulary to design — same `calendar_event.cancelled.v1` we already have
- Trivial to reason about: "every change emits"; no "did this path emit?" branching in consumer minds

**Cons:**
- Broker burst: 10k messages × ~3KB envelope ≈ 30MB published in seconds. AWS MQ throttle kicks in around 200MB/s aggregate.
- Outbox transaction holds locks while inserting 10k rows; concurrent single-row mutations queue.
- Relay falls behind: at 100 msg/s, a 10k burst takes ~100 seconds to drain.
- Consumer projection rebuild during burst is observably laggy.
- DLQ inflation if the burst contains any poison rows — debugging 10k similar events is painful.

**Mitigations available** (all real, all add complexity):
- Per-publisher rate limit at relay (Option D below is essentially this formalized)
- Larger consumer prefetch + parallelism (helps but creates own ordering issues)
- Dedicated bulk queue for burst-tolerant consumers

**When this is right:** consumer must take per-row side effects (audit log, billing posting, external notification per event). Anything where collapsing N rows into 1 envelope loses information consumers need.

### B. Bulk-summary event with re-fetch contract

Emit one envelope per bulk operation describing the **scope** of the change (not the rows). Consumers receive it, then call back to the publisher's read API to fetch the affected rows.

**How it works.** `setHolidays` runs the mutations as one transaction, then writes a single outbox row:

```typescript
// inside the bulk-mutation $transaction:
await writeOutbox(tx, buildEnvelope({
  eventType: ScheduleBulkRegeneratedV1.eventType,
  eventVersion: 1,
  aggregateType: 'school_schedule',
  aggregateId: schoolId,
  payload: {
    scope: { schoolId, schoolYear, dateRange: [start, end] },
    operationKind: 'set_holidays',
    affectedCount: 478,
    snapshotVersion: 'sch_2026_03_05T18_22Z',
  },
}));
```

Consumer handler receives this and calls `GET /v1/calendar-events?school={id}&from=...&to=...&snapshotVersion=sch_...` to load the new state. The `snapshotVersion` pin guarantees the consumer fetches a coherent slice (not a slice mid-mutated by another concurrent bulk op).

**Pros:**
- Predictable broker load: 1 message per bulk op regardless of scope
- Outbox stays small; relay never falls behind on bulk paths
- Naturally aligns with how bulk operations are *thought* about ("we regenerated school 5's spring schedule")
- Fits with the consumer-reconciliation pattern admissions and ledger already use for end-of-period flows

**Cons:**
- **Reintroduces synchronous coupling at the consumer side** — consumer makes an HTTP call back to publisher. If publisher is down/slow, consumer falls behind. Defeats some of the point of event-driven decoupling.
- Consumer needs a re-fetch endpoint and a snapshot-version concept; not free to build
- Idempotency is more subtle — what if the consumer fetches mid-mutation of a *next* bulk op? Hence the `snapshotVersion` pin, which the publisher must implement
- Loses per-row observability — can't tell from the event log which specific events changed
- Two-tier event model (per-row + bulk-summary) means consumer code must handle both

**When this is right:** consumer is a read-model projection (programs-api `/v2`, ads-adm-api dashboards) that materializes "current state of schedule for school X". Re-fetching a window is cheap and the consumer doesn't care about per-row diffs.

### C. Don't emit at all (skip bulk paths)

Bulk paths bypass the outbox entirely. Single-row mutations still emit; only `setHolidays` / `regenerate` do not.

**How it works.** No outbox writes inside the bulk transaction. Consumers eventually pick up the new state via some other channel — periodic reconciliation, manual refresh, or cache TTL expiry.

**Pros:**
- Zero broker impact
- No new code paths or contracts
- Hard to argue with simplicity

**Cons:**
- **Consumers stale forever** for the data the bulk path mutated, with no signal that a refresh is needed
- Defeats the event-driven model for any consumer that actually cares about scheduling data — and `/v2` enrollment-tree (program-hub #62) does
- Forces every consumer to build its own "is this stale?" detection (TTL, `If-Modified-Since`, manual refresh)
- Operationally invisible — no event log shows the bulk ops happened from a consumer's view
- Encourages per-consumer hacks: "we just refresh the page" / "we cache for 5 min" — accumulates as tech debt fast

**When this is right:** the bulk path mutates data **no consumer projection cares about**. (For scheduling-api this isn't true — programs-api/`v2` does care.) Or paired with periodic full-state re-sync events as a safety net (which is essentially a degenerate version of Option B).

### D. Per-event envelopes with relay-side rate limiting

Same as Option A in *what* gets written — per-row envelopes — but the relay enforces a per-publisher rate cap and queues the rest.

**How it works.** `OutboxRelay` keeps Option A's emit-everything pattern. The relay reads `max_outbox_publish_rate` from config (e.g., 200 msg/s). When the outbox grows faster than that, relay polls more aggressively but its publish rate stays bounded; the outbox just stays large until drained. Bulk operations finish their transaction quickly; the broker burst is smeared over minutes instead of seconds.

**Pros:**
- Keeps semantic fidelity of Option A (every change is a separate event)
- Bounded broker burst — predictable for capacity planning
- No new event vocabulary; consumer code unchanged from current single-row pattern
- Cap is a knob — adopters with bigger headroom raise it

**Cons:**
- Relay becomes more complex: rate limiter, lag metrics, alerting on sustained lag
- Outbox table can grow large during/after a bulk op (10k rows draining at 200/s ≈ 50s of backlog) — but that's OK, postgres handles it
- Consumers see eventual consistency *delayed* by the rate-cap drain time. If a user does `setHolidays` then immediately reads through a consumer, they see partial state until the relay drains.
- Doesn't help if the consumer is the actual bottleneck (it just shifts the queue from broker to outbox)

**When this is right:** Option A is the preferred semantic model but broker burst is the only blocker. This is essentially Option A with a backstop.

### E. Hybrid — bulk-summary plus per-row in payload (mentioned, not recommended)

One envelope per bulk operation, with per-row diffs included in the payload. Consumer iterates the payload.

**Why mention this:** technically combines A's fidelity with B's burst behavior. **Why not recommended:** RabbitMQ message-size limits (default 128MB but practical sweet spot is <1MB). 10k cancellation diffs at ~200B each = 2MB; manageable but already past the practical sweet spot. 50k diffs is hard. AWS MQ behavior is undefined past 5MB. Also: payload validation cost (Zod parsing 10k subrecords) shifts cost from broker to producer/consumer. Cleaner to just use D.

## Decision matrix

| Dimension | A (per-event) | B (bulk-summary + re-fetch) | C (skip) | D (per-event + rate cap) |
|---|---|---|---|---|
| Broker burst | high | tiny | none | bounded |
| Outbox size during op | 10k rows | 1 row | 0 | 10k rows (drains over min) |
| Per-row fidelity | full | none (consumers re-fetch) | none | full |
| Consumer freshness | minutes (lag) | seconds | "stale forever" | minutes (lag) |
| Reintroduces sync coupling? | no | yes (consumer → publisher HTTP) | no | no |
| New publisher work | none | re-fetch endpoint + snapshot-version | none | rate-cap config + metric |
| New consumer work | none | summary handler + re-fetch | none | none |
| Idempotency complexity | trivial (UPSERT per row) | non-trivial (snapshot pin) | n/a | trivial |
| Observability | per-row trail | per-op trail | none | per-row trail |
| Fits read-model consumer | OK | great | poor | OK |
| Fits side-effect consumer | great | poor (lose per-row) | poor | great |

## Recommendation criteria

The right answer depends on consumer type:

- **All bulk-affected data is consumed only as read-model projections** (programs-api `/v2` is the live example) → **Option B**. Consumers naturally re-fetch on refresh anyway; the snapshot-version pin just makes that fetch coherent.
- **Any consumer takes per-row side effects** (audit log, billing post, notification per row) → **Option D**. Option A's broker burst is the only real blocker; cap it. Option B's information loss is unrecoverable for these consumers.
- **No consumer cares** → Option C, but verify by surveying consumers; defaulting to skip is dangerous.

For scheduling-api specifically: programs-api `/v2` is read-model only (Option B fit), but the scheduling-events catalog should anticipate future side-effect consumers (audit, billing). A defensible choice is **D as default, with B available** for explicit large-scope ops where consumers opt-in to the bulk-summary contract.

The deferred third option — start with D, only design B if a real burst overwhelms the cap — is also defensible and pushes the decision down the road one more adopter.

## Open questions for Seth

1. **Consumer survey.** Which consumers of `calendar_event.*` need per-row fidelity vs. read-model freshness? programs-api `/v2` is the only one we know is real today; are admissions / ads-adm-api going to consume scheduling events?
2. **Rate-cap target for D.** What's the per-publisher cap? AWS MQ in dev tolerates ~500 msg/s sustained without backpressure; production limit is provisioning-dependent.
3. **Snapshot-version contract for B.** If we go B (or even reserve it for future use), where does the version live — outbox-event row, separate `schedule_snapshot` table, content-hash of affected range? The contract leaks into the publisher's read API.

## On finish

When Seth picks:
- Flip this doc's Status to `RESOLVED <date> — Option <X> ...`
- Update `d-publisher-migration.md` § 4 from OPEN → resolved with a one-line summary + pointer here
- Update `tasks/lateral-propagation.md` item 1.4 with the chosen option + tick when scheduling-api's bulk paths are wired
- If B or D: open a corresponding implementation task in scheduling-api (program-hub repo) under the existing event-driven adoption branch.

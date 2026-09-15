# @saga-ed/soa-event-outbox

Transactional outbox for cross-service domain events. `writeOutbox()` appends
an envelope to `outbox_event` inside the same Postgres transaction as your
domain write; `OutboxRelay` polls that table and ships rows to RabbitMQ with
at-least-once delivery.

```typescript
import { writeOutbox } from '@saga-ed/soa-event-outbox';

await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { ... } });
    await writeOutbox(tx, buildEnvelope({ eventType: 'iam.user.created', ... }));
});
```

```typescript
import { OutboxRelay, createOutboxPool } from '@saga-ed/soa-event-outbox';

const relay = new OutboxRelay({
    pool: createOutboxPool(process.env.DATABASE_URL!),
    connectionManager,
    logger,
    exchange: 'iam.events',
});
await relay.start();
```

See `packages/node/claude/event-driven.md` for the fuller adopter conventions
(sector pattern, contract testing, observability wiring).

## Migrating to 0.1.0-dev.9 — every consumer must migrate BEFORE upgrading

This version adds a startup check (`indexAssert`, default `'throw'`) that
fails `OutboxRelay.start()` if `outbox_event` doesn't have a valid partial
index on `(occurred_at) WHERE published_at IS NULL`. Every consumer whose
migration was generated from the old `PRISMA_MODEL_FRAGMENT` has a
non-partial index under that name instead (iac#719 — the root cause: the
relay's poll query seq-scanned a 257k-row table ~12x/sec across 6 tasks).

**Run the index migration first, then bump the package version** — not the
other way around, or the service fails to boot.

- Table already has no index of that name: run `OUTBOX_UNPUBLISHED_INDEX_SQL`.
- Table has the old NON-PARTIAL (or `INVALID`, from an interrupted
  `CONCURRENTLY` build) index under that name: run
  `OUTBOX_UNPUBLISHED_INDEX_REPAIR_SQL` instead — it builds the correct index
  under an interim name, then drops and renames, so the poll is never left
  unindexed.

Both are `CREATE/DROP INDEX CONCURRENTLY`, which cannot run inside a
transaction block — run them as a standalone script or migration step outside
your migration tool's transaction wrapper (e.g. Prisma Migrate wraps each
`migration.sql` in one).

If you can't migrate every consumer before the version bump, pass
`indexAssert: 'warn'` (logs at error level, starts anyway) or `'off'`
temporarily — but the relay is still seq-scanning until the index is fixed.

## Single-relay leader election

`OutboxRelay` now elects a single leader per schema via
`pg_try_advisory_lock`, so running it in every task of every color (e.g. an
iam-api blue/green deploy with 3+3 tasks) no longer means 6 relays polling
the same table. Losing instances retry every `leaderPollIntervalMs` (default
5000ms) without querying `outbox_event` at all. No code changes required —
this is on by default once you bump the version.

The lock key combines a fixed namespace with `current_schema()`, so per-PR
preview schemas on a shared Postgres instance each get their own lock instead
of contending for one across every preview.

## Retention — opt-in, leader-only

`outbox_event` has no retention by default; published rows accumulate
forever. Enable it via the `retention` option:

```typescript
const relay = new OutboxRelay({
    pool, connectionManager, logger, exchange: 'iam.events',
    retention: { retentionDays: 7, batchSize: 1000, intervalMs: 60 * 60 * 1000 }, // all optional; these are the defaults
});
```

The relay drives the sweep itself, gated on leadership at each interval —
only the elected leader ever sweeps. Rows are moved (not deleted outright)
into `outbox_event_archive` (`OUTBOX_EVENT_ARCHIVE_SQL`) so a bad sweep or an
unexpected downstream gap can be replayed.

If you're enabling retention on an existing table, also backfill the index
retention's `published_at < ...` predicate needs — run
`OUTBOX_PUBLISHED_AT_INDEX_SQL` (fresh tables get it for free from
`OUTBOX_EVENT_SQL`).

`OutboxRetention` is also exported standalone (its own `start()`/`stop()`) for
consumers who want to drive it outside `OutboxRelay`.

### Replay recipe

```sql
INSERT INTO outbox_event
SELECT
    event_id, aggregate_type, aggregate_id, event_type, event_version,
    payload, meta, occurred_at, claimed_at, NULL AS published_at,
    attempts, last_error
FROM outbox_event_archive
WHERE occurred_at >= '2026-09-01' AND occurred_at < '2026-09-08'  -- adjust filter
ON CONFLICT (event_id) DO NOTHING;
```

`published_at` is reset to `NULL` so the relay picks the rows back up on its
next poll. **Dedup caveat:** any consumer whose `consumed_events` table
already recorded these `event_id`s will short-circuit on the unique
constraint and silently skip them — replay only reaches consumers that never
saw the event (e.g. one added after the original publish, or one whose
`consumed_events` row was itself pruned). If you need consumers that already
processed the event to re-run their handler, that's a distinct operation
(delete the matching `consumed_events` rows for that consumer first) and
carries its own idempotency risk — not something this recipe does for you.

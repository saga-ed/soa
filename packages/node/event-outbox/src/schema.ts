// Canonical SQL for the outbox_event table. Mirrors the shape used by
// student-data-system's ledger-api so eventual back-port to the soa fleet
// is a drop-in. Services run this as part of their initial migration.
//
// We intentionally keep this as raw SQL (not a Prisma model) so it can be
// shared across services without coupling to a particular generated client.
// Each service's prisma/schema.prisma can declare a matching `OutboxEvent`
// model that points at the same table for queries — see PRISMA_MODEL_FRAGMENT
// for the canonical declaration.

export const OUTBOX_UNPUBLISHED_INDEX_NAME = 'outbox_event_unpublished_idx';
export const OUTBOX_PUBLISHED_AT_INDEX_NAME = 'outbox_event_published_at_idx';

// The pre-fix PRISMA_MODEL_FRAGMENT's @@index generated a non-partial index
// under THIS name. OUTBOX_UNPUBLISHED_INDEX_NAME above is deliberately a
// different string so the fix's CREATE INDEX ... IF NOT EXISTS is never a
// no-op against it — see OUTBOX_LEGACY_INDEX_DROP_SQL.
const LEGACY_UNPUBLISHED_INDEX_NAME = 'idx_outbox_event_unpublished';

export const OUTBOX_EVENT_SQL = `
CREATE TABLE IF NOT EXISTS outbox_event (
    event_id        UUID PRIMARY KEY,
    aggregate_type  TEXT NOT NULL,
    aggregate_id    TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    event_version   INTEGER NOT NULL DEFAULT 1,
    payload         JSONB NOT NULL,
    meta            JSONB,
    occurred_at     TIMESTAMPTZ NOT NULL,
    claimed_at      TIMESTAMPTZ,
    published_at    TIMESTAMPTZ,
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT
);

CREATE INDEX IF NOT EXISTS ${OUTBOX_UNPUBLISHED_INDEX_NAME}
    ON outbox_event (occurred_at)
    WHERE published_at IS NULL;

CREATE INDEX IF NOT EXISTS ${OUTBOX_PUBLISHED_AT_INDEX_NAME}
    ON outbox_event (published_at)
    WHERE published_at IS NOT NULL;
`.trim();

// Fresh installs get the partial index above from OUTBOX_EVENT_SQL directly.
// This standalone copy is for a table that already exists without it — e.g.
// an existing consumer adopting OutboxRetention. CONCURRENTLY so a backfill
// against a live, populated table doesn't lock writers; must run as its own
// statement, not inside the transaction a migration tool wraps around a
// migration file.
export const OUTBOX_PUBLISHED_AT_INDEX_SQL = `
CREATE INDEX CONCURRENTLY IF NOT EXISTS ${OUTBOX_PUBLISHED_AT_INDEX_NAME}
    ON outbox_event (published_at)
    WHERE published_at IS NOT NULL;
`.trim();

// Safe against every consumer's current state, migrated or not: the name is
// new relative to the old PRISMA_MODEL_FRAGMENT's non-partial index (see
// LEGACY_UNPUBLISHED_INDEX_NAME above), so IF NOT EXISTS can't collide with
// and no-op against that broken one. CONCURRENTLY forbids running inside a
// transaction block — Prisma 7.8+ already runs a single-statement migration
// file outside one; older Prisma / other tools need this split out as its
// own non-transactional step.
export const OUTBOX_UNPUBLISHED_INDEX_SQL = `
CREATE INDEX CONCURRENTLY IF NOT EXISTS ${OUTBOX_UNPUBLISHED_INDEX_NAME}
    ON outbox_event (occurred_at)
    WHERE published_at IS NULL;
`.trim();

// Second migration, run AFTER OUTBOX_UNPUBLISHED_INDEX_SQL: drops the old
// non-partial index the pre-fix PRISMA_MODEL_FRAGMENT left behind, once the
// replacement above is in place. Same standalone-statement constraint.
export const OUTBOX_LEGACY_INDEX_DROP_SQL = `
DROP INDEX CONCURRENTLY IF EXISTS ${LEGACY_UNPUBLISHED_INDEX_NAME};
`.trim();

// Archive table for OutboxRetention: rows swept out of outbox_event land
// here instead of being deleted outright, so a bad sweep or an unexpected
// downstream gap can be replayed (see the package README's replay recipe).
// `LIKE outbox_event INCLUDING DEFAULTS` only — INCLUDING INDEXES would also
// copy the unpublished partial index, which is dead weight here since every
// archived row has published_at set. The PK is added explicitly because
// ADD PRIMARY KEY has no IF NOT EXISTS form; the guard resolves
// `outbox_event_archive` through search_path via `::regclass` and filters on
// `contype = 'p'` rather than matching `conname` directly — `pg_constraint`
// has no per-schema uniqueness on name, so a bare `conname =` match would
// find another PR-preview schema's same-named constraint and wrongly skip
// adding this schema's own PK.
export const OUTBOX_EVENT_ARCHIVE_SQL = `
CREATE TABLE IF NOT EXISTS outbox_event_archive (
    LIKE outbox_event INCLUDING DEFAULTS
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'outbox_event_archive'::regclass AND contype = 'p'
    ) THEN
        ALTER TABLE outbox_event_archive ADD PRIMARY KEY (event_id);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS outbox_event_archive_published_at_idx
    ON outbox_event_archive (published_at);
`.trim();

// Drop-in for prisma/schema.prisma. Services copy this verbatim into their
// schema if they want a typed Prisma client over the table (e.g., for ops
// queries via Prisma Studio). Not required for outbox writes — writeOutbox()
// uses raw SQL and works against any tx client that exposes $executeRaw.
//
// No `@@index` here: Prisma's schema DSL cannot express a partial index
// (`WHERE published_at IS NULL`), and shipping one anyway is exactly what
// produced iac#719 — every consumer that migrated from this fragment got a
// full, non-partial index under a fixed name, silently seq-scanning the
// relay's query forever. Create the real index via two raw-SQL migrations,
// in order: OUTBOX_UNPUBLISHED_INDEX_SQL, then OUTBOX_LEGACY_INDEX_DROP_SQL
// to remove the old one. If your Prisma version diffs an index present in
// the DB but absent from schema.prisma as a DROP on the next `migrate dev`,
// pin it out of the diff (baseline the migration, or add it to your
// migrations lock) rather than re-adding `@@index`.
export const PRISMA_MODEL_FRAGMENT = `
model OutboxEvent {
    eventId       String    @id @map("event_id") @db.Uuid
    aggregateType String    @map("aggregate_type")
    aggregateId   String    @map("aggregate_id")
    eventType     String    @map("event_type")
    eventVersion  Int       @default(1) @map("event_version")
    payload       Json
    meta          Json?
    occurredAt    DateTime  @map("occurred_at") @db.Timestamptz(6)
    claimedAt     DateTime? @map("claimed_at") @db.Timestamptz(6)
    publishedAt   DateTime? @map("published_at") @db.Timestamptz(6)
    attempts      Int       @default(0)
    lastError     String?   @map("last_error")

    @@map("outbox_event")
}
`.trim();

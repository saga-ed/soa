// Canonical SQL for the outbox_event table. Mirrors the shape used by
// student-data-system's ledger-api so eventual back-port to the soa fleet
// is a drop-in. Services run this as part of their initial migration.
//
// We intentionally keep this as raw SQL (not a Prisma model) so it can be
// shared across services without coupling to a particular generated client.
// Each service's prisma/schema.prisma can declare a matching `OutboxEvent`
// model that points at the same table for queries — see PRISMA_MODEL_FRAGMENT
// for the canonical declaration.

export const OUTBOX_UNPUBLISHED_INDEX_NAME = 'idx_outbox_event_unpublished';
export const OUTBOX_PUBLISHED_AT_INDEX_NAME = 'idx_outbox_event_published_at';

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

// Only correct against a table with no index of this name at all (a fresh
// table, or a migration generated straight from OUTBOX_EVENT_SQL above). A
// same-named NON-PARTIAL index — the state left by the old
// PRISMA_MODEL_FRAGMENT's `@@index` — makes `IF NOT EXISTS` a permanent
// no-op; use OUTBOX_UNPUBLISHED_INDEX_REPAIR_SQL for that case instead.
// CONCURRENTLY forbids running inside a transaction block, so this can't be
// pasted into a Prisma Migrate file as-is — run it as a standalone script,
// or split it out per Prisma's non-transactional migration convention.
export const OUTBOX_UNPUBLISHED_INDEX_SQL = `
CREATE INDEX CONCURRENTLY IF NOT EXISTS ${OUTBOX_UNPUBLISHED_INDEX_NAME}
    ON outbox_event (occurred_at)
    WHERE published_at IS NULL;
`.trim();

// Repairs a same-named non-partial (or INVALID, e.g. from an interrupted
// CONCURRENTLY build) index left by the old PRISMA_MODEL_FRAGMENT. Builds the
// correct partial index under an interim name first, so the relay's poll is
// never left unindexed, then drops the broken one and renames into place.
// Same standalone-statement constraint as above.
export const OUTBOX_UNPUBLISHED_INDEX_REPAIR_SQL = `
CREATE INDEX CONCURRENTLY IF NOT EXISTS ${OUTBOX_UNPUBLISHED_INDEX_NAME}_partial
    ON outbox_event (occurred_at)
    WHERE published_at IS NULL;
DROP INDEX CONCURRENTLY IF EXISTS ${OUTBOX_UNPUBLISHED_INDEX_NAME};
ALTER INDEX ${OUTBOX_UNPUBLISHED_INDEX_NAME}_partial RENAME TO ${OUTBOX_UNPUBLISHED_INDEX_NAME};
`.trim();

// Archive table for OutboxRetention: rows swept out of outbox_event land
// here instead of being deleted outright, so a bad sweep or an unexpected
// downstream gap can be replayed (see the package README's replay recipe).
// `LIKE outbox_event INCLUDING DEFAULTS` only — INCLUDING INDEXES would also
// copy the unpublished partial index, which is dead weight here since every
// archived row has published_at set. The PK is added explicitly because
// ADD PRIMARY KEY has no IF NOT EXISTS form.
export const OUTBOX_EVENT_ARCHIVE_SQL = `
CREATE TABLE IF NOT EXISTS outbox_event_archive (
    LIKE outbox_event INCLUDING DEFAULTS
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'outbox_event_archive_pkey'
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
// full, non-partial index under the poll index's name, silently seq-scanning
// the relay's query forever. Create the real index via OUTBOX_UNPUBLISHED_INDEX_SQL
// (or the repair variant) as a raw-SQL migration instead. If your Prisma
// version diffs an index present in the DB but absent from schema.prisma as a
// DROP on the next `migrate dev`, pin it out of the diff (baseline the
// migration, or add it to your migrations lock) rather than re-adding `@@index`.
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

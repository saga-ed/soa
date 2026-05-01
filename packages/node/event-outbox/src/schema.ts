// Canonical SQL for the outbox_event table. Mirrors the shape used by
// student-data-system's ledger-api so eventual back-port to the soa fleet
// is a drop-in. Services run this as part of their initial migration.
//
// We intentionally keep this as raw SQL (not a Prisma model) so it can be
// shared across services without coupling to a particular generated client.
// Each service's prisma/schema.prisma can declare a matching `OutboxEvent`
// model that points at the same table for queries — see PRISMA_MODEL_FRAGMENT
// for the canonical declaration.

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

CREATE INDEX IF NOT EXISTS idx_outbox_event_unpublished
    ON outbox_event (occurred_at)
    WHERE published_at IS NULL;
`.trim();

// Drop-in for prisma/schema.prisma. Services copy this verbatim into their
// schema if they want a typed Prisma client over the table (e.g., for ops
// queries via Prisma Studio). Not required for outbox writes — writeOutbox()
// uses raw SQL and works against any tx client that exposes $executeRaw.
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
    @@index([occurredAt(sort: Asc)], map: "idx_outbox_event_unpublished")
}
`.trim();

// Canonical SQL for the consumed_events table. Per-consumer idempotency:
// `INSERT ... ON CONFLICT DO NOTHING RETURNING event_id` returns 0 rows if
// we've already processed this (consumer_name, event_id), so the handler is
// skipped. Combined with persistent publishes (durability of in-flight
// messages still has the broker-crash-pre-fsync gap noted in OutboxRelay
// until soa-rabbitmq exposes a confirm channel), this gives at-least-once
// delivery and effectively-exactly-once semantics on the projection.

export const CONSUMED_EVENTS_SQL = `
CREATE TABLE IF NOT EXISTS consumed_events (
    consumer_name  TEXT NOT NULL,
    event_id       UUID NOT NULL,
    processed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (consumer_name, event_id)
);

CREATE INDEX IF NOT EXISTS idx_consumed_events_processed_at
    ON consumed_events (processed_at);
`.trim();

export const PRISMA_MODEL_FRAGMENT = `
model ConsumedEvent {
    consumerName String   @map("consumer_name")
    eventId      String   @map("event_id") @db.Uuid
    processedAt  DateTime @default(now()) @map("processed_at") @db.Timestamptz(6)

    @@id([consumerName, eventId])
    @@map("consumed_events")
    @@index([processedAt])
}
`.trim();

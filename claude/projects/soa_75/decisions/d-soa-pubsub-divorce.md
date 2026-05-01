# d-soa-pubsub-divorce — POC explicitly does NOT import `@saga-ed/soa-pubsub-*`

RESOLVED 2026-04-30: The event-driven POC will not depend on `@saga-ed/soa-pubsub-core`, `pubsub-server`, or `pubsub-client`. Those packages model a fundamentally different problem (real-time UI push). New packages (`@example/event-{outbox,consumer}`, `@example/envelope`, per-family `@example/*-events`) are what we'd back-port to soa instead.

## Context

The soa fleet has three "pubsub" packages — `@saga-ed/soa-pubsub-core`, `@saga-ed/soa-pubsub-server`, `@saga-ed/soa-pubsub-client`. The repo also has a guide at `HowToAddPubsub.md` (1138 lines) describing how to add pubsub sectors to tRPC APIs.

When planning the POC, the natural assumption was "we have a pubsub package; we should use it." On reading the source and `HowToAddPubsub.md`, the packages turn out to model a **different problem**:

| Concern | `soa-pubsub-*` (current) | What the POC needs |
|---|---|---|
| Transport | tRPC mutations + EventSource (server-sent events) | Durable broker (RabbitMQ) |
| Direction | client ↔ server real-time UI push | service ↔ service async eventing |
| Durability | None — fire-and-forget within an HTTP request | Outbox + broker persistence |
| Replay | None | Re-insert into outbox |
| Ordering across failures | None | Per-queue (RabbitMQ) |
| Idempotency / dedup | Not modeled | `consumed_events` table per consumer |
| Cross-service contract | Not modeled | Per-family Zod schemas + snapshot CI |

`HowToAddPubsub.md` is a real and useful artifact — for what it covers (real-time UI updates from a tRPC API). It's not a starting point for cross-service durable eventing.

## Decision

The POC introduces **new packages** purpose-built for cross-service durable async eventing:

- `@example/envelope` — Zod-typed `EventEnvelope` (eventId, eventType, eventVersion, aggregateType, aggregateId, occurredAt, payload, meta).
- `@example/identity-events`, `@example/catalog-events`, `@example/admissions-events` — per-family schemas.
- `@example/event-outbox` — transactional outbox table + polling relay (mirrors `ledger-api/src/queue/outbox-publisher.ts`).
- `@example/event-consumer` — `consumed_events` idempotency + retry budget + DLQ wiring.

Once these earn their keep in the POC, they're the back-port candidates for `soa/packages/` (likely names: `@saga-ed/event-envelope`, `@saga-ed/event-outbox`, `@saga-ed/event-consumer`).

## What this means for HowToAddPubsub.md

`HowToAddPubsub.md` continues to be the guide for **real-time UI push** in tRPC APIs. It is not affected by this decision. After back-port, soa will have **two** pubsub-adjacent stories:

- `@saga-ed/soa-pubsub-*` for client ↔ server real-time UI updates.
- `@saga-ed/event-{envelope,outbox,consumer}` for service ↔ service durable async events.

These should NOT be merged. They serve different purposes and conflating them produces awkward APIs.

## Related artifacts

- POC plan: `/home/spaul/.claude/plans/fancy-finding-dream.md` § "What does NOT carry forward"
- soa pubsub packages: `/home/spaul/dev/soa/.claude/worktrees/stateful-wibbling-babbage/packages/node/{pubsub-core,pubsub-server,pubsub-client}/`
- HowToAddPubsub guide: `/home/spaul/dev/soa/.claude/worktrees/stateful-wibbling-babbage/HowToAddPubsub.md`
- Reference outbox: `/home/spaul/dev/student-data-system/apps/node/ledger-api/src/queue/outbox-publisher.ts`

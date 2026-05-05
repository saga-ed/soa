# d-broker-choice — RabbitMQ for the POC and back-port target

RESOLVED 2026-04-30: RabbitMQ. Matches ledger-api's existing outbox publisher; reuses `@saga-ed/soa-rabbitmq`; provides DLQ ergonomics natively.

## Context

The event-driven POC at `~/dev/soa_event_driven_example` needs a message broker for cross-service event propagation. Choice impacts:

- Local-dev infra footprint (`pnpm dev:infra`)
- DLQ + retry semantics
- Replay story
- How directly POC lessons port to the eventual iam-api / programs-api refactor

The existing fleet has **one** working outbox publisher: `student-data-system/apps/node/ledger-api/src/queue/outbox-publisher.ts`. It polls `ledger_local.outbox_event` (default 500ms, batch of 100), uses `pg_try_advisory_xact_lock` for single-leader election, publishes to RabbitMQ exchange `ledger.events` (topic, durable). `@saga-ed/soa-rabbitmq` already wraps amqplib for connection management, publisher, and consumer.

## Options considered

1. **RabbitMQ** — matches ledger-api; native DLQ via dead-letter exchanges; flexible routing. No native replay (mitigated by re-inserting into outbox). Local: one Docker container.
2. **Postgres LISTEN/NOTIFY** — zero broker infra. Transactional with the outbox. Big problem for inter-service eventing: NOTIFY only fires across listeners on the **same** Postgres. Either every service shares one DB (violates "one DB per service") or each consumer polls publisher's `GET /events` HTTP endpoint (essentially building feed-based eventing). Useful intra-service; wrong tool here.
3. **Redis Streams** — replayable, lightweight. Adds Redis as runtime infra. `@saga-ed/soa-redis-core` exists but doesn't wrap streams. Diverges from the RabbitMQ-anchored fleet.
4. **Kafka** — industry standard for replay + projections. Heavyweight ops; ~1GB Docker for local. Over-rotates for our scale.

## Recommendation

**RabbitMQ.** Three load-bearing reasons:

1. **Back-port leverage** — POC patterns (outbox table shape, publisher relay, consumer scaffolding) drop directly into iam-api / programs-api without translation, since ledger-api already uses RabbitMQ.
2. **DLQ ergonomics** — dead-letter exchanges are first-class; `<queue>.dlq` binding with TTL/reject is the well-trodden recipe. Other options make us build it.
3. **The replay weakness is mitigated by the outbox** — our outbox table is the source of truth. To replay, re-insert into outbox; the relay re-publishes. ledger-api already operates this way.

## Related artifacts

- POC plan: `/home/spaul/.claude/plans/fancy-finding-dream.md` § D2
- Reference impl: `/home/spaul/dev/student-data-system/apps/node/ledger-api/src/queue/outbox-publisher.ts`
- Wrapper: `/home/spaul/dev/soa/.claude/worktrees/stateful-wibbling-babbage/packages/node/rabbitmq/`
- soa_75 reference: `research/03-event-driven-microservices-reference.md` § "RabbitMQ vs Alternatives"

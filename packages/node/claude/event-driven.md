# Event-driven packages — adopter conventions

Reference for fleet services consuming `@saga-ed/soa-event-envelope`, `event-outbox`, `event-consumer`, `observability`, `event-test-harness`. Design decisions live under `.claude/projects/soa_75/decisions/`.

## What this stack is (and isn't)

- **IS:** durable, server-to-server domain eventing over RabbitMQ with a transactional outbox per publisher and a `consumed_events` idempotency table per consumer.
- **IS NOT:** real-time UI push. That's `@saga-ed/soa-pubsub-*`. Don't mix them — see `decisions/d-soa-pubsub-divorce.md`.

## HTTP framework

Use **plain `@trpc/server`** with a hand-composed `appRouter`. Compose data services with **Inversify**.

Do **not** use `AbstractTRPCController` or `ControllerLoader` from `@saga-ed/soa-api-core` for new event-driven services — the convention here is the iam-api/programs-api shape, not the dynamic loader pattern. See `decisions/d-http-framework.md`.

## Sector pattern

Per service, organise domain logic by sector (bounded context):

```
apps/node/<svc>/src/sectors/<domain>/
├── <domain>.data.ts           # Inversify-injected data service (pg + outbox writes)
├── <domain>.router.ts         # tRPC router for this domain
├── <domain>.input-schemas.ts  # Zod input schemas
└── __tests__/
    ├── <domain>.unit.test.ts  # hermetic
    └── <domain>.int.test.ts   # testcontainers
```

The top-level `appRouter` merges sector routers.

## Per-family event packages

Cross-service event types live in their own `@saga-ed/<family>-events` package (e.g. `@saga-ed/iam-events`, `@saga-ed/programs-events`). Each event has a Zod schema, a TypeScript type, and a string discriminator like `iam.user.created.v1`.

**Frozen-once-published versioning:** once an event version ships to a consumer, the schema is immutable. Any wire change → new `vN+1`. Snapshots under `tools/contract-check/published/` are byte-checked in CI; modifying without `--bump` fails the build. See `decisions/d-event-versioning.md` and `d-event-package-shape.md`.

## Outbox + consumer wiring (publisher side)

`buildEnvelope` snapshots the active OTel trace context into `meta.traceparent` so the consumer's span chains under the original request. `writeOutbox` then appends the envelope inside the same transaction as the domain write.

```ts
import { buildEnvelope } from '@saga-ed/soa-event-envelope';
import { writeOutbox } from '@saga-ed/soa-event-outbox';

await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { ... } });

    const envelope = buildEnvelope({
        eventType: 'iam.user.created',
        eventVersion: 1,
        aggregateType: 'user',
        aggregateId: user.id,
        payload: { id: user.id, email: user.email },
    });
    await writeOutbox(tx, envelope);
});
```

A separate process (or service boot) runs an `OutboxRelay` that polls the table and ships rows to RabbitMQ:

```ts
import { OutboxRelay } from '@saga-ed/soa-event-outbox';

const relay = new OutboxRelay({
    pool, connectionManager, logger,
    exchange: 'iam.events',
    metrics: observability.addOutbox(pool),
});
await relay.start();
```

## Idempotent consumer (consumer side)

```ts
import { EventConsumer } from '@saga-ed/soa-event-consumer';

const consumer = new EventConsumer({
    pool, connectionManager, logger,
    consumerName: 'admissions.iam-projection',
    queue: 'admissions.iam-projection',
    bindings: [{ exchange: 'iam.events', routingKey: 'iam.user.*' }],
    handlers: {
        'iam.user.created.v1': {
            key: 'iam.user.created.v1',
            payloadSchema: UserCreatedV1,
            async handle(envelope, payload, tx) {
                await tx.query(
                    `INSERT INTO user_projection (id, email) VALUES ($1, $2)`,
                    [payload.id, payload.email],
                );
            },
        },
    },
    metrics: observability.addConsumer(pool, 'admissions.iam-projection'),
});
await consumer.start();
```

The consumer inserts into `consumed_events(consumer_name, event_id)` inside the same tx as the projection — duplicates short-circuit on the unique constraint.

## Hybrid contract testing

Three layers, all required:

1. **Publisher snapshot:** `pnpm contract:export` regenerates `tools/contract-check/published/<event>.json` for every emitted type. CI fails on byte-diffs.
2. **Per-consumer pin:** each consumer keeps `consumed-events.json` listing the exact `(type, version)` it depends on. CI cross-checks pins against published snapshots.
3. **Zod runtime validation:** every consumer validates inbound envelopes against its pinned schema. Validation failure → reject + DLQ, never silently drop.

See `decisions/d-contract-testing.md`.

## Test config

Two vitest configs per service:

- `vitest.config.ts` — `*.unit.test.ts` only, hermetic, fast.
- `vitest.int.config.ts` — `*.int.test.ts`, uses `@saga-ed/soa-event-test-harness` to spin up real Postgres + RabbitMQ via testcontainers. `testTimeout: 120_000`, `fileParallelism: false`.

## Observability

`@saga-ed/soa-observability` wires:

- OTel tracing with W3C `traceparent` propagation through envelopes
- Prometheus metrics for outbox depth, relay lag, consumer lag, retries
- An Express error middleware for tRPC HTTP layer

Initialise once at process boot — before importing any instrumented module:

```ts
import { initTracing } from '@saga-ed/soa-observability';
const handle = initTracing('programs-api', { logger });
```

See `decisions/d-observability.md`.

## What NOT to do

- ❌ Import `@saga-ed/soa-pubsub-*` for cross-service events.
- ❌ Modify a published event schema without bumping the version.
- ❌ Read cross-service data via HTTP on the request path — go through projections built from events.
- ❌ Ack a message without writing to `consumed_events` in the same tx.
- ❌ Use `AbstractTRPCController` / `ControllerLoader` for new event-driven services.

---

*Source decisions:* `.claude/projects/soa_75/decisions/`

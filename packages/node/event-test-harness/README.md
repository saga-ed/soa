# @saga-ed/soa-event-test-harness

Testcontainers helpers for integration-testing the event-driven stack:
spin up real Postgres + RabbitMQ in parallel, apply migrations, and assert
end-to-end roundtrips through `@saga-ed/soa-event-outbox` →
`@saga-ed/soa-rabbitmq` → bound queues. Plus a deterministic UUID-shaped
ID helper for fixture data that satisfies `z.string().uuid()` payload
schemas.

```typescript
import { startInfra, id, type InfraHandle } from '@saga-ed/soa-event-test-harness';
```

## API

### `startInfra(opts?): Promise<InfraHandle>`

Starts a Postgres container and a RabbitMQ container in parallel. Uses
`Promise.allSettled` internally so a partial-start failure stops the
other container — testcontainers leaks Docker resources otherwise.

Default images: `postgres:17-alpine` and `rabbitmq:3.13-management-alpine`.
Override per call via `opts.postgresImage` / `opts.rabbitmqImage`.

### `InfraHandle`

| member             | purpose                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `postgresAdminUrl` | URL pointing at the default `test` admin database. Use only for `createDatabase`.                                    |
| `rabbitmqUrl`      | AMQP URL with credentials. Pass to `new ConnectionManager({ url })`.                                                 |
| `createDatabase(name, opts?)` | Provision a fresh database in the running Postgres container; returns the URL. `dropIfExists` for idempotency. |
| `runSql(url, sql)` | Apply arbitrary SQL — use to install the outbox / consumer migrations + your service's projection tables.            |
| `stop()`           | Stop both containers. Call in `afterAll`.                                                                            |

### `id(seed: string): string`

Deterministic UUID-v4-shaped string from a memorable seed. Lifted from
the canonical adopter helper in `rostering` (PR #138).

```typescript
id('mem-child');           // e.g. '8f3e9b21-…' — stable across runs
id('mem-child') === id('mem-child');  // true (deterministic)
id('mem-child') !== id('parent');     // true (distinct seeds)
```

Use this anywhere a test fixture needs a string that satisfies
`z.string().uuid()`. The seed makes cross-fixture references readable
(e.g. `id('mem-child')` referenced both in `User` and `Pod` fixtures
resolves to the same UUID without bookkeeping).

## Worked example — outbox roundtrip

Full integration pattern: write an event through `writeOutbox`, tick the
relay, assert the message arrives on a bound queue. Mirrors
`apps/node/iam-api/src/__tests__/integration/outbox-roundtrip.int.test.ts`
in rostering (PR #138).

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startInfra, id, type InfraHandle } from '@saga-ed/soa-event-test-harness';
import { OUTBOX_EVENT_SQL, OutboxRelay, writeOutbox } from '@saga-ed/soa-event-outbox';
import { ConnectionManager } from '@saga-ed/soa-rabbitmq';
import { buildEnvelope } from '@saga-ed/soa-event-envelope';
import { IAM_EXCHANGE, IamUserCreatedV1 } from '@saga-ed/iam-events';
import { Pool } from 'pg';

const skip = process.env.SKIP_INT === '1';

const noopLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
};

describe.skipIf(skip)('outbox -> RabbitMQ roundtrip', () => {
    let infra: InfraHandle;
    let pool: Pool;
    let connectionManager: ConnectionManager;
    let relay: OutboxRelay;
    const TEST_QUEUE = 'iam.events.test.consumer';
    const collected: Array<{ routingKey: string; body: unknown }> = [];

    beforeAll(async () => {
        // (a) Postgres + RabbitMQ container spin-up.
        infra = await startInfra();
        const dbUrl = await infra.createDatabase('iam_outbox_int');
        await infra.runSql(dbUrl, OUTBOX_EVENT_SQL);
        pool = new Pool({ connectionString: dbUrl, max: 4 });

        connectionManager = new ConnectionManager(noopLogger as never, {
            url: infra.rabbitmqUrl,
            reconnect: { enabled: false },
            failureMode: 'fatal',  // tests should fail loud on broker issues
        });
        await connectionManager.connect();

        // Bind a transient test queue so we can observe published messages.
        const channel = await connectionManager.newChannel();
        await channel.assertExchange(IAM_EXCHANGE, 'topic', { durable: true });
        await channel.assertQueue(TEST_QUEUE, { durable: false, autoDelete: true });
        await channel.bindQueue(TEST_QUEUE, IAM_EXCHANGE, 'iam.user.*');
        await channel.consume(TEST_QUEUE, (msg) => {
            if (!msg) return;
            collected.push({
                routingKey: msg.fields.routingKey,
                body: JSON.parse(msg.content.toString()),
            });
            channel.ack(msg);
        });

        relay = new OutboxRelay({
            pool,
            connectionManager,
            exchange: IAM_EXCHANGE,
            logger: noopLogger as never,
        });
    }, 120_000);

    afterAll(async () => {
        await relay?.stop().catch(() => {});
        await pool?.end().catch(() => {});
        await infra?.stop().catch(() => {});
    }, 30_000);

    it('publishes an envelope written to outbox_event', async () => {
        // (b) `id()` helper produces a UUID-shaped string that the
        // payload schema's `z.string().uuid()` accepts.
        const userId = id('mem-child');
        const envelope = buildEnvelope({
            eventType: IamUserCreatedV1.eventType,
            eventVersion: IamUserCreatedV1.eventVersion,
            aggregateType: 'user',
            aggregateId: userId,
            payload: IamUserCreatedV1.payloadSchema.parse({
                id: userId,
                status: 'active',
                createdAt: new Date().toISOString(),
            }),
        });

        await writeOutbox(makeTxShim(pool), envelope);

        // (c) Tick the relay manually for determinism, then assert the
        // bound queue received the published envelope.
        await (relay as unknown as { tick: () => Promise<void> }).tick();
        await new Promise((resolve) => setTimeout(resolve, 250));

        expect(collected).toHaveLength(1);
        expect(collected[0].routingKey).toBe('iam.user.created');
    });
});

// `writeOutbox` accepts a Prisma-tx-shaped object. The pg Pool exposes
// $executeRaw via a thin shim that mimics the tagged-template signature.
function makeTxShim(pool: Pool) {
    return {
        async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
            let sql = strings[0];
            for (let i = 0; i < values.length; i++) {
                sql += `$${i + 1}` + strings[i + 1];
            }
            const res = await pool.query(sql, values);
            return res.rowCount ?? 0;
        },
    };
}
```

## When to skip

- `SKIP_INT=1` — explicit skip, e.g. in CI lanes that don't provision
  Docker.
- Sandboxed runners without a Docker daemon — tests will fail at
  `startInfra()`. Either install Docker in the runner or set `SKIP_INT=1`.

## Container lifecycle

`startInfra()` is intentionally per-suite, not per-test: container
startup is ~5–10s and dominates a per-test cost. Use one
`startInfra → afterAll(stop)` cycle per integration suite, with
`createDatabase` for per-test isolation inside that suite.

## See also

- `@saga-ed/soa-event-outbox` — `OUTBOX_EVENT_SQL` migration,
  `writeOutbox`, `OutboxRelay`.
- `@saga-ed/soa-event-consumer` — projection consumer with
  `consumed_events` dedup; queue-topology + UPSERT-handler pattern docs.
- `@saga-ed/soa-rabbitmq` — `ConnectionManager` with `failureMode`
  control.
- `@saga-ed/soa-event-envelope` — Zod envelope, `buildEnvelope`.

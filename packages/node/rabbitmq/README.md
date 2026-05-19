# @saga-ed/soa-rabbitmq

RabbitMQ connection management, channel helpers, queue assertions, and
publisher-confirms for Saga services.

```typescript
import { ConnectionManager } from '@saga-ed/soa-rabbitmq';
```

## Connection failure semantics

`ConnectionManager.connect()` retries with exponential backoff up to
`reconnect.maxRetries`. When retries are exhausted the circuit breaker
trips. What happens *next* depends on `failureMode`:

| `failureMode`       | Behavior on circuit-trip               | Use when                                                                                            |
| ------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `'fatal'`           | throws — host process crashes          | production. Soft-failing event publication accumulates outbox debt invisibly; the crash is the alert. |
| `'log-and-continue'`| logs warn, returns; state stays open   | dev / test / preview. Request-path mutations still succeed via the outbox table; the relay reconnects when the broker returns. |

**Default:** `'fatal'` when `process.env.NODE_ENV === 'production'`,
`'log-and-continue'` otherwise. Set explicitly to override — e.g. a
staging environment that should fail loud:

```typescript
new ConnectionManager(logger, {
    url: process.env.RABBITMQ_URL!,
    failureMode: 'fatal',
});
```

Rationale and the full pattern set (idempotent UPSERT handlers, soft-delete
projections, OTel `initTracing` ordering, queue-per-event-family) are
captured in
[`d-consumer-resilience.md`](../../../claude/projects/soa_75/decisions/d-consumer-resilience.md)
on `soa_75`.

## See also

- `@saga-ed/soa-event-outbox` — relay that publishes outbox rows.
- `@saga-ed/soa-event-consumer` — idempotent consumer with `consumed_events`
  dedup.
- `@saga-ed/soa-observability` — OpenTelemetry + Prometheus wiring.

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

## Riding out a broker outage (1.4.0-dev.5, soa#578)

The initial `connect()` is capped by `reconnect.maxRetries`. After an
established connection is lost, the manager keeps reconnecting for
`reconnect.budgetMs` (default 15 min, longer than a single-instance broker's
~8 min maintenance reboot) with the same capped backoff, then gives up.

**Behaviour change:** callers that set only `maxRetries` now get the 15 min
budget for reconnects after a loss (previously ~10 attempts, ~3.5 min). Pass
`reconnect: { budgetMs: 0 }` to keep the count cap for reconnects.

| Accessor | Meaning |
| --- | --- |
| `isConnected()` | READY or DEGRADED |
| `disconnectedSince()` | epoch ms the live connection was lost; `undefined` while connected or never connected |
| `reconnectGaveUp()` | the manager stopped retrying (state `CIRCUIT_OPEN`); distinct from `CLOSED`, and a later `connect()`/`ensureConnected()` still tries and clears it on success |
| `reconnectBudgetMs()` | configured budget |

- `ensureConnected()` throws immediately while a background reconnect is in
  progress (channel holders retry on their own cadence); `newChannel()` names the
  outage (`disconnected since <iso>; reconnect in progress|gave up`).
- `MessageConsumer` re-creates its channel and re-subscribes after a channel
  loss (backoff 1s to 30s, until `stop()`); `MessagePublisher` evicts dead channels.
  `EventConsumer` and `OutboxRelay` already re-assert topology / re-acquire a
  channel on their own retry loops; no change needed there.
- Health: `rabbitDependency()` in `@saga-ed/soa-health` 0.5.0 reads these accessors.

## Shutting down — `close()`

Services hold their connection for their whole lifetime and never need
this. Processes that are meant to **end** — a one-shot operator CLI, a
migration, a test — do:

```typescript
try {
    await doTheWork(connectionManager);
} finally {
    await connectionManager.close();
}
```

An open AMQP socket keeps Node's event loop alive, so without the close
the process finishes its work and then just sits there. `process.exit()`
gets around that by discarding whatever else was still pending, which is
not the same thing.

`close()` is:

- **final** — it suppresses automatic reconnection, including the one the
  connection's own `'close'` event would otherwise trigger. A later
  `connect()` or `ensureConnected()` throws **`ConnectionManagerClosedError`**
  rather than reviving the manager; construct a new `ConnectionManager` if
  you want a new connection. (Reviving would let a stray recovery tick
  resurrect the socket mid-shutdown — the hang this exists to prevent.)
  `state()` reads `'CLOSED'`, which is distinct from `'DISCONNECTED'`: the
  latter means a reconnect is expected.

  A long-running service that adds `close()` to its shutdown path should
  catch that error in its recovery loop and stop, rather than treat it as a
  broker outage and retry forever:

  ```typescript
  catch (err) {
      if (err instanceof ConnectionManagerClosedError) return; // shutting down
      this.scheduleReconnect();
  }
  ```
- **idempotent** — calling it twice awaits the same teardown, and calling
  it on a manager that never connected is a clean no-op.
- **quiet** — a broker that already dropped the socket makes the teardown
  throw; that is logged and swallowed, never raised at the caller.
- **complete** — a pending retry sleep is cancelled, so nothing is left
  holding the event loop open once it resolves.

Rationale and the full pattern set (idempotent UPSERT handlers, soft-delete
projections, OTel `initTracing` ordering, queue-per-event-family) were meant to be
captured in `d-consumer-resilience.md` — the file is missing; see
[soa_75's README](../../../docs/history/soa_75/README.md#missing-decisions).

## See also

- `@saga-ed/soa-event-outbox` — relay that publishes outbox rows.
- `@saga-ed/soa-event-consumer` — idempotent consumer with `consumed_events`
  dedup.
- `@saga-ed/soa-observability` — OpenTelemetry + Prometheus wiring.

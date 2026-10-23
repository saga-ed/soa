# Event statistics

`@saga-ed/soa-event-stats` supplies cumulative process telemetry for the Saga event mesh (I#535). Service wiring belongs to I#537; Vishnu ingestion, storage, freshness and UI belong to I#538. These reports are best-effort operational measurements, not an audit ledger.

## Contract and counting boundaries

Publish `observability.event_stats.reported`, envelope version 1, on the service's **existing environment/slot publisher exchange**. Vishnu owns telemetry queues and bindings. Audit existing `#` bindings before adoption: exclusion from statistics prevents recursion but does not stop a business consumer receiving an unsupported telemetry event. No new broker user or shared telemetry exchange is required.

The strict runtime `ReportSchema` and checked-in `contracts/event-stats.v1.json` describe the payload. Once published, incompatible changes require a new version. Zod additionally enforces that consumer streams name both queue and consumer. I#538 must pin this contract and validate envelopes and payloads at ingress.

Each report includes service, environment, deployment, revision, process instance, broker and vhost identity; a random process epoch; increasing sequence; wall-clock observation time; and monotonic elapsed milliseconds. Use stable topology labels, never credentials, broker URLs, event IDs, payloads or user data as dimensions. Labels are capped at 128 characters. Aggregate and business event IDs are never collected by the adapters.

| Measurement | Meaning |
| --- | --- |
| `publishAttempts` | Outbox transport attempts, including retries; not inserts into the outbox. |
| `publishAccepted` | Client publish returned and any buffer drain completed. Not proof of broker delivery or outbox DB commit. |
| `publishConfirmed` | Positive broker confirms, only when explicitly instrumented by a direct publisher. `null` for the current non-confirm outbox relay. |
| `publishFailures` | Transport attempt failed before acceptance, classified as transport or backpressure. A subsequent outbox DB commit failure does not undo acceptance. |
| `deliveries`, `redeliveries` | Consumer delivery callbacks and RabbitMQ's redelivery flag. Duplicate event IDs may arrive without that flag. |
| `commits` | Successful handler transaction COMMIT; excludes duplicate skips. |
| `duplicates` | Existing idempotency row found and duplicate transaction committed. |
| `processingFailures` | Envelope, unsupported type/version, schema, database, handler or commit failure; reasons are a fixed enumeration. |
| `ackIssued`, `nackIssued` | Client settlement call returned; not broker acknowledgement of that call. |
| `ackFailed`, `nackFailed`, `requeues` | Settlement call errors and issued nacks requesting requeue. |

`null` means unavailable/inapplicable; zero means supported with no activity. Producer fanout and consumer groups make global sent/received equality invalid. Compare specific publisher streams and consumer queues within matching environment/broker/vhost scopes. Outbox retries, duplicate skips and ack loss are intentionally distinguishable.

## Wiring

```ts
import { EventStats, EventStatsReporter, RabbitMqReportTransport } from '@saga-ed/soa-event-stats';

const stats = new EventStats({
  identity: { service, environment, deployment, revision, instance, broker, vhost },
  capabilities: ['producer', 'consumer'],
});
// Register known streams at startup so quiet services report explicit zeros.
stats.register({ role: 'producer', exchange, eventType: 'example.created', eventVersion: 1 });
stats.register({ role: 'consumer', exchange, queue, consumer: consumerName,
  eventType: 'example.created', eventVersion: 1 });

// Add to existing OutboxRelay options: observe: stats.observeOutbox
// Add to existing EventConsumer options: observe: stats.observeConsumer
// Keep existing metrics hooks; these observers compose independently.
const reporter = new EventStatsReporter({
  stats,
  transport: new RabbitMqReportTransport({
    exchange,
    createChannel: () => reportingConnectionManager.newChannel(),
  }),
  onError: kind => reportingErrorMetric.increment({ kind }),
});
reporter.start();
// Shutdown: first drain business relay/consumers, then:
await reporter.stop({ flush: true });
// Finally close the dedicated reporting connection manager.
```

The reporting connection manager must use a **separate AMQP connection** with bounded connection establishment and reconnect behavior. Never hand the reporter the business channel. The adapter checks the existing exchange without declaring topology, owns/closes each reporting channel, and responds to abort while backpressured. Publishing is non-persistent and non-confirming; recovery comes from subsequent cumulative snapshots. The caller owns the connection's lifetime.

Direct publishers can register a producer stream with `{ confirms: true }` **before observations begin**, then increment attempts/accepted/confirmed/failures at the corresponding actual transport boundaries. Do not combine confirm-capable and non-confirm transports under the same stream dimensions. `dispatchEnvelope` instruments processing outcomes only; it cannot report AMQP deliveries/settlements when called directly.

## Lifecycle and limits

Defaults: immediate startup heartbeat, 30s periodic cadence, ±10% jitter, exponential backoff, 5s send timeout, 128 distinct streams, 256KiB maximum serialized envelope. Configure up to 1,024 streams and 1MiB; invalid configurations fail at construction. Streams are never evicted within an epoch. New dimensions after capacity are dropped and counted. Telemetry event types are excluded in both library hooks and the accumulator.

Snapshots never reset counters. Abrupt process termination can lose the unreported tail; a restart begins a new epoch. Flushes coalesce, there is no offline report queue, and only one transport operation may remain pending. Timeout aborts the adapter and returns control even if a custom transport ignores cancellation; further sends wait for that operation to settle. Oversized reports are dropped whole, with diagnostics, until configuration or stream volume permits a valid report. Counters saturate at the safe-integer limit; saturation is reported and rates become unavailable.

Reporting errors increment diagnostics for the next successful report and invoke the independent local `onError` sink. Monitor that sink and receiver freshness because an offline reporter cannot report its own failure over the same broker. Observers and event metrics isolate exceptions/rejections; their first failure is logged once per relay/consumer instance. They must do bounded, nonblocking work; asynchronous observers are not awaited or drained at shutdown. Existing legacy metric counts retain their historical meaning (including `onProcessed` after a duplicate).

## Receiver rules

`compareReports(previous, incoming)` provides a pure reference calculation. Partition stored baselines by the full identity and epoch. It ignores duplicate/out-of-order sequences within an epoch, computes deltas across missed reports using cumulative counters, and divides by monotonic elapsed time. First observations, new epochs/identities, newly seen streams, zero-duration intervals, counter decreases and saturation have unavailable rates. Never subtract one process's counters from another's.

Receivers must retain/reject retired epochs so a delayed old-epoch report cannot replace a newer baseline; epochs are opaque UUIDs and cannot be ordered by the comparison helper. Use receiver arrival time for freshness and expiry; do not infer freshness from a skewed producer wall clock. Aggregate only comparable fresh instances. A missing heartbeat means stale/unknown, not zero traffic. Deployment/gate status is obtained from existing service health surfaces, not inferred from zero event counts.

## Validation and release

Run `pnpm --filter @saga-ed/soa-event-stats test`, `check-types`, `build`, and `test:int`. The integration suite starts isolated Postgres/RabbitMQ containers, verifies real outbox fanout into two consumers, duplicate suppression, rollback/DLQ, and report transport. It does not use a shared synthetic stack.

Release the observer-bearing event-consumer 0.2.0 and event-outbox 0.3.0 packages before event-stats 0.1.0 through the repository's manual single-package CodeArtifact workflow. Complete dependency preflight before dispatch; no package is published by this change. Then adopt in I#537, and implement receiver persistence/UI in I#538.

## Service lifecycle helper

`createServiceEventStats({ service, capabilities, publisherExchange, onError })`
returns `consumer(options)`, `outbox(options)`, `start()` and async `stop()`.
Wrap existing constructor options, start after business resources are initialized,
and stop after consumers/relays stop. Existing observers and metrics remain active.
When disabled, options pass through and no reporting resources are allocated.

Enable with `EVENT_STATS_ENABLED=true`. Enabled services require
`EVENT_STATS_ENVIRONMENT`, `EVENT_STATS_DEPLOYMENT`, `EVENT_STATS_REVISION`,
`EVENT_STATS_BROKER`, `EVENT_STATS_VHOST`, and `RABBITMQ_URL`.
`EVENT_STATS_INSTANCE` defaults to hostname plus PID;
`EVENT_STATS_INTERVAL_MS` defaults to 30000 (positive integer, at most one hour).
The helper uses a separate short-lived AMQP connection per flush, with two-second
connection/report deadlines and a best-effort final flush. The publisher exchange
must already exist. Consumer idle streams are registered from the configured
bindings and exact handler types; wildcard labels are not emitted as event types.

Service schema parsers expose `parse(data: unknown)` structurally so existing
Zod 3 handlers can coexist with Zod 4 packages without changing the wire envelope.
Connection managers expose only the `ensureConnected` and `newChannel` methods
required by these adapters; unrelated class-private fields do not constrain adopters.

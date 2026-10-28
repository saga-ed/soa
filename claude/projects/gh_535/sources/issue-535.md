# I#535 — Add shared event-stats module for producer/consumer telemetry and periodic Vishnu reports

Snapshot captured 2026-10-22; trust the live issue: https://github.com/saga-ed/soa/issues/535

Parent epic: #536
Follow-ups: #537 (service adoption), #538 (Vishnu ingestion/UI).

## Outcome

Add a shared `@saga-ed/soa-event-stats` module in SOA that instruments MQ producers and consumers, accumulates bounded per-instance statistics, and periodically publishes versioned statistics reports for Vishnu (and other authorized telemetry consumers).

Vishnu should display **MQ-P**, **MQ-C**, or **MQ-P/C**, plus attributable publish/consume counts and rates, from the participating service's own instrumentation. Counting messages received by Vishnu cannot establish another service's successful processing or projection completion. Launch dependencies also omit real event participation: programs-api, scheduling-api and sessions-api all wire publishers and consumers.

Requested by @skilgoreT during Vishnu design. This issue is the implementation handoff for the shared module and its integration hooks; no cloud deployment is requested here.

## Existing implementation to build on

At inspected SOA revision `516d4e4d88228384001d6b3cadc4d68f3c5ddf4d`:

- [`OutboxMetrics` / `OutboxRelay`](https://github.com/saga-ed/soa/blob/516d4e4d88228384001d6b3cadc4d68f3c5ddf4d/packages/node/event-outbox/src/relay.ts) expose `onPublished` / `onPublishFailed`.
- [`ConsumerMetrics` / `EventConsumer`](https://github.com/saga-ed/soa/blob/516d4e4d88228384001d6b3cadc4d68f3c5ddf4d/packages/node/event-consumer/src/consumer.ts) expose `onProcessed`, `onFailed`, and `onDuplicate`.
- [`soa-observability` metrics](https://github.com/saga-ed/soa/blob/516d4e4d88228384001d6b3cadc4d68f3c5ddf4d/packages/node/observability/src/metrics.ts) already adapt those hooks to Prometheus counters and classify errors. Preserve and compose with existing metrics rather than replacing them or introducing competing global registries.
- [`soa-event-envelope`](https://github.com/saga-ed/soa/blob/516d4e4d88228384001d6b3cadc4d68f3c5ddf4d/packages/node/event-envelope/src/index.ts) supplies the versioned event envelope. Add a typed payload contract; do not casually change the fleet envelope.

**Correctness traps:** the current consumer calls `onProcessed` after `processEnvelope` returns, including its duplicate-skip branch. Therefore it is not a unique committed-handler counter. The current outbox relay explicitly uses a non-confirm channel; `onPublished` occurs after publish/backpressure handling but before the batch's database commit. It is neither broker-confirmed delivery nor proof of successful outbox transaction completion. Reinspect these seams before implementation and add explicit outcomes without silently changing existing metrics semantics.

Related: I#490 (closed), the OTel metrics-exporter work. Coordinate with the current observability implementation. This proposal adds an application event-statistics reporting contract; it does not replace Datadog or reopen the general metrics-exporter issue.

## Scope and integration

1. Create a reusable accumulator/reporter package, typed public API, runtime payload schema and package exports following SOA conventions.
2. Provide adapters/hooks for `soa-event-outbox` and `soa-event-consumer`, plus an explicit adapter for direct RabbitMQ publishers/consumers that bypass those packages. Record transport limitations rather than inventing success guarantees.
3. Support multiple publishers, exchanges, queues and named consumers inside one process. Bind role/capability metadata explicitly at startup so idle services still report MQ-P/MQ-C/MQ-P/C.
4. Compose safely with existing Prometheus/OTel hooks. Adding stats must not disable existing metrics, duplicate-register metric names, or let an observer exception alter a transaction/ack outcome.
5. Provide setup, configuration and shutdown examples plus a runnable synthetic-dev integration demonstration. Coordinate adopters in program-hub/rostering as linked follow-ups rather than assuming publishing a package instruments the fleet.

## Counter semantics

Define and document each lifecycle boundary:

| Measurement | Required meaning |
|---|---|
| Publish attempts | Attempts handed to the publishing path, including retries |
| Publish transport accepted | Client publish/backpressure operation completed; **not** a broker confirmation |
| Publish confirmed | Only when a confirm-capable transport positively confirms; otherwise unavailable |
| Publish failures | Failed attempts, classified by bounded reason code |
| Consumer deliveries | Deliveries received, including redeliveries |
| Handler/projection commits | New event handling completed and its transaction committed; exclude duplicate skips and rollbacks |
| Duplicate skips | Idempotency hits, reported separately from new committed work |
| Processing failures | Parse/schema/unsupported-version/handler/commit failures with bounded categories |
| Ack/nack outcomes | Distinguish settlement attempts/failures and requeue intent; an issued ack/nack is not broker-confirmed settlement or proof of DLQ arrival |

Use separate fields for redelivery and latency histograms if those observations are available. Define timer boundaries and aggregation (count/sum/fixed buckets); do not average per-instance percentiles. Expose queue depth/outbox pending only through explicit gauge samplers with their own timestamps and scope, not inferred counter arithmetic.

A publish-confirm outcome must not be relabeled “delivered to every consumer.” Fan-out legitimately produces more consumer commits than publishes. Publisher and consumer totals are not expected to match globally. Domain events *created* in a transaction are a separate measurement from messages *published*; leave creation counts unavailable unless a transaction-safe producer hook exists.

## Versioned reporting contract

Suggested event: `observability.event_stats.reported`, `eventVersion: 1`, carried in the normal event envelope, with a separately validated typed payload. Final naming follows repository event conventions.

Include:

- Contract version; service identity; environment; deployment/preview/slot scope; service revision; runtime instance identity; a unique process-start/boot epoch.
- A monotonically increasing report sequence within that epoch, report ID, observation time and process start time.
- Declared publisher/consumer capabilities and bounded stream dimensions: broker/vhost scope, exchange, queue, consumer name, event type and version, role. Do not include credentials/connection strings.
- **Cumulative counters since process start**, not only interval deltas. Include monotonic elapsed time for rate calculation, because wall clocks can skew.
- Availability/measurement semantics, latest-success timestamps where observed, and overflow/drop/reporting-error indicators. Unsupported means unknown, not zero.

Proposed operational default: publish approximately every 30 seconds with jitter and a configurable interval. Emit a startup/idle heartbeat and perform a bounded best-effort final flush. The interval is a default to tune, not a latency SLO.

Document a receiver algorithm and test vectors: deduplicate `(scope, instance, epoch, sequence)`, reject older snapshots from overwriting newer ones, compute nonnegative counter deltas over actual elapsed time, and aggregate distinct instances without double-counting. A later cumulative report bridges a missed report within the same epoch. Restart creates a new epoch; never subtract across epochs. Missing reports/expired heartbeats mean stale or unknown, not zero traffic. Carry timestamps and scope into durable Vishnu projections.

These are operational statistics, **not an exact accounting/audit ledger**. In-memory counters can lose the unreported tail on abrupt termination. Document that limitation; exact lifetime totals would need a separately designed durable mechanism. Do not claim exactly-once end-to-end accounting.

## Reporting transport and failure behavior

- Use each service's existing environment/slot-scoped publisher exchange with a dedicated telemetry routing key (proposed: `observability.event_stats.reported`). Vishnu owns its telemetry consumer queues and bindings; it must not steal messages from application queues. Audit wildcard business bindings before enabling reports. Use current fleet broker credentials; do not introduce per-service users or claim permission isolation those credentials do not provide.
- Prefer isolated reporting channel/connection behavior and bounded timeouts. Reporting must not block business publishes, commits or acknowledgements. No synchronous network work in per-event observation hooks.
- Never count stats reports as business events or recursively generate reports about reports. Exclude the stats namespace at all integration points, including Vishnu's stats consumer.
- Bound dimensions, memory, batch size and serialized message size. When dimensions overflow, use documented aggregation/drop counters; do not allocate unlimited per-event/user/entity keys. If reports are chunked, define atomic snapshot/chunk completeness; never interpret a partial report as zero for omitted streams.
- On transport outage, retain bounded cumulative state, coalesce pending snapshots, retry with bounded backoff/jitter and recover without an unbounded backlog. Define sequence behavior for retries. Avoid inserting every telemetry tick into the application's business outbox.
- Reporting on RabbitMQ shares its outage domain. Preserve an independent local Prometheus/OTel/log signal for reporter/broker failure so absence of reports is not the only evidence. Reuse existing observability where possible.
- Do not publish event payloads, event IDs as metric dimensions, user/student/entity identifiers, raw errors, SQL, credentials or unrestricted labels. Error categories must be bounded/sanitized.

## Acceptance criteria

- [ ] Published package includes schema, accumulator, periodic reporter, existing-hook composition, direct-transport adapter interface, configuration and lifecycle documentation.
- [ ] Producer-only, consumer-only and dual-role examples report MQ-P, MQ-C and MQ-P/C even with no traffic.
- [ ] Unit tests prove unique committed work is distinct from duplicate skips; rollback/commit failure never increments committed work; ack failure after commit is not misreported as an uncommitted handler.
- [ ] Tests distinguish client-accepted publish from confirmed publish, including outbox commit failure after a publish attempt. Unsupported guarantees remain unavailable.
- [ ] Reporting failure or observer exceptions cannot fail/requeue business work or alter existing metrics behavior. Timers and connections stop cleanly without hanging shutdown.
- [ ] Deterministic tests cover duplicate/out-of-order/missed reports, restarts, multiple replicas/consumers, fan-out, idle zeros versus unavailable counters, monotonic rate intervals and clock skew.
- [ ] Tests cover broker outages/reconnect, bounded retries/memory/cardinality/payload sizes, telemetry recursion exclusion, sanitized payloads and environment/preview isolation.
- [ ] A synthetic-dev demonstration runs at least one publisher and two consumer instances, including duplicate delivery and a failed handler; captured reports reconcile against the stated lifecycle boundaries and feed a minimal receiver/read-model example.
- [ ] Release notes document backward compatibility and hook semantics; attach service-adoption follow-ups and a Vishnu receiver/projection/UI follow-up with the versioned contract and examples.

## Out of scope

Full fleet rollout, dev/prod infrastructure deployment, replacing Datadog, business database replication, arbitrary event-payload capture, and claiming another service's end-to-end health from one counter. Adding publisher-confirm support may be a separately linked transport prerequisite; until implemented, report confirmed publish as unavailable.

Implementation is ready to start with package/API design and hook-boundary tests. The key delivery is a reliable shared semantic contract—not a timer around the existing ambiguously named counters.

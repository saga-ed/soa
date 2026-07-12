# SOA Correctness & Reliability Review — Event/PubSub/DB Core

**Scope:** Read-only pre-launch review of the reliability primitives in `saga-soa`
(`event-outbox`, `event-consumer`, `event-envelope`, `rabbitmq`, `postgres`,
`health`, `contract-check`, `api-core`). No files were modified.

## Summary

The event-driven stack is unusually well-engineered: the code is dense with
comments that correctly identify subtle failure modes (channel re-acquisition
after socket drop, `release(err)` on poisoned pg clients, poison-message
never-requeue, coherence asserts for preview isolation). Most of the classic
outbox/consumer bugs are already handled. The residual risk is concentrated in
**three delivery-guarantee gaps that are real and reachable in production**: (1)
the relay publishes without publisher confirms, so it can mark a row `published`
that the broker never persisted — a silent message-loss window that undercuts the
"at-least-once" promise; (2) the consumer dispatches up to `prefetch` messages
concurrently and un-awaited, so **event ordering is not preserved** even
per-aggregate, which is wrong for last-writer-wins projections; and (3) the relay
publishes an entire batch inside one pg transaction, so a single un-publishable or
persistently-backpressured row performs head-of-line blocking on the whole outbox
and forces duplicate re-publishes of its batch-mates every tick. Gaps 1 and 3 are
acknowledged in comments ("Per-row retry budgets + DLQ wiring are not yet
implemented"; "Widen soa-rabbitmq with newConfirmChannel()") but remain unshipped,
and `newConfirmChannel()` already exists in `soa-rabbitmq` — the fix is wiring, not
new capability. Secondary findings cover requeue poison-loops, health checks that
ignore broker health, and a preview-isolation guard that gives false confidence.

## Severity counts

| Severity | Count |
|----------|-------|
| S1 | 0 |
| S2 | 3 |
| S3 | 3 |
| S4 | 3 |

---

## Findings (most severe first)

### [CORR-1] Relay marks rows published without publisher confirms — silent message loss
**Severity S2 · Confidence H**

- **Location:** `packages/node/event-outbox/src/relay.ts:371-394` (publish), `249-296` (batch mark-published)
- **Claim:** The relay uses a plain `Channel` and treats `channel.publish()`
  returning truthy (or a subsequent `drain`) as success, then commits
  `published_at = NOW()` for the batch. `channel.publish` only means "buffered to
  the local socket" — it is *not* broker acknowledgement. A broker crash / failover
  / connection drop after the frame leaves the socket but before RabbitMQ persists
  it to disk loses the message, yet the row is durably marked published and will
  never be re-sent. This defeats the at-least-once guarantee the whole outbox exists
  to provide.
- **Evidence:** relay.ts:107-112 — *"Publishes use `persistent: true` for durability
  but do NOT wait for publisher confirms … A broker crash between `channel.publish`
  and disk persistence could drop messages. Widen soa-rabbitmq with
  `newConfirmChannel()` to restore strict at-least-once."* The capability already
  exists: `rabbitmq/src/connection-manager.ts:222 newConfirmChannel()` returns a
  `ConfirmChannel`, and its own doc-comment (lines 216-221) describes exactly this
  outbox use case ("without confirms, an async broker rejection … silently leaves
  the row marked published and the message lost"). The relay calls `newChannel()`
  (relay.ts:138), not `newConfirmChannel()`.
- **Impact:** Node A commits a domain write + outbox row. Relay tick selects it,
  `channel.publish` buffers it, `UPDATE … published_at = NOW()`, COMMIT. The broker
  node the connection was pinned to crashes before flushing to its message store
  (or an unroutable/rejected publish returns no error on a topic exchange with no
  mandatory flag). The event is gone; `published_at` is set; no consumer ever sees
  `iam.user.created`; the projection is permanently missing that user. No error, no
  metric, no retry.
- **Suggested action:** Switch the relay to `newConfirmChannel()` and only set
  `published_at` for rows whose confirm resolved (`waitForConfirms()` per batch, or
  per-publish callbacks). Rows without a confirm stay `published_at IS NULL` and are
  retried next tick (consumer dedup absorbs the resulting duplicate).

### [CORR-2] Consumer processes a batch concurrently and un-awaited — event ordering is not preserved
**Severity S2 · Confidence H**

- **Location:** `packages/node/event-consumer/src/consumer.ts:274-299` (consume callback), `240` (prefetch default 10)
- **Claim:** The `channel.consume` callback fires `void this.dispatch(channel, msg)`
  without awaiting, and `prefetch` defaults to 10. RabbitMQ delivers in order, but
  amqplib invokes the callback for each of the up-to-10 in-flight messages without
  waiting for the prior handler to finish, so up to 10 handler transactions run
  **concurrently**. There is no per-aggregate serialization anywhere. `consumed_events`
  provides dedup (exactly-once *application*) but says nothing about *order*.
- **Evidence:** consumer.ts:298 `void this.dispatch(channel, msg);` (fire-and-forget)
  under `{ noAck: false }`; prefetch `this.opts.prefetch ?? 10` (line 240). Each
  dispatch opens its own `pool.connect()` + independent `BEGIN…COMMIT`
  (processEnvelope, lines 509-539). The relay deliberately orders its own output
  (`ORDER BY occurred_at`, relay.ts:272) which advertises an ordering the consumer
  then discards.
- **Impact:** Two events for the same aggregate — `iam.user.updated`(email=B) then
  `iam.user.updated`(email=C) — are delivered in order but their handlers race. The
  handler for C commits before the handler for B, leaving the projection at email=B
  (stale) permanently. Any last-writer-wins or state-machine projection (status
  transitions, membership add/remove) is corruptible under normal throughput, not
  just under failure.
- **Suggested action:** Document at-least-once as *unordered* explicitly, and give
  adopters an ordered mode: either default `prefetch: 1` with awaited dispatch, or a
  per-`aggregateId` in-process serialization queue (hash aggregateId → worker) so
  same-aggregate events are strictly serialized while distinct aggregates stay
  parallel.

### [CORR-3] Whole outbox batch publishes in one transaction — one bad row stalls the pipeline and re-publishes batch-mates
**Severity S2 · Confidence M**

- **Location:** `packages/node/event-outbox/src/relay.ts:249-318` (`drainBatch`), `284-296`
- **Claim:** `drainBatch` publishes every selected row, then does a single
  `UPDATE … published_at` and one `COMMIT`, all inside one transaction. If
  `publishRow` throws for row *k* (e.g. drain timeout under sustained backpressure,
  message exceeding `frame_max` which amqplib throws on synchronously, or a channel
  error), the whole transaction rolls back — so rows `1..k-1` that were *already
  handed to the broker* keep `published_at IS NULL`. Because rows are selected
  `ORDER BY occurred_at`, the same poison row sits at the front of every subsequent
  batch and blocks all newer events indefinitely.
- **Evidence:** relay.ts:284-296 — rows published in a loop, then one batched
  `UPDATE … WHERE event_id = ANY($1)` and `COMMIT`. On any throw, the `catch`
  ROLLBACKs (297-310) and rethrows; `attempts`/`last_error` columns exist in the
  schema (`event-outbox/src/schema.ts:23-24`) but the relay never increments or
  reads them. relay.ts:86 confirms: *"Per-row retry budgets + DLQ wiring are not yet
  implemented."*
- **Impact:** A single 200KB payload that exceeds the negotiated frame max, or a
  persistently flow-blocked broker, makes `publishRow` throw at the same row every
  500ms. That row's batch-mates (already delivered to the broker on the prior
  attempt) are re-published every tick → duplicate storm (absorbed by consumer
  dedup, but noisy), AND every event with a later `occurred_at` is never published —
  the service's entire event stream halts silently while `outbox_event` grows
  unbounded.
- **Suggested action:** Mark rows published individually as each publish confirms
  (pairs naturally with CORR-1's confirm channel), and add a per-row `attempts`
  budget that routes a row exceeding it to a dead-letter/`last_error` state so it
  stops blocking the head of the queue.

### [CORR-4] No-DLQ handler errors nack-with-requeue with no cap or backoff — tight poison-requeue loop
**Severity S3 · Confidence H**

- **Location:** `packages/node/event-consumer/src/consumer.ts:392-411` (`dispatch`)
- **Claim:** When `dlq` is not configured, a handler error nacks **with requeue**
  (`requeue = poison ? false : !this.opts.dlq` → `true`). There is no retry cap and
  no delay, so a *non-transient* handler failure (a projection FK violation, a bug,
  a payload the handler rejects) is redelivered immediately and fails again in a
  hot loop.
- **Evidence:** consumer.ts:403 `const requeue = poison ? false : !this.opts.dlq;`
  Only `MalformedEnvelopeError` and `ConsumerVersionMismatchError` are classified
  poison (line 400-402); a normal handler `throw` is not, so it requeues. The doc
  comment (consumer.ts:139-141) frames this as "transient errors retry" but nothing
  distinguishes transient from permanent.
- **Impact:** A consumer deployed without `dlq` (the wiring is optional) that hits a
  deterministic handler bug on one message pins a CPU core, spams `error` logs and
  `onFailed` metrics thousands of times per second, and blocks that delivery slot —
  until someone manually purges the queue. Since `dlq` is opt-in, a service can ship
  this way by omission.
- **Suggested action:** Make DLQ (or a bounded requeue-with-delay via
  `x-delivery-count` / a retry header) the default, or add a max-redelivery count
  after which a no-DLQ consumer drops-and-alerts instead of looping.

### [CORR-5] `mountHealthRoutes` readiness ignores broker/relay health — service reports healthy while the event pipeline is dead
**Severity S3 · Confidence M**

- **Location:** `packages/node/health/src/health.ts:34-50`
- **Claim:** `/health/details` only calls `pingDb`; there is no probe for the
  RabbitMQ connection, the relay's publish health, or consumer subscription state.
  A service whose broker connection is circuit-open (outbox silently backing up, per
  `rabbitmq/src/connection-manager.ts:306-320` `log-and-continue` mode) still returns
  `status: 'healthy'` and stays in the load-balancer rotation.
- **Evidence:** health.ts:36-42 builds `dependencies` from `pingDb` alone; the
  broker is never consulted. (The richer `readiness.ts` supports arbitrary probes,
  but nothing in `health.ts` wires a broker probe, and adopters using the simpler
  route get DB-only health.)
- **Impact:** Broker outage → `ConnectionManager` trips the breaker and (in
  non-prod / `log-and-continue`) keeps serving. `/health` and `/health/details`
  stay green. Ops dashboards show all-healthy while events stop flowing and
  `outbox_event` grows; the incident is invisible until a downstream projection is
  noticed stale.
- **Suggested action:** Have services expose broker/relay liveness through a
  `readiness.ts` probe (connection state !== CIRCUIT_OPEN/DISCONNECTED, and/or
  outbox-lag under a threshold), and document that the DB-only `mountHealthRoutes`
  is insufficient for event-driven services.

### [CORR-6] Preview-isolation coherence guard doesn't cover the exchange passed to `OutboxRelay` — false confidence, cross-PR leak still possible
**Severity S3 · Confidence M**

- **Location:** `packages/node/event-outbox/src/create-pool.ts:97-119`; `event-envelope/src/preview-tag.ts:16-19`; `relay.ts:157,371`
- **Claim:** `createOutboxPool` asserts DB-`?schema=` and `EVENT_PREVIEW_TAG` are set
  as a pair, to prevent half-isolated preview state. But `applyPreviewTag` is *not*
  applied inside `OutboxRelay`/`EventConsumer` — the caller passes a raw `exchange`
  string. A caller can satisfy the coherence assert (schema + tag both set) yet pass
  an **untagged** `exchange: 'iam.events'` to the relay, publishing PR traffic onto
  the canonical exchange. The assert's "can't leak past first boot" guarantee only
  covers the DB axis it can see, not the exchange name it never inspects.
- **Evidence:** create-pool.ts:98-119 checks `EVENT_PREVIEW_TAG` vs `?schema=` only.
  relay.ts:157 `assertExchange(this.opts.exchange, …)` and :371 `channel.publish(this.opts.exchange, …)`
  use the caller-supplied string verbatim; no `applyPreviewTag` call exists in the
  outbox or consumer packages (it lives only in `event-envelope`).
- **Impact:** In a shared-broker preview environment, a service whose boot wiring
  tags the DB schema and sets `EVENT_PREVIEW_TAG` but forgets to wrap the exchange
  name in `applyPreviewTag` publishes pr-142's events onto the production/canonical
  `iam.events` exchange — exactly the cross-PR leak the coherence assert claims to
  prevent — while startup passes cleanly.
- **Suggested action:** Either apply `applyPreviewTag` to `exchange`/`queue`/bindings
  inside the relay and consumer, or extend the coherence assert to verify the
  exchange/queue names actually carry the resolved tag when `EVENT_PREVIEW_TAG` is set.

### [CORR-7] Relay fatal-error rethrow surfaces as `unhandledRejection`, not `uncaughtException` (comment/contract mismatch)
**Severity S4 · Confidence M**

- **Location:** `packages/node/event-outbox/src/relay.ts:56-62, 216-225, 196-198`
- **Claim:** The `onFatalError` doc says the default rethrows "out of `tick()` so the
  parent process surfaces it via `process.on('uncaughtException')`". But `tick()` is
  invoked as `void this.tick()` inside `setTimeout` (line 197), so a rethrow becomes
  an **unhandled promise rejection**, handled by `process.on('unhandledRejection')`,
  not `uncaughtException`. Operators wiring a crash-on-fatal handler against the
  documented event would miss it.
- **Evidence:** relay.ts:197 `this.timer = setTimeout(() => { void this.tick(); }, interval);`
  and relay.ts:222-224 `else { throw e; }`. A throw from a `void`-ed async call is an
  unhandled rejection.
- **Impact:** Low — Node 22 crashes on unhandled rejections by default, so the
  process still dies. But a service that installed only an `uncaughtException` guard
  (per the comment) to convert fatal outbox errors into graceful shutdown would not
  intercept it. Mostly a documentation/contract accuracy issue.
- **Suggested action:** Fix the comment to say `unhandledRejection`, or route the
  fatal rethrow through an explicit `process.emit('uncaughtException', e)` / a
  registered fatal callback so the documented contract holds.

### [CORR-8] `consumed_events` retention has no floor relative to the broker redelivery window
**Severity S4 · Confidence L**

- **Location:** `packages/node/event-consumer/src/consumed-events-retention.ts:37-48, 58-64`
- **Claim:** Retention validates only `retentionDays > 0`. If an operator sets a low
  TTL (e.g. 1 day) while a message can linger unacked in a durable queue longer than
  that (consumer down for the weekend, then broker redelivers on reconnect), the
  dedup row can be swept before the redelivery arrives, and the event is processed
  twice.
- **Evidence:** Guard at lines 38-43 only rejects `<= 0`. The comment (lines 9-11)
  asserts the TTL is "far beyond any realistic broker redelivery window" but nothing
  enforces a sane minimum.
- **Impact:** Low and configuration-dependent, but a mis-set short TTL silently
  reintroduces duplicate application of the very events the table exists to
  de-duplicate.
- **Suggested action:** Enforce a minimum TTL floor (e.g. reject `< 7` days, or
  document and validate against the queue's max message age) and warn loudly below a
  threshold.

### [CORR-9] Ordering by `occurred_at` reflects client clock + write-time, not commit order
**Severity S4 · Confidence M** *(compounds CORR-2)*

- **Location:** `packages/node/event-outbox/src/write-outbox.ts:26-40`; `relay.ts:272`; `event-envelope/src/index.ts:83`
- **Claim:** `occurred_at` is set at `buildEnvelope` time from the app clock
  (`new Date()`), and the relay orders by it. A transaction that begins earlier
  (earlier `occurred_at`) but commits later becomes visible to the relay *after* a
  later-timestamped transaction that committed first — so even the relay's own output
  can be out of causal/commit order, independent of CORR-2's consumer concurrency.
- **Evidence:** envelope index.ts:83 `occurredAt: (args.occurredAt ?? new Date()).toISOString()`;
  relay.ts:272 `ORDER BY occurred_at`. No monotonic sequence / commit-LSN column
  exists in `outbox_event` (schema.ts:11-25).
- **Impact:** Low on its own (windows are milliseconds) but it means the stack has no
  true total order at any layer; adopters must not assume ordered delivery.
- **Suggested action:** If ordering guarantees are ever promised, add a
  `BIGSERIAL`/sequence column and order by it; otherwise document explicitly that
  delivery is unordered end-to-end.

---

## Areas reviewed

- **event-outbox** (`relay.ts`, `write-outbox.ts`, `create-pool.ts`, `schema.ts`) — full delivery path traced.
- **event-consumer** (`consumer.ts`, `consumed-events-retention.ts`, `schema.ts`) — full dispatch/idempotency/DLQ path traced.
- **event-envelope** (`index.ts`, `preview-tag.ts`) — envelope schema, trace propagation, preview tagging.
- **rabbitmq** (`connection-manager.ts`) — reconnection, circuit breaker, confirm-channel capability.
- **postgres** (`postgres-provider.ts`) — pool config, idle-client error handling, IAM-token refresh, `idle_in_transaction_session_timeout` guard. **No findings** — pooling and self-heal logic are correct and well-guarded.
- **health** (`health.ts`, `readiness.ts`) — probe semantics, timeouts.
- **contract-check** (`check.ts`) — snapshot byte-diff, pins coverage, drop-protection. **No correctness findings** — the three layers enforce the frozen-schema + pins-subset contract soundly.
- **api-core** (`express-server.ts`) — CORS, body-parser guard, controller bootstrap. **No request-context-leakage finding** — controllers are singletons with no per-request mutable state observed; body-parser double-read guard is correct.

## Areas NOT reviewed (or only skimmed)

- **pubsub-core / pubsub-server / pubsub-client** — the real-time UI-push family (distinct from the event-* durable stack). Not traced; per `packages/node/CLAUDE.md` these are explicitly not the durable-eventing path. Recommend a follow-up pass if browser-facing pubsub is launch-critical.
- **redis-core** (`redis-connection-manager.ts`, `aws-redis-loader.ts`) — not read; connection-loss/reconnect semantics unverified.
- **rabbitmq** `publisher.ts` / `consumer.ts` / `queue.ts` — only `connection-manager.ts` was read; the higher-level publisher/consumer wrappers were not traced.
- **api-core** GraphQL/tRPC/TypeGraphQL server paths, `loadControllers`, middleware error propagation — only the Express path was read.
- **db** (MongoDB) — not reviewed.
- **observability** metrics wiring — referenced but not audited for correctness of lag/depth gauges.
- **event-integration-tests / event-test-harness** — not used to validate the above findings (review was static; findings marked H are code-evident, M/L would benefit from an integration repro).

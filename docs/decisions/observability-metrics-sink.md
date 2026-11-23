---
status: Proposed
---

# Where soa-observability domain metrics land

Issue: saga-ed/soa#595. Related: #535 (MQ stats reports for Vishnu).

## Context

`createObservability()` (`packages/node/observability/src/metrics.ts`) registers
domain metrics on a per-service prom-client registry served at `GET /metrics`:

| Metric | Kind | Source |
|---|---|---|
| `outbox_unpublished_count` | gauge, `count(*)` on collect | `addOutbox` |
| `events_published_total`, `events_publish_failed_total` | counters | `addOutbox` |
| `events_processed_total`, `events_failed_total`, `events_duplicate_total` | counters | `addConsumer` |
| `consumed_events_count` | gauge, `count(*) WHERE consumer_name=$1` on collect | `addConsumer` |
| `gauge_collect_failures_total` | counter | always |

Nothing scrapes `/metrics`, so none of these are recorded anywhere. Datadog has no
such metrics (checked 2026-11-23), and `aws.amazonmq.*` has no per-queue
dimension. During a prod rollout the "queue is quiet" check needs the RabbitMQ
console.

Adopters today: iam-api, sessions-api, content-api, scheduling-api and
programs-api each have one outbox. scheduling-api also has one consumer.

What already exists:

- **App-side EMF.** authz-api writes CloudWatch Embedded Metric Format lines
  (`rostering/apps/node/authz-api/src/sectors/authz/emf.ts`, namespace
  `SagaAuthz/Projection`, dimensions `Environment`+`Consumer`). Both accounts have
  those metrics, so awslogs-to-EMF already works in the fleet with no extra IAM.
- **Broker-side poller.** `iac/cloudformation_templates/alarms/rabbitmq_consumer_count`
  is a Lambda that runs once a minute, reads the RabbitMQ management API, and
  publishes `Saga/RabbitMQ` `MessagesReady` / `ConsumerCount` / `QueueMissing`
  per `Vhost`+`Queue`. It covers only the queues listed in its SSM parameter.
  In prod that is one coach queue; in dev it publishes nothing.

## Options

| | Sink | Pro | Con |
|---|---|---|---|
| A | **EMF log line to CloudWatch metrics** | Already proven (authz-api). Supports alarms and dashboards. No sidecar, no scraper, no new IAM. | Custom-metric charge per series. Info-level lines must reach CloudWatch. |
| B | Periodic plain log snapshot (Logs Insights only) | Only cost is log ingest. | No metrics, so no alarms. Every query is ad hoc. |
| C | Datadog agent or OpenMetrics scrape of `/metrics` | Labels kept. Lands next to the rest of DD. | Every `event_type` label value becomes a Datadog custom metric. Also needs a scraper per task. Rejected on cost. |
| D | ADOT / OTel collector sidecar to CloudWatch | Standard. | A sidecar on every task is more moving parts and cost than A. |
| E | #535 MQ stats reports only | Feeds Vishnu. | Shares RabbitMQ's outage domain. #535 itself asks for an independent local signal. |

## Decision (proposed)

**A, with the split below.** Queue depth and DLQ growth are broker facts, not
app facts.

1. **App side (soa-observability): EMF, opt-in.**
   - Add something like `startEmfReporter(observability, { environment, intervalMs })`
     to soa-observability. It reads the **existing registry**
     (`registry.getMetricsAsJSON()`) and doesn't mint competing counters (the #535
     constraint). It writes one EMF line per interval through the service logger.
   - Namespace: `SagaSoa/Events` (fleet convention `Saga<Area>/<Component>`).
   - Dimensions: `[Environment, Service]`. Consumer metrics also take `Consumer`.
     - `Environment` is the telemetry env, `dev` or `prod`, never NODE_ENV and never
       a preview or slot tag. `SagaAuthz/Projection` already shows `twin` and
       `dev-sandbox` values creating extra series.
     - `event_type`, `event_version` and `reason_class` become root properties
       (searchable in Logs Insights), **not dimensions**.
   - Counters are emitted as **per-interval deltas** (diff against the previous
     tick; the first tick after start emits 0). The cumulative prom value would
     turn CloudWatch `Sum` across tasks and restarts into nonsense.
   - Gauges are emitted as values. With several tasks or both blue/green colours,
     read them with the `Maximum` statistic.
   - `collectDefaultMetrics` (process/heap) is **not** emitted. ECS Container
     Insights already covers it.
   - Semantics are unchanged: `events_processed_total` also counts duplicate
     skips, because `onProcessed` fires on that branch (see #535). The EMF metric
     documents that and doesn't change it.
2. **Broker side (iac, proposal only): queue depth and DLQ growth.** Add the
   rollout-relevant queues and their DLQs to the `rabbitmq_consumer_count`
   poller's SSM list in both accounts, and run the poller in dev. That gives
   per-queue `MessagesReady` without any app change. This needs a separate
   iac PR, outside this decision's implementation.

### Interval and DB load

The gauges run a `count(*)` on each collect. Today nothing collects, so turning
the reporter on adds new DB load: tasks × gauges per interval.

- `outbox_unpublished_count` is cheap while the backlog is small.
- `consumed_events_count` grows without bound. The PK prefix
  `(consumer_name, event_id)` makes it an index scan, but it is still O(rows).

Proposal: counters every 60 s; gauges every 300 s; `consumed_events_count` off by
default (opt-in flag), since `events_processed` deltas answer "is the consumer
progressing" without counting the table.

## Cost

Prices: us-west-2 public price list, fetched 2026-11-23. Custom metrics cost
$0.30 per metric-month for the first 10k. Log ingest costs $0.50/GB.

| Per service | Series per env | $/month per env |
|---|---|---|
| Outbox only: `OutboxUnpublishedCount`, `EventsPublished`, `EventsPublishFailed`, `GaugeCollectFailures` | 4 | $1.20 |
| Each consumer adds `EventsProcessed`, `EventsFailed`, `EventsDuplicate` (+`ConsumedEventsCount` if enabled) | 3–4 | $0.90–1.20 |

- Current adopters: 5 outboxes and 1 consumer gives 23–24 series per env.
  Across dev and prod that is about **$14/month**.
- Log ingest: one line of about 600 B per task per minute is about 26 MB per
  task-month, roughly $0.01 per task. That is negligible.
- Series billing is per distinct name × dimension values. A misconfigured
  `Environment` (a preview tag) is the main way this grows, hence the dev/prod
  rule above.

## Datadog re-ingestion

- **Metrics.** In a 30-day Datadog metric search, nothing from the
  `SagaAuthz/Projection` namespace shows up, although it has been live in prod
  CloudWatch. No `AWS::CloudWatch::MetricStream` exists in iac. So the AWS
  integration doesn't currently appear to collect custom namespaces. The
  integration's own setting was **not** read (it isn't in iac and isn't exposed to
  the tooling used here).
  - **Check before rollout:** Datadog AWS integration tile → Metric Collection →
    "Collect custom metrics" off, or a namespace filter excluding `SagaSoa/*`.
  - If custom collection is ever turned on, add `SagaSoa/Events` (and
    `SagaAuthz/*`) to the excluded namespaces.
- **Logs.**
  - Prod forwards only error-level lines to Datadog, and EMF lines are info.
  - The dev subscription (`iac/.../datadog_log_subscriptions`, default
    `FilterPattern ""`) forwards every line for the listed services, so the EMF
    lines would reach DD logs in dev. That's about 1,440 lines per task per day. If
    that matters, add a DD log exclusion filter on `@_aws.CloudWatchMetrics:*`.

## Consequences

- Services opt in by calling the reporter with the telemetry env. Services that
  don't call it see no change, and `/metrics` keeps working.
- During a rollout, the "queue quiet" confirm becomes a CloudWatch query:
  - `SagaSoa/Events OutboxUnpublishedCount` and `EventsProcessed`
  - `Saga/RabbitMQ MessagesReady` for the queue and its DLQ
- Follow-ups:
  - rostering iam-api wiring (first adopter)
  - iac poller queue list for DLQs
  - program-hub adopters

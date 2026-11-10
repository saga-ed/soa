# Vishnu telemetry and backend discovery

Date: 2026-10-20  
Method: read-only local source inspection; no live Datadog, AWS, database, or broker inspection.

## Source revisions

| Checkout    | HEAD                                       |
| ----------- | ------------------------------------------ |
| soa         | `516d4e4d88228384001d6b3cadc4d68f3c5ddf4d` |
| program-hub | `593b52855a0c6e31a7c880a3f69cab7767ec5354` |
| iac         | `6670aee5a66deabd2421fa0af38bfee9c1887dd3` |
| rostering   | `fe9eb74c4bbba824cb42124deb3bcab01e607d0d` |

These identify local source, not deployed revisions. Rostering's SHA was recorded; this pass did not repeat the earlier IAM implementation investigation.

## Reusable backend

Use `program-hub/apps/node/scheduling-api` as the small service composition reference.

- `src/trpc.ts`: typed context, Inversify dependencies, IAM JWT/JWKS verification, sanitized unexpected errors, and distinction between invalid identity and unavailable authentication infrastructure. Add explicit staff authorization for Vishnu; authentication is not sufficient.
- `src/inversify.config.ts`: OutboxRelay and EventConsumer wiring, shared observability, preview-tagged exchanges/queues, versioned handlers, and DLQ configuration.
- `src/event-handlers/programs-projection.ts`: programs and periods projected into local Postgres tables; multiple event versions remain registered for replay/lag compatibility.
- `soa/packages/node/event-consumer/src/consumer.ts`: deduplication insertion and handler execution share a database transaction; commit precedes broker acknowledgement.
- `soa/packages/node/event-envelope/src/index.ts`: event ID/type/version, aggregate identity, occurredAt, optional traceparent/tracestate, correlationId, and causationId. The inspected envelope has no explicit producer or deployment field. Derive trusted scope from subscription configuration or design an intentional contract.

Both programs-api and scheduling-api pin:

| Package            | Version       |
| ------------------ | ------------- |
| soa-event-consumer | `0.1.0-dev.7` |
| soa-event-envelope | `0.1.0-dev.3` |
| soa-event-outbox   | `0.1.0-dev.8` |
| soa-observability  | `0.1.0-dev.5` |
| @trpc/server       | `^11.18.0`    |

Source package implementations are not proof of the exact installed or deployed implementation.

## First topology slice

Use IAM → programs IAM projection and programs → scheduling program/period projection, their databases, and dashboard HTTP calls. Do not imply these adjacent edges constitute one causal workflow.

The current programs-api also consumes `scheduling.slot.*`; include scheduling → programs as a real reciprocal topology case. The programs API now has numerous additional reconciliation consumers, so copying its complete composition would introduce unnecessary complexity into Vishnu.

Separate declared topology, event-derived application facts, and cached operational observations. Preserve environment and deployment identity on all three.

## Datadog configuration found

Sources relative to `iac`:

- `cloudformation_templates/observability/datadog_monitors/service_mesh/template.yaml`: per-service 5xx count, error percentage, and p95 monitors.
- `cloudformation_templates/observability/datadog_monitors/rabbitmq/template.yaml`: broker ready-message and unacknowledged-message monitors.
- `cloudformation_templates/observability/datadog_monitors/ecs/template.yaml`: OOM, task churn, and desired-count monitoring.
- `cloudformation_templates/observability/datadog_monitors/README.md`: historical verification and known integration limitations.
- `cloudformation_templates/observability/datadog_agent_daemon/template.yaml`: HTTP/gRPC OTLP intake, traces/metrics pipelines, histogram distribution mode, and host/container attribution configuration.

The monitors README records verification on 2026-08-31 of `trace.http.server.request.{hits,errors}`, request-duration distributions, and references `trace.rabbitmq.process.*`. These are promising query starting points, not current live verification.

Agent logs collection is intentionally disabled because the forwarder supplies logs. Do not enable duplicate ingestion.

`program-hub/infra/scheduling-api/service-template.yaml` declares `deployment.environment`, `deployment.environment.name`, and `deployment.identifier`. The latter distinguishes variants such as sandboxes and blue/green deployments. A service name plus environment alone may merge distinct variants.

Broker AWS integration metrics use `environment:` and `broker:` tags rather than APM's `env:` convention. Normalize identity explicitly rather than applying one query filter across every source.

## Gaps requiring verification

The iac monitors README records these historical limitations:

- RabbitMQ AWS metrics are broker-level, without per-queue tags, and collected only for prod.
- Dev AWS ECS metrics/events were absent.
- ALB metrics were absent in both accounts, leaving load-balancer-generated failures outside application trace coverage.

Re-verify these observations before treating them as current requirements or incidents.

The shared observability package exposes Prometheus counters for publishing, processing, failures, and duplicates, plus outbox backlog and consumed-event gauges. No OpenMetrics/Prometheus scraping configuration was found in the checked program-hub infrastructure and Datadog observability configuration. This search is not exhaustive evidence of absence. OTLP metrics intake does not establish that a Prometheus `/metrics` endpoint is scraped.

## Signal ownership

| Desired signal                                    | Preferred source or next investigation                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| HTTP rates, errors, latency, monitor state        | Read-only server-side Datadog queries                                        |
| Publish/process/failure counts                    | Existing shared observability metrics; verify ingestion first                |
| Queue backlog, unacknowledged messages, DLQ depth | Verify Datadog queue integration; broker totals are insufficient             |
| Exact downstream projection progress              | Existing consumer telemetry or consumer-originated committed-progress signal |
| Required domain facts                             | Existing domain events; add producer contracts only for missing facts        |
| Service unavailable versus quiet                  | Availability/freshness evidence, not business-event silence                  |
| Declared endpoint/event-type counts               | Contract/code inventory, not sampled traces                                  |
| Deployment identity                               | Trusted subscription and infrastructure metadata                             |

Vishnu receiving an event proves only Vishnu's delivery. It does not prove another consumer committed a projection. A downstream progress event, if needed, must reflect committed state.

Outbox count measures backlog cardinality, not time lag. Time since the last business event measures inactivity, not lag. Avoid deriving a misleading projection-lag value from either.

Do not estimate exact event traffic from retained trace samples. Verify the underlying metric's aggregation and ingestion semantics before presenting rates.

## Recommended next gate

Confirm current metric/tag inventory and read-only query access, then connect one complete edge with explicit unknown/stale/zero behavior. Turn verified gaps into targeted collection or producer-contract work. Keep Datadog credentials out of the browser and avoid copying domain payloads into diagnostic projections unless they are actually required.

No live coverage, production health, deployed package versions, or active broker subscriptions were established by this investigation.

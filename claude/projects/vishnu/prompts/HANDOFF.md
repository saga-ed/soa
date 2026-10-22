# Vishnu discovery handoff

Date: 2026-10-19
Branch: `work/vishnu-discovery-handoff`
Status: requirements, implementation plan, and initial local source investigation. No application code or infrastructure changes have been made. No live Datadog/AWS/database inspection has been performed.

## Objective and user direction

Build Vishnu, an environment-aware saga-mesh visualization and diagnostic viewer. Original brief: [vishnu.md](vishnu.md).

Display data systems → saga mesh → applications from left to right, with actual flow direction indicated on edges. Include REST/tRPC, RabbitMQ, and projective-table relationships. Use orthogonal routing with rounded corners. Edge width represents endpoint count or distinct event count; color intensity represents traffic rate. Blocks expose scalars such as errors. Support zoom, filtering to a service, and drill-down from connections/scalars to evidence. Target synthetic-dev, wootdev, and production.

The user emphasized the extensive existing use of Datadog. Treat Datadog as the primary telemetry foundation. First inspect existing instrumentation, dashboards, monitors, logs, APM, RUM, infrastructure/custom metrics, and triage practices. Add direct collection only for demonstrated gaps. The initial plan understated existing telemetry maturity; subsequent source inspection corrected that assumption.

## Completed investigation

Inspected local checkouts under ~/dev: soa, rostering, program-hub, student-data-system, thrive. The requested student-datasystem checkout is named student-data-system. ~/dev/qboard was absent on this machine, although synthetic-dev documentation references it. Do not claim qboard implementation was inspected.

Findings below describe local source, not verified deployed behavior. Consumer repositories pin shared package versions; current soa source does not establish which implementation is deployed.

### soa shared telemetry

Paths relative to soa repository root:

- `packages/node/observability/src/tracing.ts`: Node OpenTelemetry SDK with OTLP HTTP export; HTTP/Express/pg/amqplib auto-instrumentation and RuntimeNodeInstrumentation. Datadog-aware ECS container attribution. Service name and optional DD_VERSION/OTEL_SERVICE_VERSION; resource attributes from environment. OTLP endpoint overrides; default localhost:4318/v1/traces. OTEL_TRACES_DISABLED switch. PII-sanitizing exporter. pg requires parent span to suppress background pool noise; fs/dns/net instrumentation disabled. Verify runtime metric export in deployed configuration rather than assuming registration proves delivery.
- `packages/node/observability/src/metrics.ts`: Prometheus exposition with events_published_total, events_publish_failed_total, events_processed_total, events_failed_total, events_duplicate_total, outbox_unpublished_count, consumed_events_count, gauge_collect_failures_total, and default process metrics. Event labels include event_type/event_version and bounded reason_class where applicable. Confirm Datadog scraping, mapped metric names, and tags. Outbox count is backlog, not a measured time lag.
- `packages/node/logger/src/pino-logger.ts`: active OTel trace_id/span_id in log records; deployment.environment.name and deployment.identifier from OTEL_RESOURCE_ATTRIBUTES. These distinguish sandbox deployments beyond service/version alone.
- `packages/node/event-outbox/src/relay.ts`: restores context saved in outbox row metadata, creates producer span, injects new context into outgoing envelope. Attributes identify RabbitMQ exchange, routing key, event ID/type/version/aggregate.
- `packages/node/event-consumer/src/consumer.ts`: extracts context and creates consumer span with queue, consumer.name, and event identity. Processing occurs in span context; exceptions set error status.
- `packages/node/event-outbox/src/write-outbox.ts` and `packages/node/event-envelope/src/index.ts`: additional sources for event metadata/contracts; investigate exact context capture across callers.
- `packages/web/rum-util/src/index.ts` and README.md: shared Datadog RUM wrapper, documented consumers saga_dash/qboard_connectv3/janus_login, app/environment/version context, tracing URL configuration, source-tagged errors/actions. Defaults include 100% session sampling and 5% replay; do not equate session sampling with backend trace retention. Supports resource, interaction, long-task tracking. Configuration can disable RUM. Documentation specifies SSM/CI wiring and distributed tracing CORS headers.
- `packages/node/api-core/src/express-server.ts` and `packages/node/api-util/src/utils/cors.ts`: shared browser trace-header handling.
- `packages/node/saga-stack-cli/src/core/manifest/services.ts`, runtime/repos.ts, and tools/synthetic-dev/{README.md,getting-started.md}: topology/local deployment discovery starting points. Qboard supplies connect-api/connect-web, with Mongo and LiveKit/coturn relationships described in synthetic-dev docs.

### rostering

- `apps/node/iam-api/src/main.ts`: initializes tracing as iam-api; serves /metrics.
- `apps/node/iam-api/src/inversify.config.ts`: observability and outbox relay setup.
- User/group data modules write transactional outbox events.
- package.json pins soa-observability 0.1.0-dev.1 and soa-event-outbox 0.1.0-dev.4 in inspected checkout.

### program-hub

- programs-api and scheduling-api main.ts initialize tracing and expose /metrics.
- Both inversify.config.ts files wire outbox and consumer metrics.
- programs-api consumer `programs-api.iam-projection` subscribes to iam.user.*; see event-handlers/iam-projection.ts.
- scheduling-api consumer `scheduling-api.programs-projection` subscribes to programs.program.* and programs.period.*; see event-handlers/programs-projection.ts.
- Exchange/queue names are preview-tagged. Environment/deployment scope must be retained in topology identity.
- Concrete first vertical slice: IAM → RabbitMQ → programs projection → RabbitMQ → scheduling projection, plus their databases and an appropriate frontend.

### student-data-system

- `apps/node/ads-adm-api/src/consumer/register-handlers.ts`: program and tutoring-period upsert projection handlers, default pgm.events exchange with pgm.# binding; contract pins referenced in consumed-events.json.
- Inspected main.ts does not explicitly initialize shared tracing. This is a verification question, not proof of absent deployed telemetry (external bootstrap/instrumentation may exist).
- Shared event-consumer dependency exists, but production consumer lifecycle/wiring was not fully traced. Do not assume handler definitions establish active subscriptions.
- Reconcile its pgm.* contract naming against program-hub's programs.* bindings before asserting a working cross-repository edge.

### thrive

- Services include sessions, assets, jobs, transcripts, analysis, and IAM APIs using shared logger/API/RabbitMQ packages.
- `packages/node/thrive-trace/src/trace-emitter.ts`: separate persisted workflow traces/spans, UUID identifiers, parent relationships, durations/status/errors, Prisma writes.
- `packages/node/thrive-trace/src/trace-query.service.ts`: trace queries and DAG construction.
- `docs/trace-whats-changed.md`: context for workflow/broker integration and existing admin trace UI; treat documentation as supporting evidence and verify implementation.
- Existing workflow IDs must not be treated as Datadog/OTel trace IDs. Investigate an explicit correlation mechanism before integrating diagnostics.

## Implementation plan

1. Discover deployed topology and Datadog coverage. Inventory environments/services/databases/broker routing/projections/compute. Review existing access and triage skills. Produce a coverage/correlation matrix with source, service identity, environment/deployment tags, availability, sampling, freshness, and gaps.
2. Define a graph schema. Separate declared topology from observed activity so idle paths remain visible. Model direct calls, publisher/exchange/queue/consumer relationships, and projection reads/writes. Retain provenance and environment/deployment scope. Define endpoint/event counts separately from traffic rates.
3. Implement Datadog-backed queries and aggregation. Reuse existing metrics/traces/logs/RUM, cache results, refresh topology less frequently than health, and preserve missing/stale/zero distinctions. Use additional adapters only when justified by evidence.
4. Build graph interaction using fixtures, then real telemetry. Left-to-right groups, rounded orthogonal edges, legends/scales, block scalars, search/zoom/filter/service-neighborhood view. No UI framework or layout library selected yet.
5. Add evidence drill-down. Service health/dependencies/releases; edge rate/latency/failures/event or endpoint breakdown; scalar time series; relevant Datadog links. Distinguish publish failure, queue delay, processing failure, and projection lag where measurable. Consider Thrive workflow context.
6. Validate in synthetic-dev, then wootdev, then production. Exercise slow calls, errors, backlog, projection delay, missing telemetry, and idle services. Verify overhead, freshness, graph accuracy, and permissions.

## Immediate next steps on the new machine

1. Check out this branch and read the original brief plus this handoff.
2. Locate qboard and inspect its API/RUM/trace propagation and deployment configuration.
3. Record each checkout's revision and shared package versions before extending findings; prior inspection did not record cross-repo SHAs.
4. Inspect infrastructure configuration (likely ~/dev/iac) for Datadog agents, OTLP intake, logs, OpenMetrics scraping, ECS tags, RabbitMQ/database integrations, monitors, and environment mapping. iac has not yet been inspected in this work.
5. Discover applicable Datadog/AWS/triage/database access skills and use read-only access to validate live coverage. No relevant operational skill has yet been applied.
6. Verify a complete trace and metric path through IAM/programs/scheduling; determine queryable event attributes and projection relationships. Check actual Datadog metric names and sampling before estimating events/sec from traces.
7. Produce a concrete telemetry-to-visual mapping, then select the smallest vertical slice for implementation.

## Scope and validation notes

This session produced planning and source findings only. No tests were run because no executable code changed. No live coverage, credentials, monitor inventory, AWS inventory, or production health claims were established. No website was built or published. No dependency/framework selection is final.

Unrelated pre-existing changes in soa at handoff time: docs/claude-for-pms/02-setup-macos.md, docs/claude-for-pms/04-mcp-servers.md, and untracked claude/projects/saga-content-digitization/. Keep them out of this handoff commit.

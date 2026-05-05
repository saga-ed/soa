# D10 — Observability stack for the event-driven POC

**Status:** RESOLVED 2026-04-30 — OpenTelemetry (manual instrumentation) + Prometheus + Grafana, all OSS, all running in `infra/docker-compose.yml`. Logs stay on Pino → stdout (already in use across the soa fleet).

## Context

A monolith-on-EC2 system has at most two debugging surfaces: the request log
and `psql`. An event-driven system has at minimum five: the publisher's
outbox table, the broker, the consumer's `consumed_events` table, the
projection table, and the read API. Without trace-correlated cross-service
visibility, a "user X enrolled but admissions doesn't show it" report turns
into a 30-minute hunt through logs from three services.

The POC must demonstrate, at the team's "small team / boring tools" guardrail,
how to make a single logical flow inspectable end-to-end — and how the same
tooling answers the operational questions: "is the outbox falling behind",
"are events backing up in DLQ", "is consumer lag growing".

## Options considered

| Option | What it gives | Why not |
|---|---|---|
| **OpenTelemetry → Jaeger + prom-client → Prometheus + Grafana** *(recommended)* | Standard W3C TraceContext, vendor-neutral exporters, Prometheus is the de-facto metrics format for ops dashboards | One more local container each (Prom, Grafana, Jaeger). Modest. |
| Datadog APM | Hosted, polished UI, single agent | $$$$, vendor lock-in, the team isn't on Datadog today |
| Honeycomb / Lightstep | Hosted tracing-only | Same lock-in concern; doesn't solve metrics |
| New Relic | Bundled APM/metrics/logs | $$$, lock-in |
| Build custom span + metric registry | Full control | Reinvents tooling that 1000s of teams use successfully — explicitly against the POC's "boring patterns" guardrail |
| OTel auto-instrumentation only (`@opentelemetry/auto-instrumentations-node`) | Hooks http/express/amqplib/pg automatically | ESM + tsup bundling makes the IITM hook brittle. Manual spans on the 2-3 hot paths (outbox publish, consumer process) cost ~50 lines and stay readable |

## Recommendation (resolved)

**Three layers, all wired in `infra/docker-compose.yml`:**

1. **Tracing** — `@opentelemetry/sdk-node` per service, OTLP/HTTP exporter to Jaeger.
   - Manual PRODUCER span in `@example/event-outbox` per row publish.
   - Manual CONSUMER span in `@example/event-consumer` per message.
   - W3C TraceContext propagated through `EventEnvelope.meta.traceparent`.
     `buildEnvelope` auto-snapshots the active context — so writing the
     outbox row inside an HTTP request handler captures the request span,
     and the eventually-running relay/consumer chain to it.
   - `OTEL_TRACES_DISABLED=true` for tests (default in spawned services
     under `packages/integration-tests/src/lib/services.ts`).

2. **Metrics** — `prom-client` per service, `/metrics` exposed on the
   service's Express app.
   - Counters (incremented via callbacks passed into `EventConsumer` / `OutboxRelay` opts so the packages stay free of prom-client coupling): `events_processed_total`, `events_failed_total`, `events_duplicate_total`, `events_published_total`, `events_publish_failed_total`.
   - Gauges (lazy-bound to the service's pg pool): `outbox_unpublished_count`, `consumed_events_count`.
   - Default Node process metrics (cpu, heap, GC) prefixed per service (`identity_svc_process_*` etc.) so multi-service scrapes don't collide.

3. **Visualization** — Prometheus + Grafana.
   - Prometheus scrapes `host.docker.internal:300{1..4}/metrics` every 5s.
   - Grafana provisions one datasource (Prometheus) and one dashboard
     (`Event System — POC`) covering: outbox lag, throughput, error rate,
     publish rate.
   - Anonymous Admin role enabled so the dev experience is one-click.

## Why manual instrumentation over auto

- ESM + tsup's `skipNodeModulesBundle: true` produces a bundle where
  `import 'amqplib'` resolves to a runtime require. The auto-instrumentation
  patches modules via `import-in-the-middle` (IITM), which requires a
  loader registered with `--import` or `--experimental-loader`. Adding that
  flag to `node dist/main.js` startup commands works but is finicky and
  silently no-ops on misconfiguration.
- The hot paths we actually want spans on (publish + consume) are exactly
  where the code already passes through `OutboxRelay.publishRow` and
  `EventConsumer.handleMessage`. ~30 lines of manual spans there give us
  the same trace topology with better readability and zero loader gymnastics.
- HTTP-server spans (Express request → response) are deferred. The
  request → outbox write → publish chain still works because `buildEnvelope`
  captures whatever active context exists; if there's no active context
  (no HTTP-server instrumentation), the publish span starts as a root and
  the consume span chains under it. Acceptable for the POC; trivial to
  add HTTP spans later if needed.

## Local-vs-prod divergences (called out in `docs/local-vs-prod-parity.md`)

- Jaeger all-in-one is in-memory. Production needs Cassandra/ES/OpenSearch
  + retention policy + tail sampling.
- Local Prometheus is one node, ~15-day retention. Production needs Mimir/
  Cortex (or remote-write to a managed service) + alerting wired to
  PagerDuty/Slack.
- Anonymous Grafana access is fine locally; never ship it to prod.
- 100% trace sampling locally. Production should head/tail-sample (e.g.,
  1% baseline + 100% of errors) so a chatty service doesn't OOM Jaeger.

## Related artifacts

- `apps/*/src/tracing.ts` — NodeSDK initializers per service.
- `apps/*/src/metrics.ts` — Prometheus registry + counter/gauge declarations.
- `packages/event-outbox/src/relay.ts` — PRODUCER span; reads/restores
  `meta.traceparent` from the outbox row.
- `packages/event-consumer/src/consumer.ts` — CONSUMER span; extracts
  `meta.traceparent` from the message envelope.
- `packages/envelope/src/index.ts` — `buildEnvelope` auto-captures active
  trace context.
- `infra/docker-compose.yml` — Jaeger / Prometheus / Grafana wiring.
- `infra/prometheus/prometheus.yml` — scrape config.
- `infra/grafana/dashboards/event-system.json` — provisioned dashboard.
- `docs/debugging-events.md` — tools-at-a-glance + metric reference + span-source map.
- `scenarios/trace-walkthrough.ts` — end-to-end trace generation + Jaeger URL printing.

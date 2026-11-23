# @saga-ed/soa-observability

OpenTelemetry tracing setup, Prometheus metrics for outbox/consumer, and an
Express error-classifier middleware for Saga services.

```typescript
import { initTracing } from '@saga-ed/soa-observability';
```

> **⚠️ FOOTGUN — `initTracing()` MUST run before any tracer-using import.**
>
> OpenTelemetry's tracer-provider singleton is patched in place by
> `initTracing()`. Any module loaded *before* the call captures the
> **no-op tracer** at module-load time and silently emits **zero spans**
> for its lifetime. The service still runs; you just have no traces.
>
> Both `rostering` and `program-hub` hit this. The `saga-soa/init-tracing-first`
> ESLint rule (in `@saga-ed/soa-eslint-config/base`) catches it at lint time.
>
> ### ✅ Correct
>
> ```typescript
> // main.ts
> import { initTracing } from '@saga-ed/soa-observability';
> initTracing({ serviceName: 'iam-api' });
>
> // Dynamic import AFTER tracing is initialized:
> const { startServer } = await import('./server.js');
> await startServer();
> ```
>
> ### ❌ Wrong — `reflect-metadata` precedes `initTracing()`
>
> ```typescript
> import 'reflect-metadata';            // captures no-op tracer at load
> import { container } from './ioc.js'; // same — silent dead spans
> import { initTracing } from '@saga-ed/soa-observability';
> initTracing();                         // too late
> ```
>
> ### ❌ Wrong — static import of app code before init
>
> ```typescript
> import { initTracing } from '@saga-ed/soa-observability';
> import { startServer } from './server.js';  // hoists; loads before initTracing() runs
> initTracing();
> await startServer();
> ```

## Metrics

`initTracing()` also exports OTel metrics (OTLP/HTTP, DELTA temporality) to the
same Datadog agent receiver as traces: `RuntimeNodeInstrumentation`'s
`nodejs.eventloop.*` / `v8js.memory.*` plus any `metrics.getMeter(...)`
instrument, tagged with the trace resource (`service.name`, `service.version`,
`OTEL_RESOURCE_ATTRIBUTES`).

| Env | Effect |
|---|---|
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Full URL, used as-is |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL; `/v1/metrics` appended |
| neither set | Metrics off (no localhost fallback) |
| `OTEL_METRICS_EXPORTER=none` / `OTEL_TRACES_DISABLED=true` | Metrics off |

Don't register a second global `MeterProvider` in the service; it competes
with this one.

## EMF metrics reporter (opt-in)

`startEmfReporter()` emits the registry's domain metrics as CloudWatch
Embedded Metric Format log lines (namespace `SagaSoa/Events`, dimensions
`Environment` + `Service`). The awslogs driver ships stdout to CloudWatch,
which mints the metrics; nothing needs to scrape `/metrics`.

```typescript
import { createObservability, startEmfReporter } from '@saga-ed/soa-observability';

const obs = createObservability('iam-api', logger);
// ...obs.addOutbox(pool) / obs.addConsumer(pool, name)
const emf = startEmfReporter(obs.registry, {
    service: 'iam-api',
    environment: 'prod', // telemetry env 'dev' | 'prod', never NODE_ENV or a preview tag
    logger,
});
// on shutdown: await emf.stop();  // one final counter flush
```

- Counters (`EventsPublished`, `EventsPublishFailed`, `EventsProcessed`,
  `EventsFailed`, `EventsDuplicate`, `GaugeCollectFailures`) are per-interval
  deltas summed across label sets, every `counterIntervalMs` (60s). The first
  delta is relative to values at start. The per-`event_type@version` split is a
  root `breakdown` property, not a dimension.
- Gauges (`OutboxUnpublishedCount`, and `ConsumedEventsCount` with
  `includeConsumedEventsCount: true`) are read every `gaugeIntervalMs` (300s).
  They run a `count(*)` in `collect()`, so counters are read per-metric and
  never via `registry.metrics()`.
- Only metrics registered in the registry are emitted. Default process metrics
  are not.
- `EventsProcessed` also counts duplicate skips (existing
  `events_processed_total` semantics); subtract `EventsDuplicate` for net-new.

## See also

- `@saga-ed/soa-eslint-config` — the `saga-soa/init-tracing-first` lint
  rule wires this into CI; runs against any file named `main.ts`.
- Pattern 4 decision-doc rationale was meant to live in
  `d-consumer-resilience.md` — the file is missing; see
  [soa_75's README](../../../docs/history/soa_75/README.md#missing-decisions).

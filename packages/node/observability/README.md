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

### Scoped HTTP client rates (0.4.0 opt-in)

The installed HTTP instrumentation (0.57.2) already records
`http.client.duration`; Undici (0.10.1) records
`http.client.request.duration`. Their histogram counts are independent of span
sampling, but their metric attributes omit route and peer-service identity.
Those existing histograms remain available for aggregate HTTP measurements.

For a bounded peer/endpoint pilot, set an explicit allowlist before the existing
`initTracing('programs-api')` bootstrap. For synthetic slot 3:

```sh
export SAGA_HTTP_METRIC_PEERS='[{"service":"iam-api","origins":["http://localhost:6010","http://127.0.0.1:6010"],"routes":[{"path":"/trpc/personas.getMyPermissions","methods":["GET"]}]}]'
export OTEL_METRIC_EXPORT_INTERVAL=10000
```

Use the actual configured IAM origin in each hosted environment, retaining the
same peer name and route. Origins must be exact HTTP(S) origins without a path,
credentials, query, or trailing slash. A route may contain whole `:parameter`
segments (for example `/people/:id`); only the configured template is exported.
Queries, fragments, IDs, and unmatched routes/peers never become metric labels.
Exact routes take precedence over parameterized routes. Configurations with
duplicate matches or route names differing only in case are rejected, since
Datadog normalizes tag values. Limits are 16 peers, 8 origins per peer, 64 route
entries in total, and the seven standard application methods GET/HEAD/POST/PUT/
PATCH/DELETE/OPTIONS. Invalid configuration disables these counters, with a
diagnostic warning, without blocking application startup.
An unsupported diagnostic event shape marks the export heartbeat unhealthy (0)
so a reader cannot mistake incomplete counters for a healthy idle interval.

| Metric | Meaning |
| --- | --- |
| `saga.http.client.attempts` | Started physical outgoing HTTP attempts |
| `saga.http.client.requests` | Terminal attempts, including failures; completed-request rate basis |
| `saga.http.client.metrics.active` | Per-path export heartbeat, value 1 while instrumentation is active |

Every metric carries `source.service`, `peer.service`, `http.method`, and
`http.route`. Terminal counts also carry `outcome` (`success`, `http_error`,
`transport_error`, `aborted`) and bounded `http.status_class` (`1xx`–`5xx` or
`none`). Status 400–599 is an HTTP failure; an aborted or truncated response is
not successful. Attempts awaiting a terminal event remain in flight. Retries
and followed redirects are separate physical attempts when their destinations
match the allowlist. One HTTP request is not one tRPC procedure: a batched tRPC
URL does not match the single-procedure pilot route and is not split into
invented procedure counts.

The implementation observes native HTTP/HTTPS instrumentation hooks and public
Undici lifecycle channels (including Node fetch), without handler timers, a
second metrics provider, or a collector. It does not wrap response bodies,
consume them, or add error handlers that suppress application errors. Native
requests use their normal Host authority for configured-origin matching;
custom Host routing, HTTP/2, CONNECT tunnels, and upgraded connections are
outside this pilot. Initialize before importing HTTP clients, as with tracing.

Counters maintain bounded monotonic process totals and use the existing OTLP
DELTA exporter. They explicitly observe zero for idle configured paths on each
collection, with the per-path heartbeat exported in the same collection.
`OTEL_METRIC_EXPORT_INTERVAL` accepts 1000–60000 ms; absent/invalid values retain
the prior 60000 ms default. A reader must check heartbeat coverage for the full
displayed interval and exclude partial startup/shutdown intervals; missing data
is not zero. Export/Agent/network loss still limits delivery, so these are
instrumented process counts, not a claim of lossless distributed accounting.

`OTEL_TRACES_SAMPLER=always_off` disables sampled spans while these counters
continue. The existing `OTEL_TRACES_DISABLED=true` switch still disables the
entire SDK, including metrics. `OTEL_METRICS_EXPORTER=none` and absent OTLP metric
endpoints also leave this feature off. Resource attributes remain shared with
tracing: configure environment, `deployment.identifier`, `synthetic.machine`,
and `synthetic.slot` through `OTEL_RESOURCE_ATTRIBUTES`. Use the Datadog Agent's
existing OTLP metrics endpoint; no additional collector is needed.

Adoption requires loading this 0.4.0 package at process bootstrap. The observed
Programs/IAM synthetic processes had installed 0.2.1, which lacks the newer
OTLP metric-reader wiring; changing environment variables alone does not upgrade
that code. Upgrade/link the package and rebuild the adopter, verify its resolved
version, then coordinate a process restart. Start with Programs→IAM; IAM itself
needs an upgrade only when measuring its own outgoing calls. Publishing and
hosted rollout are separate steps, not performed by package tests.

`pnpm test` exercises real concurrent native HTTP and fetch calls against local
test servers with all spans unsampled. The OTLP payload assertions cover exact
starts/terminal counts, retries, HTTP failures, refusals, truncation, aborts,
unconsumed-callback behavior, explicit idle zeros, heartbeat, scope, and absence
of request identifiers/query data. The HTTP sink used by tests is a fixture,
not a runtime collector.

## See also

- `@saga-ed/soa-eslint-config` — the `saga-soa/init-tracing-first` lint
  rule wires this into CI; runs against any file named `main.ts`.
- Pattern 4 decision-doc rationale was meant to live in
  `d-consumer-resilience.md` — the file is missing; see
  [soa_75's README](../../../docs/history/soa_75/README.md#missing-decisions).

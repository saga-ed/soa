# Vishnu performance telemetry — collection and measurement ownership

**Status: RESOLVED 2026-11-02 for collection, endpoint/caller measurements and bounded sampled fan-out rankings.**

**Initiative:** [RabbitMQ event telemetry and Vishnu](../README.md)

## Context

Vishnu needs comparable slow-path, hot-path and fan-out evidence in synthetic-dev
and hosted environments. Health probes establish reachability separately from
performance. A passing probe may coexist with slow requests or high traffic.
This record captures the agreed direction and the user's questions. The user
subsequently authorized concurrent implementation, real synthetic-dev testing,
then deployment and testing in the existing sandbox. It does not authorize a
production rollout or moving the normal hosted route to the sandbox colour.

## 1. Collection: use the Datadog Agent

**Decision:** use the Datadog Agent's OTLP receiver with existing SOA
OpenTelemetry instrumentation. Do not implement a custom collector or introduce
a separate OpenTelemetry Collector without a demonstrated requirement.

Synthetic services → local Datadog Agent → Datadog → Vishnu's server-side reader.
Reuse the hosted telemetry pipeline for hosted environments. Configure identity
for environment, machine, slot/deployment, service and revision; verify which
attributes survive into each queried metric and trace before relying on filters.
Slot alone is not globally unique across developer machines.

Work includes Agent/ss configuration, exporter routing, scope verification,
sampling verification and end-to-end evidence. It does not include writing a
telemetry transport. Keep credentials server-side. Preserve the existing MQ
statistics receiver, whose outcome counters serve a separate purpose.

## 2. Endpoint and connection measurements: consume existing instrumentation

**Status: RESOLVED 2026-11-02 — approved by skelly.**

User ruling: "Approve of additional endpoint-level statistics and caller-calleee measurements".
Extend Vishnu's queries, read model and presentation with endpoint-level statistics
and attributable caller→callee measurements in synthetic-dev and hosted environments.
This approval resolves section 2. The subsequent implementation instruction also
adopts the Agent approach in section 1. The later path-inspector ruling below authorizes bounded sampled fan-out rankings.

The user asked whether endpoint/connection measurements are already provided by
Datadog, and whether the proposal implies custom latency timers in application APIs.

**Decision:** query and present existing APM measurements first. Do not
add hand-written timers to API handlers or duplicate HTTP/database instrumentation.
The shared SOA SDK already enables HTTP, Express, pg and amqplib instrumentation.
Verify each service actually starts it early enough and exports connected spans.

Vishnu's current reader groups request rate, p95 duration and error rate by service.
Its dependency feed supplies source/target identities, not measured per-edge
latency or traffic. Extending the read model means retrieving available endpoint
resource statistics and attributable caller/callee evidence, with window, scope,
freshness and sampling semantics, then exposing them in the graph and inspector.
Never assign a whole service's throughput or p95 to each incoming edge.

Automatic instrumentation supplies timings; it does not guarantee every desired
aggregation is available as a standard metric. Verify route/resource naming,
tRPC batching/procedure visibility, caller attribution, retained trace coverage
and API access before selecting queries. Add targeted spans or bounded metadata
only for a proven gap, such as an unrepresented business operation; document that
gap first. Do not promise endpoint-specific percentile or fan-out coverage from
service-level metrics alone.

## 3. Measurement semantics to refine

- Slow: endpoint latency percentiles and attributable downstream durations.
  Critical-path time must account for parallel calls, not sum all span durations.
- Hot: requests/messages per second for the measured resource or relationship;
  traffic volume is distinct from latency and saturation.
- Fan-out: downstream calls per root request/action, distinct destinations,
  repeated calls and cascade depth from connected traces. Topology degree alone
  is not request fan-out. Label sampled or incomplete evidence explicitly.
- MQ: retain reported publish/delivery/commit/retry/failure counters. Obtain queue
  depth and age from broker telemetry where available; never infer backlog by
  subtracting publish and consume counters across fan-out.

Prefer counters or pre-sampling metrics for traffic totals; use retained traces
for diagnosis and distributions with their sampling limitations. Verify that
synthetic scopes cannot silently fall back to environment-wide hosted data.
Hosted APM currently uses environment-wide scope while MQ can be sandbox-scoped;
those are separate claims and must remain visible.

### Fan-out feasibility and subsequent path-inspector approval

The user flagged that measured fan-out is difficult to obtain through the current
Datadog APM API. The earlier proposal understated this dependency. Existing Vishnu
metrics/dependency queries do not supply per-root-request call counts.

Datadog's Trace Queries UI supports structural relationships and span counts, but
that does not establish equivalent public API access. Public span search and
aggregation operate on searchable span data; matching spans do not prove a complete
trace. The current public APM Trace API documents full/pruned trace retrieval by
ID as preview. Availability, permissions, retention and truncation must be tested
in our account before selecting it for a product feature.

**Recommendation:** retain Datadog drill-through for structural investigation;
run a bounded API feasibility check before committing to measured fan-out inside
Vishnu. If complete example traces are retrievable, start with explicitly labeled
per-trace diagnostics, not population-wide fan-out percentiles. Do not derive
per-request fan-out by dividing unrelated service traffic totals. Do not introduce
a second trace collector/store as an implicit consequence of this proposal.
Caller/callee measurements approved in section 2 remain subject to attribution
availability. The subsequent ruling below authorizes bounded trace reconstruction
for sampled path diagnostics; a separate trace collector/store remains out of scope.

The user agreed to the feasibility investigation and explicitly requested checking
trace retrieval in our account. The read-only check succeeded with both connector
access and Vishnu's own application key. A richer example returned three connected
spans across programs and IAM, without response truncation or restricted spans.
This demonstrates per-example retrieval, not complete population coverage or
unbiased fan-out distributions. See the [validation record](../research/performance-telemetry-validation.md).

## 4. Path offenders and persistent display settings

**Status: RESOLVED 2026-11-02 — approved by skelly.**

After the successful trace retrieval investigation, the user requested clicking a
path with Slow, Hot or Fan-out selected to see the top N offending endpoint names.
N must be configurable from a gear in the top right and persist across reloads.
The user also requested repeatable real traffic in synthetic-dev and parallel work.

- Rank only measurements attributable to the selected caller→callee pair. Never
  substitute all endpoints of either service for path-specific evidence.
- Slow ranks retained outgoing-client p95 duration; Hot ranks retained outgoing
  span counts when unsampled path request-rate metrics are unavailable. These are
  observed-window rankings, not claims about all requests or service saturation.
- Fan-out ranks endpoint calls per sampled same-service parent server request on
  the selected path. Show the parent endpoint and sample denominator explicitly.
  Count connected spans with exact IDs; exclude truncated, restricted or structurally
  unusable traces. Do not divide unrelated aggregate service counts.
- Bound trace search/retrieval, cache results and report sample limitations. A small
  recent trace sample cannot establish fleet-wide top offenders or population
  percentiles. Missing data and incomplete coverage remain visible states.
- Default N is 5, range 1–50. Store this display preference locally in the browser;
  changing N changes the displayed ranking, not the telemetry collection budget.
- Use authenticated bounded read-only requests against the existing synthetic
  slot. Do not seed/reset domain data or inject fabricated timings to populate views.

This extends the prior investigation-only approval to the bounded diagnostic
feature above. Deployment remains the existing blue sandbox, followed by validation;
the normal hosted route and production rollout remain outside this iteration.

## Related artifacts

- [Shared tracing implementation](../../../../packages/node/observability/src/tracing.ts)
- [Vishnu Datadog reader](../../../../apps/node/vishnu-api/src/telemetry/datadog.ts)
- [MQ scope decision](d3-mq-scope-model.md)
- [Datadog Agent OTLP intake](https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest_in_the_agent/)
- [Datadog trace metrics and sampling](https://docs.datadoghq.com/tracing/metrics/metrics_namespace/)
- [Datadog Trace Queries UI](https://docs.datadoghq.com/tracing/trace_explorer/trace_queries/)
- [Public spans API](https://docs.datadoghq.com/api/latest/spans/)
- [Preview trace retrieval API](https://docs.datadoghq.com/api/latest/apm-trace/)

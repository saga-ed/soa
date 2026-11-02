# Performance telemetry validation — 2026-11-02

Read-only checks against Datadog US1 and real synthetic-dev slot 3 on `turing`.
The local Datadog Agent was healthy with OTLP enabled. IAM, programs, scheduling
and Vishnu process environments contained the intended machine/slot attributes.

## Traffic and endpoint identity

The bounded authenticated traffic driver ran from 23:03:43 to 23:04:13 UTC:
122 GET requests, all HTTP 200 (31 whoami, 31 programs.list, 30 programs.get,
30 schedules.get). It reused existing data and did not seed or reset the slot.
These are driver-observed request counts, not claimed Datadog retention totals.

Span search used:

```text
env:synthetic @synthetic.machine:turing @deployment.identifier:slot-3
```

Returned attributes independently confirmed `env=synthetic`,
`synthetic.machine=turing`, `synthetic.slot=3`, and `deployment.identifier=slot-3`.

Successful API spans currently have `resource_name=GET` and no `http.route`.
Datadog already supplies distinct `http.path_group` values such as
`/trpc/programs.list`, `/trpc/schedules.get`, and `/trpc/personas.getMyPermissions`.
Therefore normalized HTTP path aggregation can provide distinct endpoint evidence
without new latency timers or instrumentation changes. These paths are not claims
about registered Express route templates or individual batched tRPC durations.

Verified `POST /api/v2/spans/analytics/aggregate` request semantics:

- Filter: the scope query above plus `@span.kind:server`.
- Window: `now-15m` to `now`.
- Group by: `service`, `@http.method`, `@http.path_group`.
- Compute: `count` of `*`, `pc95` of `@duration` (nanoseconds).
- Response: `meta.status=done`; `traffic_type=sampled`; distinct endpoint groups
  and measured durations returned. This is retained-span evidence, not total
  throughput. Exclude health paths from performance views: these older service
  package versions still emit health spans.

## Trace retrieval by ID

Both the connected Datadog user and Vishnu's own read-only application key could
retrieve a trace. The stronger check used the exact credentials referenced by
the hosted Vishnu configuration: `datadog/api-key/default` and
`soa/vishnu/dev/datadog-app-key`, read through `saga-runtime-dev` and kept in
process memory. No key values or raw application payloads were saved.

```text
GET https://api.datadoghq.com/api/v2/trace/18bad00be00679a0db59c8475d72e8cc
```

Result: HTTP 200, 3 spans, `is_truncated=false`, no spans flagged restricted,
one root, and no missing parents among the returned spans. The request was
`programs.list`; its call to IAM permissions had this explicit boundary:

| Field | Value |
|---|---|
| Caller | `programs-api`, client span |
| Caller span ID | `9044641986219616459` |
| Callee | `iam-api`, server span |
| Callee span ID | `13605803948748600067` |
| Callee parent ID | `9044641986219616459` |
| Callee normalized path | `/trpc/personas.getMyPermissions` |

The child had no `span.parent.service` metadata. Consequently, an aggregate
query relying on that attribute may return no caller/callee rows despite real
connected traces. Empty attributed aggregates must not be described as zero
traffic. Reconstructing a boundary from trace IDs is a separate implementation
choice, supported by this example but not validated across the fleet.

### Parser and coverage constraints

- The actual raw response uses `spanID`, `parentID`, `traceID`, `traceIDFull`,
  `startTime`, and `endTime`. Do not assume snake_case fields or SDK-normalized
  field spelling without checking the response.
- IDs are JSON uint64 numbers; normal JavaScript number parsing loses precision.
  This check used Python integer parsing and converted IDs to decimal strings
  for reporting. Any production parser must preserve exact IDs before joining.
- Trace retrieval remains a preview API. Published limit: 60 retrieval requests
  per minute per organization; span search has a separate 300 requests/hour limit.
- Non-truncated response and closed parentage demonstrate the retrieved example's
  structure, not instrumentation completeness or unbiased population sampling.
  This proves feasibility for selected trace inspection, not fleet-wide fan-out
  percentiles or complete user-action tracing.

## Validation checks

The CLI telemetry configuration tests and existing launch/adoption tests passed:
148 tests total; `pnpm check-types` passed for the stack CLI. No hosted deployment
was performed as part of these checks.

## Sources

- [Trace retrieval API](https://docs.datadoghq.com/api/latest/apm-trace/)
- [Spans API](https://docs.datadoghq.com/api/latest/spans/)
- [Decision record](../decisions/vishnu-performance-telemetry.md)

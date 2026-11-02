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

## Repeatable traffic profiles — 2026-11-02

The driver now provides deterministic `baseline`, `burst`, and `mixed` profiles.
Baseline and burst have equal shares of whoami, program list, program get, and
schedule get; mixed sends 50% program list, 25% program get, and 12.5% each of
whoami and schedule get. All requests are authenticated GETs to fixed loopback
ports. No domain writes, reseeding, artificial latency, or service restarts were
used. Profiles share a strict request budget across workers; two preflight reads
count toward that budget and are reported separately from workload timings.

Runs against the existing `turing` / `slot-3` stack:

| Profile | Workload UTC start–end | Total requests, including preflight | Result |
| --- | --- | ---: | --- |
| baseline, duration 30 | 23:53:49.241–23:54:19.241 | 32 | All HTTP 200 |
| burst, duration 30, request cap 502 | 23:54:23.747–23:54:36.873 | 502 | All HTTP 200; request cap reached |
| mixed, duration 20, request cap 130 | 23:54:49.014–23:55:05.204 | 130 | All HTTP 200; request cap reached |
| mixed, duration 75, request cap 602 | 23:55:56.204–23:57:11.205 | 588 | All HTTP 200; duration reached |

Total: 1,252 requests, zero failures. The longer mixed workload sent 293 program
list, 147 program get, 73 schedule get, and 73 whoami reads, plus two preflight
reads. Its client p95 was 11, 6, 11, and 5 ms respectively. These client timings
are driver diagnostics, not APM percentile estimates. All three service health
checks remained healthy during the longer run.

Datadog aggregate query:

```text
env:synthetic @synthetic.machine:turing @deployment.identifier:slot-3 @span.kind:server @http.path_group:/trpc/*
```

Grouped by `service` and `@http.path_group`, with count and `pc95(@duration)`,
over the reported UTC windows. Retained spans confirmed all four driver paths
plus IAM `/trpc/personas.getMyPermissions`. Responses reported
`traffic_type=sampled`; retained counts were much smaller than sent counts, and
the short mixed window initially returned no samples. The longer mixed run
produced these retained `programs.list` trace examples:

- `de89734d6526a1a01bf52d40ecc0c324` at 23:56:50.085 UTC.
- `63b699d44c6cfc8c93c5537026aeebf2` at 23:56:42.127 UTC.
- `a2c9faa0d508b9db33eb8a88fa0dfc39` at 23:56:33.677 UTC.

Burst example: `4a1d73ac8ec2a83ad3bf6a2e0a7070ae` at 23:54:25.438 UTC.
These prove real ingestion and provide trace retrieval candidates; they do not
establish complete coverage, population throughput, or a latency regression.

Seven driver unit tests passed: argument bounds, cookie filtering, concurrent
request budget with GET/loopback allowlist, failure stop and output redaction,
empty prepared data, interruption, and weighted endpoint mix. Prettier checks
for both driver files and `git diff --check` passed. Reproduction commands and
limits are in the [Vishnu README](../../../../apps/web/vishnu/README.md#generate-real-synthetic-traffic).

## Sources

- [Trace retrieval API](https://docs.datadoghq.com/api/latest/apm-trace/)
- [Spans API](https://docs.datadoghq.com/api/latest/spans/)
- [Decision record](../decisions/vishnu-performance-telemetry.md)

# I#538 — Ingest event-stats in Vishnu and display MQ activity, outcomes and freshness

Snapshot captured 2026-10-22; trust the live issue: https://github.com/saga-ed/soa/issues/538

Parent epic: #536
Depends on: #535 (shared reporting contract). End-to-end validation also requires #537 (service adoption).

## Outcome

Ingest participating services' event-statistics reports into Vishnu and display attributable MQ roles, counts, rates and freshness. Receiving a domain event in Vishnu does not establish another consumer's processing; use that consumer's reported outcomes.

## Scope

1. Add a server-side receiver using Vishnu's own environment/slot-scoped queue and bindings on the agreed observability namespace. Never compete with business consumers for their queues. Bind to each participating service's existing environment/slot-scoped exchange using the dedicated telemetry routing key. Publishers retain exchange ownership; Vishnu only checks upstream exchanges and owns its telemetry queues/bindings. Coordinate the wildcard business-binding audit with I#537; keep broker credentials server-side and do not introduce per-service broker users.
2. Validate the I#535 envelope/payload contract, version, scope and bounded dimensions. Handle malformed/unsupported reports without poisoning ingestion; exclude telemetry from business statistics.
3. Persist the latest cumulative snapshot per scope/instance/process epoch and bounded stream. Apply snapshots idempotently and atomically, reject older sequences, and preserve state across receiver restart. Respect completeness rules if the contract uses chunking.
4. Compute deltas/rates over actual monotonic elapsed intervals within one epoch. Never subtract across restarts; deduplicate retries, bridge missed snapshots, and aggregate distinct instances without double-counting. A first snapshot supplies counters but no measured interval rate until there is a valid baseline.
5. Expose a scoped read model containing measurement semantics, timestamps, capabilities and freshness. Separate idle zero, unsupported/unknown and stale; document expiration/retention and treatment of departed instances. Preserve authorization boundaries for any hosted exposure.
6. Map reports to declared publisher/exchange/queue/consumer relationships without inventing topology matches. Display MQ-P/MQ-C/MQ-P/C and attributable rates/counts, with progressive disclosure of commits, duplicates, failures and freshness in the inspector. Keep layout, zoom and selection stable during refresh.
7. Maintain existing health-probe and independent Datadog evidence alongside event statistics. Backlog is an explicit broker gauge, never publish-minus-consume arithmetic.

## Acceptance criteria

- [ ] Contract fixtures cover duplicate/out-of-order/missed reports, process and receiver restarts, multiple replicas, fan-out, clock skew and partial snapshots where applicable.
- [ ] First observations, idle zeros, unsupported measurements and stale sources render distinctly; rates never arise from cross-epoch subtraction.
- [ ] Inspector labels distinguish transport acceptance, broker confirmation when supported, delivery, committed work and duplicate skips.
- [ ] Unknown topology mappings are surfaced without assigning traffic to an unrelated edge; environment/preview/slot scopes cannot mix.
- [ ] Malformed reports and reporting outages do not interrupt ingestion of valid reports; state/cardinality/retention are bounded.
- [ ] Browser verification confirms readable activity/failure indicators and stable layout, selection and zoom during refresh.
- [ ] A synthetic-dev demonstration shows one real publisher and two consumers, reconciled with the service-adoption scenario, including duplicates/failure/restart/staleness.

## Boundaries

I#535 owns reporting and lifecycle semantics; service adoption owns producer/consumer wiring. This issue implements the Vishnu receiver/read model/UI, not a general telemetry platform, audit ledger, domain-payload archive or implicit cloud deployment. Preserve the documented possibility of an unreported tail lost on producer crash.

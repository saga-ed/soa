# I#536 — Epic: RabbitMQ event telemetry from services to Vishnu

Snapshot captured 2026-10-22; trust the live issue: https://github.com/saga-ed/soa/issues/536

## Outcome

Make RabbitMQ producer and consumer activity visible in Vishnu through periodic, versioned reports emitted by the participating services. Deliver a synthetic-dev vertical slice with one real publisher and two consumers before broader adoption.

The shared SOA module owns measurement semantics and reporting. Service adoption owns application wiring and rollout. Vishnu owns ingestion, aggregation and presentation. Preserve existing Datadog/Prometheus/OTel observability.

## Workstreams

- [ ] #535 — Shared event-stats package, reporting contract and integration hooks.
- [ ] #537 — Service adoption and synthetic-dev validation.
- [ ] #538 — Vishnu ingestion, aggregation and UI.

## Sequencing and decisions

1. Agree the versioned contract and lifecycle boundaries in I#535. Adoption and UI can develop against contract fixtures; end-to-end integration requires the released package.
2. Resolved 2026-10-22: reuse each service's existing environment/slot-scoped exchange with a dedicated telemetry routing key. Publishers retain exchange ownership; Vishnu owns its telemetry queues/bindings. Audit wildcard business bindings before enabling reports. Service adoption owns synthetic-dev wiring; no new shared telemetry exchange or per-service broker users are introduced.
3. Integrate a real publisher and two consumers, then verify their reports in Vishnu.
4. Expand service coverage through an explicit adoption inventory and linked repository PRs.

## Completion criteria

- [ ] All three child issues are complete with linked implementation and verification evidence.
- [ ] Synthetic-dev demonstrates publisher activity, consumer deliveries, newly committed work, duplicate skips and failures with correct attribution.
- [ ] Fan-out, multiple instances, restarts, missed/out-of-order reports and stale reporters are handled without double-counting or fabricated zeros.
- [ ] Reporting failure cannot affect business processing; telemetry does not recursively count itself.
- [ ] UI distinguishes transport acceptance from broker confirmation and receipt from committed processing. Unsupported measurements remain unavailable.
- [ ] Existing independent observability continues to expose broker/reporter failures.

## Boundaries

Counters are operational statistics, not an exact lifetime audit ledger: abrupt process termination can lose the unreported tail. Publisher and consumer totals need not match under fan-out/retries. Queue backlog must come from an explicit broker measurement, never subtraction of these counters. Cloud deployment, broad fleet rollout and publisher-confirm transport changes require separately scoped work.

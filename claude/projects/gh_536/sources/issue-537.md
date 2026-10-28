# I#537 — Adopt event-stats in Saga mesh services and validate synthetic-dev telemetry

Snapshot captured 2026-10-22; trust the live issue: https://github.com/saga-ed/soa/issues/537

Parent epic: #536
Depends on: #535 (shared package and versioned reporting contract).
Sibling: #538 (Vishnu ingestion/UI).

## Outcome

Adopt `@saga-ed/soa-event-stats` in real Saga mesh producers and consumers so Vishnu receives attributable reports from the services doing the work. This SOA issue coordinates cross-repository adoption; link implementation PRs from the owning repositories here.

## Scope

1. Inventory active MQ publishing and consuming paths in the first slice, including shared outbox/event-consumer paths and direct RabbitMQ paths. Record owning repository, service, named consumer, exchange/queue, package version and supported measurements. Start with IAM/programs/scheduling candidates; verify actual bindings before selecting one publisher and two distinct consumer subscriptions. Include multiple instances in validation.
2. Pin the released stats package and wire lifecycle-safe adapters into the selected services. Compose with existing observability. Declare MQ-P/MQ-C/MQ-P/C capabilities at startup, including idle services.
3. Configure service/revision, environment/deployment/preview/slot, instance and process epoch identity. Use the I#535 contract and bounded dimensions; never attach business payloads or sensitive identifiers.
4. Use each service's existing environment/slot-scoped publisher exchange and a dedicated telemetry routing key. Audit wildcard business bindings before enabling reporters so unsupported stats events cannot reach business consumers. Preserve publisher exchange ownership and coordinate Vishnu-owned telemetry queues/bindings with I#538. Use current fleet broker credentials; do not provision a new shared telemetry exchange or per-service users.
5. Add enable/disable configuration, bounded startup/shutdown and independent reporter-failure signals. Reporting outages must not block or change business publish, commit or acknowledgement behavior.
6. Provide a reproducible synthetic-dev scenario and an adoption checklist. Record uncovered paths and broader fleet/hosted rollout as explicit follow-ups; a package release alone is not fleet adoption.

## Acceptance criteria

- [ ] Inventory identifies each selected service's actual publisher/consumer roles and package pins.
- [ ] One real publisher and two distinct consumers emit valid reports with correct identity and isolation; idle roles remain visible.
- [ ] A known scenario reconciles attempts/transport acceptance, deliveries, committed work, duplicate skips and failures against the agreed semantics.
- [ ] Tests exercise fan-out, duplicate delivery, handler failure, multiple instances, process restart and broker/reporting outage; business behavior and existing observability remain intact.
- [ ] Telemetry reports never count themselves; no domain payloads, sensitive identifiers or unrestricted labels are broadcast.
- [ ] Synthetic-dev startup/teardown and configuration are documented, and reports reach the Vishnu receiver when integrated with the sibling issue.
- [ ] Owning-repository PRs and adoption gaps are linked here.

## Boundaries

The accumulator/reporter and hook semantics belong to I#535. Vishnu persistence/read APIs/UI belong to the sibling issue. Do not infer broker-confirmed delivery from the current non-confirm publishing path. Broad fleet rollout and cloud deployment are follow-ups, not implicit acceptance requirements.

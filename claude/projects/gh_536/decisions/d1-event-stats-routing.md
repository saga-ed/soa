# d1 — Event statistics routing and exchange ownership

RESOLVED — 2026-10-22

User ruling: "existing as recommended". Use each service's existing environment/slot-scoped exchange with a dedicated telemetry routing key and Vishnu-owned consumer queues. Audit wildcard business bindings before enabling reports. Keep reporting isolated from business processing; do not introduce per-service broker users as part of this work.

## Context

I#535 proposes a dedicated environment-scoped observability exchange/routing namespace and narrowly scoped permissions. The verified saga-iac 1.22.0 guidance calls for one publisher-owned `<service>.events` exchange and says not to invent per-service broker users before the fleet migration. A dedicated routing namespace can satisfy the issue without a new shared exchange; this choice needs to be explicit before implementation.

Stats are best-effort operational snapshots, not durable domain events. Reusing the publisher's exchange does not require putting telemetry ticks into the business outbox. Reporting still uses isolated channel/connection behavior and must not affect application work.

## Options

1. **Existing publisher exchanges; dedicated telemetry routing key.** Publish `observability.event_stats.reported` through the service's configured, environment/slot-scoped exchange. Vishnu owns telemetry-only queues/bindings. Retain current broker credentials and do not claim service-level authorization isolation that they cannot provide.
   - Matches present exchange ownership and avoids a shared provisioning dependency.
   - Requires auditing wildcard bindings before adoption so business consumers do not receive unsupported stats events. Vishnu must discover/configure all relevant publisher exchanges. Telemetry exclusion must cover all instrumentation paths.
2. **Dedicated shared observability exchange.** Explicitly assign provisioning and ownership; every reporter publishes there and Vishnu binds its own queues.
   - Separates telemetry routing from domain subscriptions and simplifies collection.
   - Requires a documented convention exception and shared lifecycle/provisioning ownership. It does not by itself provide permission isolation when using the current shared broker user.

## Recommendation

Option 1 for the initial synthetic-dev slice, subject to a binding audit before enabling reports. Keep routing configurable so later dedicated topology does not require changing counter semantics or the report payload. If existing wildcard subscriptions cannot safely exclude telemetry, revisit this decision rather than silently modifying business subscriptions.

Do not introduce per-service RabbitMQ users or signing in this initiative. Any future permission hardening follows the fleet-owned migration.

## Related artifacts

- https://github.com/saga-ed/soa/issues/535
- https://github.com/saga-ed/soa/issues/536
- https://github.com/saga-ed/soa/issues/537
- https://github.com/saga-ed/soa/issues/538
- `/home/skelly/.claude/plugins/cache/saga-tools/saga-iac/1.22.0/references/event-driven/anti-patterns.md`
- `/home/skelly/.claude/plugins/cache/saga-tools/saga-iac/1.22.0/references/event-driven/rabbitmq-topology.md`

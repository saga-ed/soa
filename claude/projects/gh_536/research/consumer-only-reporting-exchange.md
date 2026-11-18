# Consumer-only service reporting exchanges

Recommendation for d19 Wave 2, 2026-11-18. This is a design recommendation, not
an infrastructure approval or a new user ruling. Thrive is outside d19.

## Recommended ownership

A service that only consumes domain events still publishes its own operational
statistics. Give it one service-owned durable topic exchange; do not publish its
reports on an upstream publisher’s exchange or on the default exchange. Keep
existing domain publishers on their current exchanges, as d1 requires.

Proposed names (verify broker inventory before provisioning):

| Reporting service | Own exchange |
|---|---|
| authz-api | authz.events |
| authz-sync | authz-sync.events |
| coach-api | coach.events |
| ads-adm-api | ads-adm.events |

Apply the same preview suffix helper used by the service’s other MQ topology.
The service identity remains the full API/worker name; exchange naming does not
change the identity, deployment, broker, vhost or counter contract. All reports
use `observability.event_stats.reported`. Capability remains `consumer`: sending
telemetry must not falsely advertise a domain producer.

An ads-adm-api report is not an adm.events publication: that domain exchange is
owned by connectv3-api. Each report can carry all of the service’s consumer rows,
including their actual upstream exchange/queue/event identifiers. Publishing one
copy on each upstream exchange would duplicate heartbeats and couple permissions
to the service’s inputs.

## Implementation and deployment requirements

- Current soa-event-stats 0.1.1 accepts `publisherExchange` but only passively
  checks it; it does not create exchanges. Setting a new name alone will fail.
- The new telemetry publisher must own creation of its exchange. Add an explicit
  opt-in owned-exchange setup on the isolated reporting connection (durable
  topic, not auto-delete), with bounded retry and a visible reporting failure.
  Preserve passive checks for existing domain publishers. Never assert an
  upstream exchange and never make application readiness depend on statistics.
- This needs a shared-package change and publish before consumer-only adopters
  use it. Reporting stays off by default; no extra broker connection when off.
- Vishnu binds its existing telemetry-only queue to each new exchange using the
  exact telemetry routing key. Add the names to receiver configuration and
  knowledge-pack ownership. Do not infer a business topology edge from the
  reporting transport.
- Coordinator reviews an explicit broker permission diff for the new names,
  preserving the receiver’s current limited configure/read/write grants and its
  own DLX. Do not add default-exchange write or broad wildcard grants. Reporter
  credentials and future fleet identity migration remain separate concerns.
- Before enabling: inventory bindings for `#`, `observability.#` and equivalent
  catch-all patterns; verify preview isolation; verify failure/recovery leaves
  domain processing and readiness healthy; verify exactly one scoped reporter
  per live instance in Vishnu. No infrastructure change is made by this note.

## Why this fits the existing decision

The resolved d1 chose publisher-owned exchanges instead of a shared observability
exchange. A consumer-only service has no existing publisher exchange to reuse;
when it starts publishing telemetry, it owns that publishing surface. A shared
telemetry exchange would simplify provisioning but revise d1’s ownership choice.
Writing onto iam.events/adm.events would hide ownership and require upstream
write permission. The proposed extension avoids both.

## Evidence

- [Resolved d1](../decisions/d1-event-stats-routing.md).
- `packages/node/event-stats/src/service.ts`: `ServiceStatsOptions`,
  `IsolatedRabbitMqReportTransport`, `createServiceEventStats`.
- `packages/node/event-stats/src/rabbitmq-transport.ts`: passive exchange check.
- Canonical reference:
  `/home/skelly/.codex/plugins/cache/saga-tools/saga-iac/1.25.0/references/event-driven/rabbitmq-topology.md`
  — publisher owns its durable topic exchange; consumers never assert upstream.
- Prod inventory and permission application remain with the Vishnu deploy
  coordinator under d19. Confirm proposed exchange names against that inventory
  before Wave 2 implementation.

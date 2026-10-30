# 02 — Telemetry pipeline

```
service (outbox relay / event consumers)
  └─ @saga-ed/soa-event-stats  counts per stream, cumulative per process epoch
       └─ every 30s (+1 at startup): one report message, own short-lived AMQP connection
            exchange: the service's own <name>.events (tagged .<preview> in a sandbox)
            routing key: observability.event_stats.reported
                 └─ Vishnu queue vishnu.<deployment>.event-stats.v1 (bounded: 10k msgs, 1h TTL)
                      └─ vishnu-api receiver → Postgres event_stats_source (one row per source, 24h)
                           └─ /api/event-stats → UI scopedStats → MQ icon and counters on the node
```

## Reporter side (in each service)

- Wiring: `createServiceEventStats({ service, capabilities, publisherExchange, onError })`.
  `eventStats.outbox(...)` wraps `OutboxRelay` options and `eventStats.consumer(...)` wraps
  `EventConsumer` options. `start()` at boot, `stop()` on shutdown. Export it type-annotated
  (`ReturnType<typeof createServiceEventStats>`) to avoid TS2883.
- **Off unless** `EVENT_STATS_ENABLED === 'true'`. When it's off the wrappers return the
  config unchanged. When it's on, `EVENT_STATS_ENVIRONMENT/DEPLOYMENT/REVISION/BROKER/VHOST`
  and `RABBITMQ_URL` are required, and a missing one fails startup.
- Deploy switch: CloudFormation `EventStatsEnabled` (default `'false'`). Put it in the template
  the service's dev and prod samconfig stanzas actually deploy. **program-hub uses the shared
  `infra/shared/service-template.yaml`.** A rule requires a broker and `Lane=none`, so a
  twin/mirror lane can never report as prod.
- Sandbox: the `event-stats` input on each repo's `sandbox-deploy.yml` (default off) sets
  `EventStatsDeployment=<sandbox identifier>`.
- Compatibility: event-stats 0.1.1 loads under Zod 3 and Zod 4 (d8); CI runs a Zod 3 suite.

## Receiver side (vishnu-api)

- Scope (d3): Datadog is environment-wide; MQ has its own **exact** scope
  `{environment, deployment, broker, vhost}`. Reports outside it are rejected.
- Allowlist (d6): `REPORTERS` maps service → exchange, and an unknown service fails closed.
  Today: iam-api, programs-api, scheduling-api. Wave 1 (d10) adds sessions-api, content-api,
  chat-api, insights-api and transcripts-api.
- Exchanges are only checked, never created (d1). Vishnu owns only its own queues.
- Sandbox observation (d9, PR#556): `VISHNU_MQ_PREVIEW_TAG` (= MQ deployment = `sandbox-<name>`)
  makes a colour bind the sandbox's tagged exchanges. One sandbox per colour; dev only.
- Store (d4): both colours share one Postgres store and can share the queue; rows are
  separated by scope.

## What it costs (see the risk page)

About 1 small message per instance per 30 seconds plus one TLS connection per report. For
the whole fleet that's about 1 msg/s against roughly 70 msg/s on the prod broker today.
Connection churn is the cost to watch.

# 01 — System overview

## Components (saga-ed/soa)

| Part | Path | Notes |
|---|---|---|
| Web UI | `apps/web/vishnu` | SvelteKit. Mesh graph (ELK layout), node and edge inspector, MQ and Datadog overlays, fixture/demo modes (`?mode=fixture`). |
| Hosted backend | `apps/node/vishnu-api` | One ARM64 Node container serving the built UI and the API (`/api/mesh`, `/api/datadog`, `/api/event-stats`, tRPC, `/config.json`, `/health`). JANUS protects everything except `/health`. |
| Telemetry library | `packages/node/event-stats` (`@saga-ed/soa-event-stats`) | What services embed to count and report outbox and consumer activity. |
| Outbox / consumer libraries | `packages/node/event-outbox`, `packages/node/event-consumer` | The business eventing libraries event-stats hooks into. |
| Local stack integration | `packages/node/saga-stack-cli` (`ss`) | Runs Vishnu and the mesh locally in synthetic slots (`--only vishnu`). |
| Infra | `infra/shared/service-template.yaml`, `infra/vishnu-api/` | SAM/CloudFormation, blue/green stacks, `render-deploy-command.py`, [OPS.md](../../../../infra/vishnu-api/OPS.md). |

## What it shows

- **Topology:** source-declared HTTP connections (`apps/node/vishnu-api/src/declared-topology.ts`)
  plus Datadog APM services and dependencies. APM names are node IDs; aliases live in
  `apmServiceAliases` (d6).
- **Health:** per-service rate, p95 and error rate, and monitors from Datadog (read-only app key).
- **MQ telemetry:** per-service producer and consumer counters (publishes, confirms,
  deliveries, commits, duplicate skips, failures, ack/nack/requeue) from event-stats reports.
  These are counts, not traffic edges: they can't show backlog or end-to-end latency.

## Hosting (dev)

- `https://vishnu.wootops.org`, dev account 396913734878, cluster `dev-shared-arm`.
- Blue/green colours behind dev ALB rule 4015 (weighted). Header
  `x-saga-preview-vishnu-api: blue|green` selects a colour directly.
- MQ receiver store: Postgres on db-host-v2 (`vishnu.dbs-v2.local:5438`), secret
  `soa/vishnu/dev/database-url`. The broker is the shared dev Amazon MQ `shared-dev-mq`.
- No prod deployment exists. `vishnu.sagaops.org` is reserved for prod.

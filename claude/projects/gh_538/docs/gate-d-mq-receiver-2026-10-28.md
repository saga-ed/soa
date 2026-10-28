# Gate D — MQ receiver on green (dev), 2026-10-28

Approved by skelly ("Approve gate D"). Reporters stay off; the live rule is unchanged.
Decisions: `claude/projects/gh_536/decisions/d3`–`d5`. Runbook: `infra/vishnu-api/OPS.md`
§ MQ receiver enablement.

## What was done

| Step | Result |
|---|---|
| Provision Postgres (db-host-v2 orchestrator `provision`) | `vishnu.dbs-v2.local:5438`, db `vishnu`, postgres 16, instance `i-0a379fa56291fbc50`; container running and healthy |
| Secret | `arn:aws:secretsmanager:us-west-2:396913734878:secret:soa/vishnu/dev/database-url-24YnM7` (value never printed or passed as an argument) |
| Bootstrap `soa-vishnu-api-bootstrap-dev` | Reviewed change set: added `RabbitMqIngress/Egress` (5671), `PostgresIngress/Egress` (5438), `MqSecretsPolicy`. Other changes were SAM metadata only, with no property changes. `UPDATE_COMPLETE` |
| Image | `396913734878.dkr.ecr.us-west-2.amazonaws.com/soa/vishnu-api:15098712`, digest `sha256:74b50145ef19dd3a87bfe7476bcb13418d09d6c42de8f2b37bcc18fe2ff5fa83`, built from `1509871278a3d03a95d39b351093d622498febc0` (PR#554 head) |
| Green `soa-vishnu-api-green` | Reviewed change set (new task definition revision 2, service update): `DesiredCount=1`, `VishnuMqEnabled=true`, `EventStatsBroker=shared-dev-mq`, deployment `main`, vhost `/`. `UPDATE_COMPLETE`, 1/1 running |

## Validation

- Preview header `x-saga-preview-vishnu-api: green` → `/health` reports colour `green`,
  version `1509871278…`. Unheadered live traffic still reaches blue `9c4b699a…`.
- Auth: `/` → 302 to `gate.wootops.org`. `/config.json`, `/api/event-stats` and the tRPC
  `telemetry.eventStats` route → 401 without a session.
- Store: table `event_stats_source` created by green (columns `source_key, report,
  comparison, retired_epochs, received_at`), 0 rows.
- Broker (read-only management API): `vishnu.main.event-stats.v1` is a durable quorum
  queue (max-length 10,000, TTL 1h, dead-letters to `.invalid`), with 1 consumer and
  0 messages. It is bound only to `observability.event_stats.reported` on `iam.events`,
  `programs.events` and `scheduling.events`. `.invalid`: 100 / 1h, no consumers.
- Restart: the green task was stopped. ECS replaced it on the same revision, health was
  green, there were no `vishnu-event-stats` warnings, and the queue was back to
  1 consumer.
- Isolation: nothing depends on green. Blue and the live rule were untouched
  (4015 still blue 100 / green 0).

## Not yet exercised (needs real reporters, Gate G)

- Receiving, scope rejection and redelivery of real reports. These are covered by unit
  and synthetic tests. No synthetic traffic was published to the shared broker.
- The staff UI rendering hosted MQ stats through a real JANUS session.

## Tooling notes

- The dev db jump host idle-stops. The installed `ss` (1.0.274) has no `--jump-host`
  and tried to dial the db-host instance directly (denied to AppRuntime). The main-branch
  `ss` (`packages/node/saga-stack-cli`) started the jump host and tunnelled correctly.

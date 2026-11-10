# d7 — Reporter activation, observation and rollback (dev)

RESOLVED — 2026-10-28

User ruling: "As recommended". A1: an `EventStatsEnabled` CloudFormation parameter
per service (default `'false'`, values validated by `AllowedPattern`), flipped by a
normal health-checked deploy. B: IAM → Programs → Scheduling, 60 minutes each, then a
48h soak, with the stop rules below and a d5 audit re-run first. C: reporting off
first, then image or colour rollback, with Vishnu reverted independently.

## Context

The adoption PRs (rostering PR#1783, program-hub PR#1023) wire reporting in, but
nothing turns it on in a hosted environment. No adopter `service-template.yaml`
mentions `EVENT_STATS` yet. Reporting is opt-in: off unless `EVENT_STATS_ENABLED` is
exactly `true` (`packages/node/event-stats/src/service.ts:64`). When it is on,
`EVENT_STATS_ENVIRONMENT`, `_DEPLOYMENT`, `_REVISION`, `_BROKER`, `_VHOST` and
`RABBITMQ_URL` are required, and **a missing value fails startup**.

Runtime cost per instance, when on: one report every 30s (`EVENT_STATS_INTERVAL_MS`).
Each report opens its own short-lived AMQP connection (2s timeout, bounded close) and
closes it (`service.ts:11–50`). That is about two TLS handshakes a minute, and never
shares a connection or channel with business traffic.

Values from d3–d5: environment `dev`, deployment `main`, broker `shared-dev-mq`,
vhost `/`, and the existing shared broker credential (`RABBITMQ_URL`, already in each
template).

## Decision A — how reporting is switched on and off

1. **A CloudFormation parameter per service**, `EventStatsEnabled` (`'true' | 'false'`,
   default `'false'`). The template sets the six env vars from constants and existing
   values: revision from the same image tag as `DD_VERSION`, broker and vhost per
   account. A flip is a normal deploy dispatch with the parameter overridden.
   - Same pattern as `FgaEnabled` and `IamScopeEnforce` in these templates. Reviewed and
     auditable. A flip takes one deploy (minutes).
2. **An SSM parameter read into the task definition** (`valueFrom`), flipped with a
   forced new ECS deployment.
   - Flips skip a change set, but the value only takes effect at task start, so it is
     no faster. It is also less visible in review.
3. **A live kill switch** the reporter polls without restarting.
   - Fastest off switch, but it is new code in a package just published.

## Decision B — order, observation and stop rules

Proposed (from the go-live plan, phase 7):

- **Order:** IAM → Programs → Scheduling, one at a time, after the reporting-off
  deploy of each is at baseline (Gate F).
- **Observation:** 60 minutes per service before the next. Then a **48h soak** with
  all three on.
- **Stop, then turn that service's reporting off**, if any of these happen:
  - p95 latency or error rate more than 10% over its prior-24h baseline
  - business queue depth or age rising against baseline, or any consumer ack anomaly
  - reporter failures above 1% of reports, or any startup failure
  - no Vishnu heartbeat from the enabled service for more than 2× the interval (60s)
- **Before the first enablement:** re-run the d5 binding audit
  (`claude/projects/gh_536/scripts/broker-binding-audit.py`).

## Decision C — rollback

1. **Reporting off first:** redeploy the service with `EventStatsEnabled=false`.
   Business messaging is untouched; reporters use their own connections.
2. **If business behaviour regressed:** restore the previous image digest or colour.
3. **Vishnu itself:** stop or revert the receiver independently. Its queue is bounded
   (10,000 messages, 1h TTL), so reports expire rather than build up.
4. **Never:** delete business queues or data, or overwrite a published package
   version. Roll forward with a patch release instead.

The main risk in A1 is a misconfigured enablement crashing the service at startup.
Guard against it with `AllowedPattern` on the template parameters, and by enabling
each service through its normal health-checked deploy, so a failed start fails the
deploy instead of replacing healthy tasks.

## Recommendation

**A1, B as proposed, and C.** A1 matches how these templates already gate features.
Flips are reviewed deploys, and the off switch is no slower than any alternative short
of new code. The template changes are three small PRs (one per service, merged with
reporting off), so they fit Gate F's merges. Confidence: high for A1 and C; medium for
the B thresholds, which are first guesses to tighten after the IAM step.

## Related artifacts

- `/home/skelly/dev/worktrees/soa-gh_536-event-telemetry/packages/node/event-stats/src/service.ts` (lines 11–50, 62–91)
- `/home/skelly/dev/worktrees/rostering-gh_537-event-stats-adoption/infra/iam-api/service-template.yaml` (`FgaEnabled` line 300, `IamScopeEnforce` line 376, `RABBITMQ_URL` line 1496)
- `/home/skelly/dev/worktrees/program-hub-gh_537-event-stats-adoption/infra/programs-api/service-template.yaml` (`RABBITMQ_URL` line 672)
- `/home/skelly/dev/worktrees/program-hub-gh_537-event-stats-adoption/infra/scheduling-api/service-template.yaml` (`RABBITMQ_URL` line 602)
- `/home/skelly/.claude/jobs/a991d196/tmp/vishnu-go-live-plan.md` (phase 7 thresholds)
- [d3](d3-mq-scope-model.md), [d4](d4-receiver-store-and-colour-ownership.md), [d5](d5-broker-isolation-and-audit.md)

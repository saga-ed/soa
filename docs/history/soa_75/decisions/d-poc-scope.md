# d-poc-scope — Full lifecycle (Phases 0-4), back-port deferred

RESOLVED 2026-04-30: Option B — full lifecycle coverage including operational additions (Tier 1 + Tier 2 dimensions added during walkthrough). Back-port to soa packages (Phase 5) deferred until the POC has soaked. Total estimated effort ~12-17 days at Claude pace.

## Context

The POC's stated goal is to demonstrate the **total cost of ownership** of event-driven microservices for a team experienced with monolith-on-EC2. Three scope options were considered:

- **A. Full** including back-port (Phases 0-5)
- **B. Full minus back-port (Phases 0-4)** — chosen
- **C. Trim Phase 4** (skip OpenTelemetry / Jaeger and the 4th analytics-svc) — saves ~2 days but loses the debugging-via-traces dimension
- **D. MVP first** (Phases 0-2 only, ~6-9 days) — happy-path POC, not a lifecycle POC; skipping Phase 3 means skipping 4 of the 6 originally-named lifecycle dimensions

## Options considered

The decisive insight: **Phase 3 is where 4 of the 6 originally-named lifecycle dimensions land** (event version bumping, packaged types, CI/CD contract checks, service version rollout). Cutting Phase 3 turns the POC into a happy-path demo, not a lifecycle proof.

Phase 4 (observability) is small and high-ROI — distributed tracing is the canonical answer to "where did this event get stuck?" — and OpenTelemetry SDK setup is 1-2 days at Claude pace.

Phase 5 (back-port) produces an externality (PRs against `soa/packages/`). Deferring lets the green-field packages live in the POC for a week or two before committing to the soa interface.

## Recommendation

**Option B.** Full lifecycle coverage (Phases 0-4). Back-port deferred.

## Lifecycle dimensions extended during planning walkthrough

Original 6 dimensions named by user: testing, debugging, event version bumping, packaged types, CI/CD contract checks, service version rollout.

Added 8 operational dimensions after user reframe ("monolith-on-EC2 team — surface gotchas before they bite at 4 months"):

7. Eventual-consistency UX patterns (read-your-writes, 202 + Retry-After, "not yet" states)
8. Ops incident response runbooks (broker down, consumer crash, schema mismatch, projection lag)
9. Consumer lag + backpressure monitoring (Prometheus + Grafana board)
10. Poison-message recovery procedures
11. Data-correction patterns (compensating events, replay, manual SQL)
12. Publisher-edge idempotency (`Idempotency-Key` header)
13. Event catalog auto-generation (discoverability for new contributors)
14. SLIs/SLOs for the event system

Tier 3 dimensions handled as docs callouts, not exercised in code: local-vs-prod parity, auth through events, schema migration coordination across services.

## Phase summary (after walkthrough additions)

| Phase | Goal | Days (Claude-pace) |
|---|---|---|
| 0 | Foundation (monorepo, Docker, soa-api-core baseline, identity-svc health.ping) | 2-3 |
| 1 | Happy-path event flow (3 services, one event, outbox, consumer, projection) | 2-3 |
| 2 | Real coupling + projections + eventual-consistency UX | 4-5 |
| 3 | Lifecycle exercises (schema bumps, new consumer, contract CI, poison messages, idempotency) | 5-6 |
| 3.5 | Operational readiness (runbooks, SLIs, lag monitoring, data correction) | 2-3 |
| 4 | Observability + debugging (OpenTelemetry, Jaeger, structured logs, event catalog) | 2-3 |
| 5 | Back-port to soa | **deferred** |

## Verification gates

Each phase has explicit gates documented in the plan. Final gate: another engineer (or Claude) can read `docs/adding-an-event.md` cold and add a new event in under 30 minutes; on-call rookie can run `pnpm scenario:<name>` against `pnpm dev:infra`, watch the stack, and recover from a simulated incident in under 15 minutes.

## Related artifacts

- POC plan: `/home/spaul/.claude/plans/fancy-finding-dream.md`
- Sibling decision: `d-lifecycle-dimensions.md` (the 14 dimensions)
- Sibling decision: `d-scenario-scripts.md` (live-stack scripted scenarios)

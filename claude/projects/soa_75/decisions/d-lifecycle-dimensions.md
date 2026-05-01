# d-lifecycle-dimensions — 14 dimensions the POC exercises

RESOLVED 2026-04-30: 14 lifecycle dimensions covered in code. Original 6 named by user; 8 operational dimensions added after the user reframed the POC's goal as "expose gotchas before they bite at 4 months" given the team's monolith-on-EC2 experience.

## Context

The original POC framing listed 6 lifecycle dimensions: testing, debugging, event version bumping, packaged types, CI/CD checking contracts, service version rollout.

User reframed mid-walkthrough: "We really need to understand total cost of ownership. Honestly if I missed anything in my list we should add to it. Our team is familiar with managing a monolith EC2 service. I want to hit any pain/gotchas in the safe environment instead of 4 months after first deployment and it's unclear how we can do some change."

The big insight: **monolith → event-driven microservices is mostly an operational paradigm shift, not a code one.** The dimensions a monolith team is least prepared for are operational, not architectural.

## The 14 dimensions

### Tier 1 — Bites hardest, monolith experience doesn't prepare you

7. **Eventual-consistency UX patterns.** "I wrote it, I can read it" no longer holds. UI/API patterns: 202 + Retry-After, correlation-ID lookback, "wait up to N ms," explicit "not yet" states.
8. **Operational incident response runbooks.** Broker down, consumer stuck on poison message, projections 100k events behind. With a monolith, "the app is down" is one runbook. With event-driven, you have N×M failure modes.
9. **Consumer lag and backpressure monitoring.** Without an SLI for "lag," you don't notice the consumer is broken until SLAs miss.
10. **Poison-message recovery.** A single bad event breaks the consumer. Recovery procedure: inspect → repair → replay/skip.
11. **Data correction across services.** Bad event shipped to N consumers. Fix via compensating event, replay-from-outbox, or manual SQL across N consumer DBs. Knowing which when is non-obvious.

### Tier 2 — Worth exercising in POC

12. **Publisher-edge idempotency.** Consumer-side dedup catches double-delivery; doesn't catch user clicking submit twice. `Idempotency-Key` HTTP header with response cache.
13. **Event discoverability.** With 20+ event types, "what events exist and what's in them?" becomes a real question. Auto-generated catalog from `@example/*-events` packages.
14. **SLIs/SLOs.** Different from monolith — publish-to-consume latency, consumer lag, DLQ depth, retry rate, projection freshness.

### Original 6 (user-named)

1. Testing
2. Debugging
3. Event version bumping
4. Packaged types
5. CI/CD checking contracts
6. Service version rollout

### Tier 3 — Documented, not exercised

15. Local-vs-prod parity (docker-compose RabbitMQ vs prod cluster).
16. Auth/identity through event envelope (callout, not implemented).
17. Schema migration coordination across services (callout).

## How dimensions map to phases

| Dimension | Phase | Deliverable |
|---|---|---|
| 1 Testing | 1, 2 | testcontainers integration tests; vitest config |
| 2 Debugging | 2 (DLQ), 4 (traces) | DLQ inspection endpoints; Jaeger |
| 3 Version bumping | 3 | additive + breaking bump exercises |
| 4 Packaged types | 1, 3 | per-family `@example/*-events`; CHANGELOG |
| 5 CI contract checks | 3 | `tools/contract-check/` + CI workflow |
| 6 Version rollout | 3 | breaking-bump 5-PR walkthrough + runbook |
| 7 Eventual consistency UX | 2 | `GET /enrollment-readiness` 202 pattern |
| 8 Ops runbooks | 3.5 | `docs/runbooks/*.md` + scenario drills |
| 9 Lag monitoring | 3.5 | Prometheus + Grafana board |
| 10 Poison-message recovery | 3 | drill + runbook |
| 11 Data correction | 3.5 | docs + worked examples |
| 12 Publisher-edge idempotency | 3 | `Idempotency-Key` demo + test |
| 13 Event catalog | 4 | auto-generated HTML page |
| 14 SLIs/SLOs | 3.5 | metrics + alerting thresholds |
| 15 Local-vs-prod parity | 4 | `docs/local-vs-prod-parity.md` |

## Related artifacts

- POC plan: `/home/spaul/.claude/plans/fancy-finding-dream.md` § "Decision walkthrough log"
- Sibling decision: `d-poc-scope.md`
- Sibling decision: `d-scenario-scripts.md`

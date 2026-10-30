# 05 — Open work (2026-10-30)

## System functionality (skelly + Astra)

| Item | Where | Notes |
|---|---|---|
| Ultrawide layout | soa PR#558 (draft) | Canvas-shaped layering. Open: page chrome (toolbar and status lines) still takes most of the height at 1568×587; SIMPLE placement adds some edge bends; validated on a synthesized hosted snapshot. |
| Sandbox observation UX | soa PR#556 (draft) | Status line labels the sandbox scope. Browsers can't reach blue without a header extension (ModHeader `x-saga-preview-vishnu-api: blue`). A cookie or URL switch is a possible improvement. |
| Consumer-only reporting design | d10 wave 2 | Needs a ruling: (i) another team's exchange, (ii) a shared `observability.events` exchange, (iii) defer. Raise (ii) with Seth. |
| Overlap with native tracking | risk page | Broker metrics and APM already cover rates, backlog and consumer errors; event-stats adds dedup, outbox confirms, attribution and idle liveness. Decide what the fleet keeps. |
| Reporter connection reuse | event-stats | One TLS connection per report; a reused reporting connection, or a 60s interval, before any fleet rollout. |
| Counts are not traffic | UI copy | Make sure nothing implies backlog or latency from counters. |
| saga-stack-cli test flake | soa CI | `env connect` 30s timeout flakes; a Layer 1 `saga-stack-cli` job also failed on PR#556 (unrelated to it). |

## Go-live (Claude; see the [plan](../../gh_536/plans/go-live-plan.md))

1. Wave 1 into the soak: Vishnu `REPORTERS` update, sds trio into the sandbox, rebuild blue, verify 8 services.
2. 48h soak, post-soak checks, explicit teardown.
3. Boot smoke check in adopter CI (d8).
4. Vet and merge the adopter PRs (Gate F), with a prod-deploy hold decision; then dev-main enablement (Gate G).
5. Prod plan via saga-fleet `ship` (adopters and Vishnu itself).

## Handoff rule

Astra changes land as normal PRs. Anything that changes what ships (packages, templates,
receiver scope, `REPORTERS`) should be flagged to Claude so the go-live plan and the
sandbox stay in step.

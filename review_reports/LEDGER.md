# SOA (saga-soa) — Launch Systems Review Ledger

> Durable checkpoint. Each row is a review **unit** (`{subsystem × dimension}`).
> Resume from this table: any unit not `✅ done` is safe to (re-)run. Findings in
> `review_reports/<dimension>/`. Severity: **S1** launch-blocker · **S2** high ·
> **S3** medium · **S4** low/nit. `N/A` = not applicable.

**Repo:** soa (shared infra — `@saga-ed/soa-*`; consumed by every downstream fleet repo)
**Branch:** `claude/launch-systems-review-32z85n` · **Mode:** review-only

## Dimensions
- **SEC** — Security & Access (auth middleware, **XREPO-1 perimeter prod-off guard**, authz model/FGA, secrets/config, preview-header trust)
- **DATA** — Data & Compliance (PII redaction in logger, deidentify, event-envelope payloads, db/postgres boundaries)
- **CORR** — Correctness & Reliability (event outbox/consumer delivery, api-core, db adapters, pubsub, DI patterns)
- **OPS** — Launch Ops & Scale (saga-stack-cli, health, observability, aws-util, config, deploy/manifest tooling)

## Carried-in checks (MUST verify here)
- **XREPO-1** (from janus/SEC-6) — `packages/node/api-util/src/utils/dev-perimeter-production.ts` + `dev-perimeter-config.ts`: verify `devPerimeterProductionViolation` **refuses perimeter-ON in production** and the `DEV_PERIMETER_ENABLED`/`JANUS_REQUIRED` fork is sound (unset/malformed handling). Assigned to **SEC**.

## Grid

| Unit | SEC | DATA | CORR | OPS | Findings |
|---|---|---|---|---|---|
| soa (shared infra) | ⏳ | ⏳ | ⏳ | ⏳ | pending |

## Status log

| Date | Unit · Dimension | Status | S1 | S2 | S3 | S4 | Commit |
|---|---|---|---|---|---|---|---|
| _pending_ | | | | | | | |

<!-- Legend: ⏳ pending · 🔄 in-progress · ✅ done · ⬜ N/A -->

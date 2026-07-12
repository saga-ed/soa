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

## Grid

| Unit | SEC | DATA | CORR | OPS | Findings |
|---|---|---|---|---|---|
| soa (shared infra) | ✅ | ✅ | ✅ | ✅ | [SEC](SEC/soa.md) · [DATA](DATA/soa.md) · [CORR](CORR/soa.md) · [OPS](OPS/soa.md) |

## Rollup — soa

**27 findings · S1: 0 · S2: 6 · S3: 12 · S4: 8.** No launch-blockers, but the
S2 count is materially higher than janus (6 vs 2) — expected, since soa is the
fleet foundation and each finding fans out to every downstream repo. Risk
concentrates in the **durable event path** (3× S2) and **fleet-inherited
defaults** (CORS, secret-fetch, deidentify).

### ✅ Carried-in check XREPO-1 — VERIFIED SOUND (SEC-1, confidence H)
The dev-perimeter prod-off boot guard (`api-util/src/utils/dev-perimeter-production.ts`,
`dev-perimeter-config.ts`) is correct and fail-safe on all four sub-checks:
`devPerimeterProductionViolation`/`assertDevPerimeterProductionConfig` **throws**
when `enabled && NODE_ENV==='production'`; toggle forks right (default-ON dev,
disables only on literal `"false"`, `JANUS_REQUIRED` alias honored only when new
name unset); "production" = deploy-time `NODE_ENV`, **not runtime-spoofable**;
all malformed/unset cases fail closed (prod → over-gate outage, never silent
perimeter-ON serving prod). OPS independently confirmed `saga-stack-cli` has **no
prod launch path** and only ever writes the flag `false`. **The load-bearing
perimeter invariant holds across the janus→soa boundary.**

### S2 (high) — 6, address before launch
- **CORR-1** — Event relay uses a plain `Channel`, marks `published_at=NOW()` on socket-buffer not broker ack; broker crash/failover before fsync = **silent permanent event loss**. `newConfirmChannel()` exists but is unused. (`relay.ts:107-112,371`)
- **CORR-2** — Consumer fires `void this.dispatch(...)` un-awaited with `prefetch` 10 → up to 10 handler txns concurrent; `consumed_events` dedups but **does not order** → last-writer-wins projection corruption under normal throughput. (`consumer.ts:274-299`)
- **CORR-3** — Batch-atomic publish: one un-publishable/backpressured row throws, rolls back the whole batch, re-publishes batch-mates every tick, **head-of-line-blocks the outbox** indefinitely. (`relay.ts:249-318`)
- **SEC-2** — `ExpressServer` default CORS reflects **any** origin + `credentials:true` when `corsAllowedDomains` unset (safe `buildSagaOriginAllowlist` primitive exists but default bypasses it) → fleet-wide credential-theft/CSRF-readback. (`express-server.ts:48,76`)
- **DATA-1** — `fixture-deidentify` mongo scrubber only handles 3 allowlisted collections (`default: break` ships unknown collections raw) and **never scrubs `dob`** despite logger flagging DOB as FERPA → multi-repo prod-mirror exposure. (`mongo-deidentifier.ts:23-37,65-77`)
- **OPS-1** — `aws-util/secret-helper.ts:58-83` Secrets Manager fetch **fails open**: swallowed error → `undefined` → coalesced to `'{}'` → service boots in prod with empty creds/signing-key instead of crashing.

### S3 (medium) — 12
- SEC: FGA enforcement fail-open default flag; FGA check API takes unvalidated ref strings (bypasses `ensureValidId`).
- DATA: logger deny-list omits `studentId`/`ssn`/`phone`/`address` (top-level `{studentId}` reaches Datadog clear); event `payload` is unclassified `z.unknown()` + `outbox_event` rows never purged (PII persists indefinitely).
- CORR: no-DLQ handler errors requeue in uncapped poison loop; `mountHealthRoutes` checks only Postgres (green while broker down + outbox backing up); preview-isolation assert covers DB schema but not exchange name → cross-PR event leaks with passing startup.
- OPS: config loader accepts empty-string as satisfied required var (fail-open on empty secrets); config loader does no coercion (bool/number schemas boot-fail without `z.coerce`); logger prod-stdout path gated on `isExpressContext` else Fargate-unsafe worker transport; CLI manifest uses deprecated `JANUS_REQUIRED` alias; aws-util no retry/throttle tuning + hardcoded region.

### S4 (low/nit) — 8
- SEC: preview headers forwarded without value/env validation; Postgres TLS defaults off.
- DATA: soa introduces no hard-delete default (correct — soft-delete lives downstream); sound/N-A.
- CORR: fatal rethrow surfaces as `unhandledRejection` not documented `uncaughtException`; retention TTL has no floor vs redelivery window; `occurred_at` ordering is client-clock not commit-order.
- OPS: dead duplicate `config-manager.ts`; `saga-stack-cli` on zod 3 vs zod 4 workspace-wide.

## Cross-repo carry-overs
| ID | Raised in | Owning repo | Item | Status |
|---|---|---|---|---|
| XREPO-1 | janus/SEC-6 | soa | Perimeter prod-off guard verification | ✅ VERIFIED SOUND (soa/SEC-1) |
| XREPO-2 | soa/SEC-2 | **all downstream** | Verify each service overrides `corsAllowedDomains` (soa default is unsafe: reflects any origin + credentials). Check during each repo's SEC slice. | ⏳ open |
| XREPO-3 | soa/DATA-1 | **all repos using prod-mirror fixtures** | Confirm no reliance on `fixture-deidentify` to scrub `dob` or non-allowlisted collections. | ⏳ open |
| XREPO-4 | soa/CORR-1..3 | **all event-driven services** | Durable-event delivery gaps are inherited; verify whether any downstream service depends on exactly-once/ordered outbox delivery. | ⏳ open |

## Status log

| Date | Unit · Dimension | Status | S1 | S2 | S3 | S4 | Commit |
|---|---|---|---|---|---|---|---|
| 2026-07-12 | soa · SEC | ✅ | 0 | 1 | 2 | 2 | _this commit_ |
| 2026-07-12 | soa · DATA | ✅ | 0 | 1 | 2 | 1 | _this commit_ |
| 2026-07-12 | soa · CORR | ✅ | 0 | 3 | 3 | 3 | _this commit_ |
| 2026-07-12 | soa · OPS | ✅ | 0 | 1 | 5 | 2 | _this commit_ |

<!-- Legend: ⏳ pending · 🔄 in-progress · ✅ done · ⬜ N/A -->

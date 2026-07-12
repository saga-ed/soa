# Saga Launch — Pattern-Convergence Remediation Plan

> Sequenced plan to close the 13 S1 launch-blockers and the 6 cross-cutting themes
> from `LAUNCH-REVIEW.md`, organized by **shared pattern** (per `PATTERN-ADOPTION.md`).
> Grounded in the actual reference implementations (file:line cited). **Still
> review-only** — this is the plan; each fix ships as its own per-repo PR on
> `claude/launch-systems-review-32z85n` (or a child branch) only on your go.

_Authored 2026-07-12 from the completed 28-unit review + 2 reference-impl grounding passes._

## Strategy: distribution, not invention

Every diverging pattern already has a correct in-fleet reference. The lever that
made CORS cohere (~90% adoption) was a **shared helper + a CI guard**. This plan
applies that same lever to the diverging behavioral patterns. Three moves in
priority order close 11 of 13 S1s; the remaining 2 are one-line point fixes.

| Workstream | Theme | S1s closed | Shape |
|---|---|---|---|
| **WS-1 Shared per-request authz** | T1 | 7 | new `soa-authz-core` + `soa-trpc-base` middleware + CI guard |
| **WS-2 Fleet alarms** | T2 | 4 | `saga-iac` `alarms-template.yaml` nested stack |
| **WS-3 Point fixes** | — | 2 | rostering rate-limit override; qboard recordings bucket |
| **WS-4 Canonical outbox** | T3 | 0 (prevents silent data loss) | promote pull package + fix soa relay |
| **WS-5 Harden shared defaults + convergence guards** | T4,T5 | 0 | soa fail-closed defaults; OIDC template; CI guards |
| **WS-6 Education-record retention/encryption** | T6 | 0 (FERPA) | fleet retention/encryption policy pass |

---

## WS-1 — Shared per-request authorization (THEME-1, 7 S1s) · **critical path**

**Goal:** a shared, enforced per-request authz layer so the prod authorization
floor no longer depends on the janus perimeter (off in prod). This delivers
"tier-1.5" — real server-side permission/ownership/membership checks on the
existing iam group→persona→permission contract. **Full tier-2 (OpenFGA) is a
separate follow-on** (see Open Questions); tier-1.5 is sufficient to close every
S1 here.

### Reference implementation (what we standardize on)
- **`SessionsAuthzService`** (`program-hub/apps/node/sessions-api/src/sectors/sessions/sessions-authz.service.ts`) — the model call-site pattern: router gates authN only; the **service layer** runs `await this.authz.assertCan…(ids, callerId, action)` as its first statement (`sessions-lifecycle.service.ts:90-94`). Denials throw masked NOT_FOUND (`:37-40`). Deactivated-caller gate runs on every path (`:100,177,284,310`). Grant eval = time-windowed `authzPersonaAssignment` → `authzPersonaDefinition.permissions.includes(perm)` (`:214-257`) — the same contract iam-api owns.
- **iam-api `fgaCheck(relation, objectFor, opts)`** (`rostering/apps/node/iam-api/src/trpc.ts:759-790`) — a composable per-procedure middleware *factory*; the closest existing reusable shape. The shared middleware generalizes this.
- Ownership primitive: coach `authorizeUserAccess` (`coach-api/src/sectors/cns/gql/cns.resolver.ts:103-113`). Membership→role primitive: connectv3 `resolveSessionAccess` (`qboard/apps/node/connectv3-api/src/programs-api/session-access.ts:191`). Scoped-permission primitive: rostering `resolveIncludePii` (`iam-api/src/sectors/user/user.router.ts:70-81`).

### Build
1. **`@saga-ed/soa-authz-core`** (new, runtime-agnostic — usable from tRPC, GraphQL resolvers, Express routes). Exposes the 3 primitives every good call-site already expresses:
   - `requirePermission(ctx, permission, scope?)` — resolve caller's flat `permissions[]` in scope, assert `.includes`; throw masked denial.
   - `requireOwnership(ctx, resourceUserId)` — assert `ctx.userId === resourceUserId`.
   - `requireMembership(ctx, resource) → role | scope` — assert relationship, **return** derived role/scope (host/participant, 'all'|'own', HOST|ADMIN) so callers gate *and* branch.
   - plus shared `maskDenial()` (denial ≡ uniform not-found/forbidden, un-probeable) and `assertActiveCaller(ctx)` (deactivated gate).
2. **`SagaAuthContext` interface** (the precondition — *no shared `ctx.permissions` exists today*; coach/iam-api/sessions-api each source it differently). Minimal: `{ userId?: string; permissions(scope?): Promise<string[]> }`. Each service supplies a thin **adapter** (JWKS-verified identity is already common fleet-wide).
3. **`soa-trpc-base` middleware** (`soa/packages/core/trpc-base` already exports `t.middleware` — the hook). Add an `authedProcedure`/`protectedProcedure` base + an authz-middleware factory modeled on `fgaCheck`, so services stop re-deriving `enforceAuth`.

### Adoption order (most-exposed first)
| # | Service surface | Current state | Work |
|---|---|---|---|
| 1 | program-hub **scheduling-api** | S1 — fully unauthenticated | adapter + base procedure + `require*` at every mutation; bind tenant (SEC-2) to verified identity not `x-organization-id` |
| 2 | **all SDS services** | S1 — `isAuthenticated` bool only | adapter + base procedure; `requirePermission`/`requireOwnership` on data procedures; ads-adm-api: drop `publicProcedure`, remove caller-supplied `authUserId` |
| 3 | rostering **iam-api** writes + admin | S1 — perimeter-only / fails open | `require*` on `user.*`/`groups.*`; fix `enforceIamAdmin` null-claims `next()` + FGA `whenDisabled` |
| 4 | qboard **playback-api** | S1 — global-role, legacy saga_api | migrate to iam session + `requireMembership(session)` per-recording (also WS-3/WS-6) |
| 5 | coach reports + `transitionModuleState` | S2 IDOR | `requireOwnership`/`requireMembership` (coach#94 wires real PII here — do first) |

Service-layer call-site pattern (program-hub) **stays**; only the primitive bodies move to the shared module. `sessions-api`, connectv3-api, coach-CNS, rostering-PII already conform — they refactor to import the shared primitives, proving the interface.

### CI guard (converts convention → enforcement — the CORS lever)
Coach's `ensure-no-role-branching.js` detects *banned* patterns; authz coverage is the inverse (*missing* gate) problem, so:
- **First cut:** a `.meta({ authz: … })` convention on every tRPC mutation + a scanner (reuse the `ensure-no-role-branching` skeleton: static scan, `process.exit(1)`, wired as a CI step like `_deploy-ecs-api.yml:322`) that fails on any mutation lacking `authz` meta.
- **Evolve to:** a ts-morph walk of each `appRouter` asserting every `.mutation` derives from the authz-bearing base procedure or calls a `require*` (highest fidelity), or an "authz-pins" manifest modeled on `soa/packages/node/contract-check`'s registry-vs-reality architecture.

**Effort:** shared module ~M; per-service adoption ~S–M each (5 services). **Closes S1 #1,2,4,5,8(part),11,12.**

---

## WS-2 — Fleet alarms (THEME-2, 4 S1s) · **do first — cheap + makes everything else detectable**

**Goal:** every deployed service pages an operator on failure. Telemetry already
exists fleet-wide (`soa observability/metrics.ts` `/metrics`, ALB health checks);
nothing is wired to an alarm (0/5). `sds/infra/DEVIATIONS.md:213-215` already
names the intended alarm set.

### Substrate (grounded)
IaC is **SAM/CloudFormation YAML copied per service — no CDK, no deployed shared stack.** "Shared" = a reference template in `claude-plugins/plugins/saga-iac/references/` repos copy. So alarms ship as **CloudFormation**, not a soa code package.

### Build
- **`alarms-template.yaml`** added to the `saga-iac` `ecs-service` reference set, deployed as a **nested stack** (`AWS::CloudFormation::Stack`) each `service-template.yaml` includes with ~5 `!Ref`s (target-group ARN, ECS service name, SNS topic ARN). ~5 lines per service.

### Two phases (grounded on signal availability)
- **Phase 1 — ships immediately (pure CFN off existing CloudWatch metrics):**
  - 5xx rate — ALB `HTTPCode_Target_5XX_Count`
  - Task health — `UnHealthyHostCount` (health check already at e.g. `rostering/infra/iam-api/routing-template.yaml:182-194`)
  - ECS saturation — `CPUUtilization`/`MemoryUtilization`
- **Phase 2 — needs a metrics→CloudWatch bridge that no service runs today** (`/metrics` is served but never scraped): add an ADOT/CW-agent sidecar or `PutMetricData` emitter, then alarm on:
  - Relay liveness/lag — `outbox_unpublished_count` gauge (`observability/metrics.ts:103-117`)
  - DLQ depth — `events_failed_total` (broker) / SQS `ApproximateNumberOfMessagesVisible` (olap lambda)

**Adoption order:** iam-api + all deployed services; prioritize the auth hotpath (iam-api) and the analytics/scheduling pipelines. **Effort:** template ~S; per-service include ~XS. **Closes S1 #6,7,10,13** (Phase 1 alone clears all four).

---

## WS-3 — Point fixes (2 S1s + fast wins) · **immediate, independent**

- **rostering OPS-1 (S1)** — set the iam-api prod per-IP rate limit override (currently `IsProd→NoValue` → code default 100/min). One `service-template.yaml` parameter. Size the limit to real S2S fan-out (30–60 iam calls/roster row). **~XS.**
- **qboard DATA-2/OPS-2 (S1)** — define an actual `AWS::S3::Bucket` for recordings (repo defines none): SSE-KMS, `PublicAccessBlockConfiguration`, lifecycle/expiration, block the guessable-key exposure. Replace `saga-dev-temp-bucket`. Overlaps WS-6. **~S.**
- **qboard XREPO-7** — rotate + remove the committed `x-playwright-waf-bypass` bypass secret in the `iam-auth` fork. **~XS.**

**Closes S1 #3, #9.**

---

## WS-4 — Canonical reliable outbox (THEME-3, XREPO-6) · **prevents silent analytics/scheduling data loss**

**Two delivery models, not two impls — keep both, make each correct, pick a default.**

- **Default = pull** (rostering `event_outbox` + `events.since`, `iam-api/src/sectors/events/`). Transactional write (`event-emitter.service.ts:65-73`), monotonic-BIGSERIAL ordering, 500ms stability cutoff (`event.data.ts:27`), consumer-cursor idempotency, **no broker in the delivery path → the entire "no publisher confirms" bug class cannot exist.** Promote unchanged into `@saga-ed/soa-event-outbox-pull` (the `events.since` service + Zod-validated `emit(tx,…)` writer + BIGSERIAL migration).
- **Push = opt-in** (soa `OutboxRelay`, for genuine broker fan-out/topic routing), with two fixes:
  1. `newChannel()` → `newConfirmChannel()` (`relay.ts:138`; method already exists unused at `rabbitmq/connection-manager.ts:222`) + `await channel.waitForConfirms()` before `published_at=NOW()` (`relay.ts:291`). ~1 broker round-trip/batch.
  2. Per-row settle replacing the batch-atomic loop (`relay.ts:284-296`) — absorb sds `ledger-api/outbox-publisher.ts:94-204`'s claim/settle isolation (kills head-of-line block); `attempts`/`last_error` columns already exist (schema-free).

**Migration:** rostering → extract to pull package unchanged (reference). soa relay → land both fixes in place. sds bespoke → **delete**, fold its isolation into soa, re-import (preserve the `pg_try_advisory_xact_lock` leader guard as a relay option). **Closes XREPO-6; de-risks coach CORR-1/2 + program-hub XREPO-4 + sds CORR-1.** **Effort:** soa fixes ~S; pull package extract ~S; sds fold-in ~M.

---

## WS-5 — Harden shared defaults + convergence guards (THEME-4, T5)

- **soa fail-open defaults → fail-closed** (T5): `ExpressServer` default CORS should default to the env-isolated allowlist, not `origin:true` (`api-core/express-server.ts`); `secret-helper` should throw on fetch failure, not coalesce to `{}` (`aws-util/secret-helper.ts:58-83`); config loader should reject empty-string as a satisfied required var. Removes the "safe only because everyone overrides" fragility. **~S.**
- **OIDC scoping (T4):** promote coach/qboard's scoped trust (`repo:<org>/<repo>:environment:prod`) into the `saga-iac` `github-oidc-role` reference; **fix SDS's silent prod wildcard**; close program-hub's tracked interim wildcard. **~S.**
- **Convergence CI guards** (the durable fix for drift): the WS-1 authz guard; a lint/contract-check that flags `cors({origin:true})` and re-introduced fail-open defaults. **~S.**

---

## WS-6 — Education-record retention/encryption (THEME-6, FERPA)

A fleet policy pass over stores holding student education records with weak
retention/encryption assertions: qboard recordings + transcripts (WS-3 bucket),
program-hub sessions-api free-text notes (cap + retention + at-rest encryption),
sds raw OLAP lake (expiration + pseudonymization at the boundary), rostering
audit-log quasi-identifiers, sds transcript redaction. Deliverable: a written
retention+encryption standard + per-store conformance. Pairs with **EXT-1**
(`iam_pii_db` backup/DR, out-of-scope repo) and **EXT-2** (recorder/rtsm), which
need owner sign-off. **Effort:** policy ~S; per-store ~S–M.

---

## Sequencing & critical path

```
Phase 0 (days, all parallel — unblock + make observable)
  WS-2 Phase-1 alarms ....... ships immediately (pure CFN)      → closes 4 S1s
  WS-3 point fixes .......... rate-limit, recordings bucket, secret → closes 2 S1s
  WS-5 soa fail-closed + OIDC template
  WS-1 step-0 ............... SagaAuthContext + soa-authz-core + base procedure  [blocks WS-1 rollout]

Phase 1 (the authz rollout — critical path)
  WS-1 adopt per service, most-exposed first (scheduling-api → SDS → iam-api → playback-api → coach)  → closes 7 S1s
  WS-4 outbox fixes (parallel; independent of WS-1)
  WS-1 CI guard (.meta convention) lands with first adopter

Phase 2 (durability + FERPA)
  WS-2 Phase-2 (metrics bridge + relay/DLQ alarms)
  WS-1 CI guard → ts-morph/authz-pins
  WS-6 retention/encryption pass + EXT-1/EXT-2 owner sign-off
```

**Critical path = WS-1** (7 of 13 S1s, and the dominant risk). Everything else
parallelizes around it. **WS-2 Phase-1 goes first regardless** — it's cheap and
it's what lets you *see* whether the other fixes work in prod.

## S1 traceability

| # | Repo · ID | Workstream | Phase |
|---|---|---|---|
| 1,2 | rostering SEC-1/2 | WS-1 | P1 |
| 3 | rostering OPS-1 | WS-3 | P0 |
| 4,5 | sds SEC-1/2 | WS-1 | P1 |
| 6 | sds OPS-1 | WS-2 | P0 |
| 7 | coach OPS-1 | WS-2 | P0 |
| 8 | qboard recording IDOR | WS-1 (+WS-3 auth migration) | P1 |
| 9 | qboard bucket | WS-3 (+WS-6) | P0 |
| 10 | qboard OPS-1 | WS-2 | P0 |
| 11 | program-hub SEC-1 | WS-1 | P1 |
| 12 | program-hub SEC-2 | WS-1 | P1 |
| 13 | program-hub OPS-1 | WS-2 | P0 |

## Open questions (need a decision before/within Phase 1)
1. **Tier-2 (OpenFGA) scope.** WS-1 delivers real per-request authz on the existing group→permission contract — sufficient to close every S1. Full OpenFGA relationship-based authz (coach + iam both have it gated off) is a larger separate initiative. **Decision: ship tier-1.5 for launch, schedule tier-2 post-launch?** (Recommended.)
2. **Pull vs push default.** Recommending pull as the canonical intra-fleet default. Any service that genuinely needs broker fan-out stays on the fixed push relay — confirm no service is blocked by making pull the default.
3. **500ms stability cutoff** (pull outbox) vs replication lag — the one real design weakness (`event.data.ts:20-26`); `txid_current()` watermark is the noted upgrade. In scope for the pull-package promotion or deferred?
4. **connectv3/qboard dev-only status.** Its recording S1s are weighted dev-only; if the launch plan promotes connectv3 to prod end-user, they harden to immediate. Confirm connectv3's launch status so WS-1 #4 / WS-3 bucket are prioritized correctly.
5. **EXT-1 / EXT-2 owners** (out-of-session repos) — who verifies `iam_pii_db` backup/DR and the recorder/rtsm posture?

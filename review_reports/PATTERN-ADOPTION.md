# Saga Fleet — Pattern Cohesion & Adoption Maturity

> Companion to `LAUNCH-REVIEW.md`. Re-cuts the same 199 findings by **shared
> practice** rather than by repo, to answer: *which conventions are converged vs.
> unevenly adopted across services?* Legend: ✅ good/adopted · ⚠️ partial ·
> ❌ absent/wrong · — n/a. "Ref impl" = an in-fleet example of the pattern done right.

_Derived from the 28-unit review, 2026-07-12. Read-only; no code changed._

## The meta-pattern

The fleet has **converged on the declarative / config-level patterns** (easy to
copy, enforced by a shared helper or a boot assert) but **diverged on the
behavioral patterns that require per-service engineering discipline** (authz,
reliable delivery, alerting). Several diverged patterns show the same hopeful
signature: **a correct reference implementation already exists in-fleet; it just
hasn't propagated.** So the gap is *distribution*, not *knowledge*.

| Convergence class | Patterns | Read |
|---|---|---|
| **Converged ✅** | CORS allowlist, perimeter prod-off invariant, secret sourcing (mostly), telemetry *emission*, compound-key/PII-isolation invariants | The shared-helper / boot-assert patterns stuck. |
| **Uniformly absent ❌** | alarming/paging (despite universal telemetry) | Nobody wired the last mile; systemic, not per-team. |
| **Diverging ⚠️** | per-request authz, transactional outbox, OIDC scoping, "service kit" meaning, bulk partial-failure | Ref impls exist; adoption 30–60%. Distribution problem. |

## Adoption matrix — behavioral patterns (the diverging ones)

### 1. Per-request authorization (server-side, beyond the perimeter) — ⚠️ DIVERGING (~40%)
| Service surface | State | Note |
|---|---|---|
| program-hub `sessions-api` | ✅ | **Ref impl** — `SessionsAuthzService`: pod-host + persona/permission + deactivated gate + NOT_FOUND masking |
| connectv3-api (qboard) | ✅ | Per-request membership re-check before route + AV token |
| coach CNS surface | ✅ | `authorizeUserAccess` (JWT `sub` vs `user_id`) |
| rostering PII-read path | ✅ | `iam:view_user_pii` + group-subtree scoping |
| coach reports / `transitionModuleState` | ❌ | IDOR — sibling has the check, these don't |
| qboard `playback-api` | ❌ | global-role only, no per-session ownership (recording IDOR) |
| rostering iam-api writes + admin | ❌ | S1 — zero per-user authz / fails open in prod |
| all SDS services | ❌ | S1 — `protectedProcedure` = bool `isAuthenticated` only |
| program-hub `scheduling-api` | ❌ | S1 — fully unauthenticated (all `publicProcedure`) |
| tier-2 (OpenFGA) | ❌ | gated off / not wired **everywhere** |

**Cohesion verdict:** worst-aligned pattern in the fleet, and the dominant launch
risk. No shared authz middleware; the perimeter (off in prod) is the only uniform
gate. Fix = propagate `SessionsAuthzService` + decide tier-2.

### 2. Transactional outbox / event delivery — ⚠️ DIVERGING (≥3 implementations)
| Impl | Guarantees | Used by |
|---|---|---|
| rostering own pull-based, id-ordered, idempotent | ✅ strongest — no soa exposure | rostering iam events |
| program-hub soa-relay + `source_ts` order-guard + DLQs | ⚠️ mitigated (no confirms; reconcile-by-CLI) | program-hub projections |
| sds `ledger-api` bespoke publisher | ⚠️ fixes HOL, **reproduces no-confirms** | sds analytics feed |
| soa `OutboxRelay` (baseline) | ❌ no confirms, unordered dispatch, HOL block | sds transcripts/insights/chat (unconsumed), coach |

**Cohesion verdict:** four behaviors from one nominal pattern. No canonical
reliable outbox; the `newConfirmChannel()` fix needs applying in ≥2 places
(XREPO-6). This is genuine fragmentation.

### 3. "Service kit" / shared scaffolding — ⚠️ DIVERGING (same name, different thing)
| Kit | What it actually provides |
|---|---|
| program-hub-service-kit | perimeter config + SagaAuth 401 emitter + error mapping — **no authz** |
| sds-service-kit | just an RDS-IAM migrate wrapper — **no auth at all** |
| qboard `iam-auth` (FORKED) | forked verifier; drift + committed `x-playwright-waf-bypass` bypass secret |
| coach | local JWKS verify, no kit |

**Cohesion verdict:** "service kit" is not a shared contract — each repo's kit
solves a different slice, and **none centralizes authz** (which is why pattern #1
diverged). The fork is active divergence with a security cost.

### 4. OIDC deploy-role trust scoping — ⚠️ IN TRANSITION
✅ scoped (target): coach, qboard (`repo:<org>/<repo>:environment:prod`) · ⚠️ documented interim wildcard: program-hub · ❌ silent prod wildcard: **sds** · dev-only wildcards (hygiene): janus, rostering. **Verdict:** target state exists and 2 repos hit it; the rest are mid-migration — converging but not there.

### 5. Bulk-first partial-failure handling — ⚠️ MIXED
✅ program-hub sessions-api (per-item `{error}`, `RESULT_TOO_LARGE` re-throw) · ❌ rostering (silent per-item drop path; positional result pairing). Ref impl exists; anti-pattern still present elsewhere.

## Adoption matrix — declarative patterns (the converged ones)

### 6. CORS allowlist (`buildSagaOriginAllowlist`, env-isolated) — ✅ CONVERGED (~90%)
Adopted: rostering, sds, coach (main GraphQL), qboard (both APIs), program-hub (all 4). Outliers: soa **default** is fail-open (reflects any origin+creds — safe only because everyone overrides); coach **tRPC mount** reintroduces `origin:true`. **Verdict: success story** — the good pattern is the norm; harden the soa default so a forgetful new service can't regress.

### 7. Perimeter prod-off invariant — ✅ CONVERGED (1 layer-mismatch outlier)
App-level `PERIMETER_ENABLED`/guard verified off-in-prod everywhere checked (soa boot-assert enforces it, not runtime-spoofable). Outlier: coach leaves **ALB-level** JumpCloud OIDC on in prod (OPS-3) — right invariant, wrong layer. **Verdict: strongest convergence in the review.**

### 8. Secret handling — ✅ MOSTLY CONVERGED
Strong: rostering (boot-time prod asserter), sds (salt from Secrets Manager, never logged), program-hub (RDS IAM-auth, no static DB secret). Outliers: soa `secret-helper` fails open to `{}`; qboard committed bypass secret (XREPO-7); coach prod `AUTH_SECRETNAME` unset. **Verdict: good norm, specific fixable outliers.**

### 9. Telemetry emission vs. alarming — ✅ emission / ❌ alarming (SPLIT)
Emission converged: Datadog/OTel/Prometheus widely wired; program-hub even emits DLQ-depth metrics. Alarming: **0/5 deployed repos** wire anything to a pager. **Verdict: the fleet converged on collecting signals and uniformly failed to act on them** — the cheapest, highest-leverage alignment fix (THEME-2).

### 10. FERPA data invariants — ✅ CONVERGED where they exist
SDS compound-key (all 14 sites), rostering PII isolation (separate encrypted DB), SDS secure-analytics (isolated CMKs, one-way writer) all verified sound. **Verdict:** the hardest correctness invariants hold — where a service owns student data it mostly guards it well; the gaps are at the *edges* (raw OLAP lake, unmanaged recording bucket, free-text notes — THEME-6) not the cores.

## So: how aligned is the fleet?

- **Declarative conventions are cohesive.** Anything a shared helper or boot-assert
  can enforce, the fleet adopted. That machinery works.
- **Behavioral conventions are fragmented**, and predictably so: they need each
  team to re-implement discipline, there's no shared enforcement, and the review
  found 30–60% adoption with a correct ref impl sitting unused in a sibling service.
- **The highest-value alignment moves** are therefore *distribution*, not invention:
  1. Extract `SessionsAuthzService` into a shared, **enforced** authz layer (closes pattern #1 — 7 S1s).
  2. Wire alarms fleet-wide off the telemetry that already exists (closes #9 — 4 S1s).
  3. Canonicalize one reliable outbox (`newConfirmChannel()` + order + reconcile) and retire the divergent copies (#2).
  4. Make the soa CORS/secret defaults fail *closed* so #6/#8 can't regress.
- A **contract-check / CI guard** for "does this service register a per-request
  authz check?" would convert pattern #1 from convention to enforcement — the same
  move that made CORS (#6) cohesive.

# Saga Launch Systems Review — Master Scorecard

> Cross-repo roll-up of the pre-launch systems review. Each repo keeps its own
> `review_reports/LEDGER.md` + per-dimension findings; this file is the single
> pane across all 7. Severity: **S1** launch-blocker · **S2** high · **S3** medium
> · **S4** low/nit. **Mode: review-only** (no code changed; remediation tracked
> separately). Branch: `claude/launch-systems-review-32z85n` in every repo.

_Last updated: 2026-07-12 — **ALL 7 REPOS COMPLETE** (warm-up + core + user-facing)._

## Coverage — 28 units (7 repos × 4 dimensions), all done

| Tier | Repo | SEC | DATA | CORR | OPS |
|---|---|---|---|---|---|
| warm-up | janus | ✅ | ✅ | ✅ | ✅ |
| core | soa | ✅ | ✅ | ✅ | ✅ |
| core | rostering | ✅ | ✅ | ✅ | ✅ |
| core | student-data-system | ✅ | ✅ | ✅ | ✅ |
| user-facing | coach | ✅ | ✅ | ✅ | ✅ |
| user-facing | qboard/connectv3 | ✅ | ✅ | ✅ | ✅ |
| user-facing | program-hub | ✅ | ✅ | ✅ | ✅ |

## Findings tally

| Repo | S1 | S2 | S3 | S4 | Total |
|---|---|---|---|---|---|
| janus | 0 | 2 | 14 | 12 | 28 |
| soa | 0 | 6 | 12 | 8 | 27 |
| rostering | 3 | 6 | 9 | 7 | 25 |
| student-data-system | 3 | 9 | 11 | 8 | 30 |
| coach | 1 | 9 | 12 | 8 | 30 |
| qboard/connectv3 | 4 | 7 | 16 | 6 | 33 |
| program-hub | 3 | 9 | 8 | 6 | 26 |
| **TOTAL** | **14** | **48** | **82** | **55** | **199** |

_S1: 14 findings = **13 distinct issues** (qboard's recording-IDOR + bucket each counted in two dimensions)._

## 🔴 Launch-blockers (S1) — 13 distinct

| # | Repo | ID | Blocker | Theme |
|---|---|---|---|---|
| 1 | rostering | SEC-1 | iam-api write surface (`user.*`,`groups.*`) — zero per-user authz; perimeter-only. | T1 |
| 2 | rostering | SEC-2 | iam-api admin surface fails OPEN in prod (null-claims `next()`, FGA `pass`). | T1 |
| 3 | rostering | OPS-1 | iam-api prod rate limit 100/min throttles normal S2S roster fan-out; silent. | — |
| 4 | sds | SEC-1 | fleet-wide no per-procedure authz (`protectedProcedure` = bool only). | T1 |
| 5 | sds | SEC-2 | ads-adm-api every procedure `publicProcedure`, trusts caller `authUserId`. | T1 |
| 6 | sds | OPS-1 | zero alarms fleet-wide; analytics pipeline stalls silently. | T2 |
| 7 | coach | OPS-1 | zero observability (no alarms/SNS/synthetics). | T2 |
| 8 | qboard | SEC-1/DATA-1 | playback-api recording IDOR — any tutor reads any student's session AV. | T1 |
| 9 | qboard | DATA-2/OPS-2 | student AV in unmanaged `saga-dev-temp-bucket`, no encryption/lifecycle in-tree. | — |
| 10 | qboard | OPS-1 | zero alarms. | T2 |
| 11 | program-hub | SEC-1 | scheduling-api fully unauthenticated (all `publicProcedure`, no authN). | T1 |
| 12 | program-hub | SEC-2 | spoofable `x-organization-id` → cross-tenant program access. | T1 |
| 13 | program-hub | OPS-1 | zero alarms. | T2 |

## Cross-cutting themes (the real story)

### THEME-1 — Inconsistent per-request authorization; the dev perimeter (off in prod) is the only uniform gate ⚠️ DOMINANT
**7 of 13 S1s.** Across the fleet, per-request authorization is applied
service-by-service with no shared standard. The **janus dev perimeter is the only
uniform gate, and it is (correctly) OFF in production** (soa/SEC-1 verified). Tier-2
(OpenFGA) is gated off everywhere. Where a service adds its own authz it's fine;
where it doesn't, the prod authorization floor is nothing. It is **not uniform even
within a repo**:
- **No/broken authz (S1):** rostering iam-api writes+admin, all SDS services, program-hub scheduling-api (fully unauthenticated), qboard playback-api (global-role only).
- **Real per-request authz (the reference implementations):** program-hub **`sessions-api` `SessionsAuthzService`** (pod-host + persona/permission + deactivated gate + NOT_FOUND masking), connectv3-api **session-join membership re-check**, coach **CNS `authorizeUserAccess`**, rostering **PII-read** path.
This is a **systemic policy gap, not a competence gap** — program-hub, the
strongest-engineered backend, still ships an unauthenticated scheduling-api.
**Highest-priority workstream.** The fix is a shared, enforced per-request authz
layer (propagate `SessionsAuthzService`-style checks) and/or wiring tier-2 —
before any service is exposed end-user-facing in prod.

### THEME-2 — No CloudWatch alarms / proactive alerting anywhere ⚠️ MOST UNIFORM
**4 S1s + present in every deployed repo (5/5 with backend infra; janus S2).** Telemetry
(Datadog/Prometheus/OTel) is often wired — program-hub even emits DLQ-depth metrics —
but **nothing is connected to an alarm/pager**. An auth outage, a throttled hotpath,
a stalled analytics/scheduling pipeline, or a filling DLQ is invisible until users
or a nightly job notice. Cheapest high-value fix in the review; also the prerequisite
that makes every other failure detectable.

### THEME-3 — Durable event-delivery gaps (no publisher confirms)
soa/CORR-1..3 (plain channel, no confirms → silent loss on broker failover;
unordered dispatch; batch head-of-line block). **Inheritance map:** rostering
**not exposed** (own pull-based ordered outbox); SDS ledger-api **reproduces**
the no-confirms gap independently (XREPO-6); coach **exposed** via async
projection (empty-content-at-launch CORR-1/2); program-hub **exposed** via
projection-backed session materialization (phantom/lost sessions). For
analytics + scheduling read-models, silent event loss = undetectable data gaps.
Fix soa's relay (`newConfirmChannel()`) **and** SDS's bespoke publisher together.

### THEME-4 — OIDC deploy-role trust scoping (uneven)
- **Silent prod wildcard (fix):** SDS (`repo:...:*` on the PROD deploy role, no rationale).
- **Documented interim prod wildcard (track to closure):** program-hub (explicit `INTERIM WILDCARD 2026-06-16` + end-state + compensating controls).
- **Dev-only wildcards (hygiene):** janus, rostering.
- **Correctly scoped (the target state):** coach, qboard (`repo:<org>/<repo>:environment:prod`).

### THEME-5 — Fail-open defaults in shared infra (soa)
soa `ExpressServer` default CORS reflects any origin + credentials; `secret-helper`
fails open to `{}`; config accepts empty-string as satisfied. Safe **only because**
consumers override (rostering/SDS/coach-main/qboard/program-hub all verified to
override CORS) — a new service that forgets inherits an unsafe default. Harden the
defaults themselves.

### THEME-6 — Student education records with weak retention/encryption assertions (NEW)
Beyond access control, several stores hold FERPA education records with no asserted
retention/erasure and unverifiable at-rest encryption: **qboard** session AV +
transcripts (unmanaged bucket, indefinite retention), **program-hub** sessions-api
free-text observation notes (no cap, hard-delete only), **SDS** raw OLAP lake
(un-pseudonymized identity, no expiration) + transcript best-effort redaction,
**rostering** audit-log quasi-identifiers (immutable, never purged). Needs a
fleet retention/encryption policy pass.

## Verified-sound (explicitly checked, no blocker)
- **Perimeter prod-off invariant** (XREPO-1) — guard throws on perimeter-ON in prod, not runtime-spoofable, fails closed. ✅
- **SDS compound-key invariant** — all ~14 `student_year_hash` sites use `HMAC(salt,"{school_year}:{stable_id}")`; dbt 64-hex deploy gate. ✅
- **rostering PII isolation** — separate encrypted `iam_pii_db`, blind indexes, no cross-DB joins, scoped PII reads. ✅
- **SDS secure-analytics FERPA posture** — isolated CMKs, one-way writer, 7yr Object-Lock. ✅
- **qboard CRDT engine** — CRDT-is-source-of-truth holds; offline merge + playback faithful; no convergence bug. ✅
- **connectv3-api session-join authz** — real per-request membership re-check + scoped AV tokens. ✅
- **program-hub DST/timezone math** — ratified DST policy verified against luxon runtime; TZ-independent expansion. ✅
- **rostering#774 preview-routing** — fixed. ✅ · **janus token/crypto core** — alg pinned, iss/aud/exp node+python. ✅
- **program-hub reliability primitives** — transactional outbox + order-guard, DLQs, circuit-breaker rollback, RDS IAM-auth. ✅

## Open cross-repo / external carry-overs
| ID | Owner | Item | Status |
|---|---|---|---|
| XREPO-6 | soa + sds | no-publisher-confirms gap in soa relay AND sds ledger-api; fix both (`newConfirmChannel()`). | ⏳ |
| XREPO-7 | qboard iam-auth fork | committed `x-playwright-waf-bypass` OAuth-bypass secret — rotate/remove; audit source. | ⏳ |
| EXT-1 | shared IaC repo (out of scope) | `iam_pii_db` backup/DR posture unverifiable here; explicit pre-launch check. | ⏳ |
| EXT-2 | fleek/rtsm fleets (out of scope) | recording bucket encryption/lifecycle, RTSM board-channel authz, transcription-postgres — verify. | ⏳ |

## Remediation priority (recommendation)
1. **THEME-1** — shared/enforced per-request authz (propagate the `SessionsAuthzService` reference impl; wire tier-2). 7 S1s. Largest, highest-risk; the thing that must be true before prod exposure.
2. **THEME-2** — alarms on every service (auth hotpath, pipelines, DLQ depth). 4 S1s, cheap, and it's what makes everything else detectable.
3. **rostering/OPS-1** rate limit — a 1-line prod override; silently breaks rosters otherwise.
4. **qboard recording exposure** (IDOR + unmanaged bucket) + **THEME-6** retention/encryption pass — student AV/FERPA.
5. **THEME-3/XREPO-6** publisher confirms — silent analytics/scheduling data loss.
6. **THEME-4** SDS prod OIDC wildcard; **THEME-5** soa fail-open defaults.
7. S2 data-exposure items (rostering audit PII + `getBulk`, sds raw-lake, coach reports, program-hub notes).

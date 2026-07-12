# Saga Launch Systems Review — Master Scorecard

> Cross-repo roll-up of the pre-launch systems review. Each repo keeps its own
> `review_reports/LEDGER.md` + per-dimension findings; this file is the single
> pane across them. Severity: **S1** launch-blocker · **S2** high · **S3** medium
> · **S4** low/nit. **Mode: review-only** (no code changed; remediation tracked
> separately). Branch: `claude/launch-systems-review-32z85n` in every repo.

_Last updated: 2026-07-12 — core-platform tier complete; user-facing tier pending._

## Coverage

| Tier | Repo | SEC | DATA | CORR | OPS | Status |
|---|---|---|---|---|---|---|
| warm-up | janus | ✅ | ✅ | ✅ | ✅ | done |
| core | soa | ✅ | ✅ | ✅ | ✅ | done |
| core | rostering | ✅ | ✅ | ✅ | ✅ | done |
| core | student-data-system | ✅ | ✅ | ✅ | ✅ | done |
| user-facing | coach | ⏳ | ⏳ | ⏳ | ⏳ | pending |
| user-facing | qboard/connectv3 | ⏳ | ⏳ | ⏳ | ⏳ | pending |
| user-facing | program-hub | ⏳ | ⏳ | ⏳ | ⏳ | pending |

## Findings tally (reviewed so far)

| Repo | S1 | S2 | S3 | S4 | Total |
|---|---|---|---|---|---|
| janus | 0 | 2 | 14 | 12 | 28 |
| soa | 0 | 6 | 12 | 8 | 27 |
| rostering | 3 | 6 | 9 | 7 | 25 |
| student-data-system | 3 | 9 | 11 | 8 | 30 |
| **TOTAL** | **6** | **23** | **46** | **35** | **110** |

## 🔴 Launch-blockers (S1) — 6

| # | Repo | ID | Blocker |
|---|---|---|---|
| 1 | rostering | SEC-1 | iam-api entire authenticated write surface (`user.*`, `groups.*`) has zero per-user permission checks; relies on the janus dev perimeter, which is OFF in prod. |
| 2 | rostering | SEC-2 | iam-api admin surface (personas/permissions/policies) fails OPEN in prod: `enforceIamAdmin` `next()`s on null janus claims; FGA `whenDisabled:'pass'`. |
| 3 | rostering | OPS-1 | iam-api prod per-IP rate limit forced to 100/min; normal S2S roster fan-out 429s under normal load; failures silent. |
| 4 | sds | SEC-1 | fleet-wide no per-procedure authz — `protectedProcedure` checks only boolean `isAuthenticated`; perimeter off → any/no session reads-writes all student data. |
| 5 | sds | SEC-2 | ads-adm-api exposes every procedure as `publicProcedure` incl. bulk attendance writes, trusting caller-supplied `authUserId`. |
| 6 | sds | OPS-1 | zero CloudWatch alarms fleet-wide; analytics pipeline can stall silently. |

## Cross-cutting themes (the real story)

### THEME-1 — Authorization depends on the dev perimeter, which is OFF in prod ⚠️ dominant
4 of 6 S1s. Both iam-api (rostering) and every SDS service authenticate behind
the **janus dev perimeter** and do little/no per-request authorization of their
own. The perimeter is (correctly — soa/SEC-1 verified) forked OFF in production.
Tier-2 enforcement (OpenFGA) is gated off; inner `authMiddleware` is a stub in
4/5 SDS services. **In dev everything looks gated (perimeter ON); at prod cutover
the authorization floor drops to nothing.** There is no shared auth kit to fix in
one place — each service copy-pastes the pattern. This is the single most
important pre-launch workstream. Related: janus/SEC-1 (session-fixation), the
coach saga_api→iam migration assumes tier-2 enforcement that isn't wired (XREPO-5).

### THEME-2 — No CloudWatch alarms / proactive alerting anywhere
janus (S2), rostering (S2, "zero alarms in infra/" grep-confirmed), sds (S1,
"zero as-code monitors"). Telemetry (Datadog) largely exists; **alerting does
not**. An auth outage or a stalled analytics pipeline is invisible until users
or a nightly parity job notice. Fleet-wide operational-readiness gap.

### THEME-3 — Durable event-delivery gaps (no publisher confirms)
soa/CORR-1..3 (relay uses plain channel, no confirms; unordered dispatch;
batch head-of-line block). Rostering is **not exposed** (own pull-based ordered
outbox). SDS is **split**: ledger-api's bespoke publisher fixes head-of-line but
**reproduces the no-confirms silent-loss gap** (sds/CORR-1) — so the same bug now
exists in two independent implementations (XREPO-6). For an analytics/assessment
store, silent event loss = undetectable data gaps.

### THEME-4 — Wildcard OIDC deploy-role trust
janus/OPS-9 (dev), rostering/OPS (dev wildcard branch), **sds/OPS-2 (PROD deploy
role trust wildcarded to `repo:...:*`** — any branch/PR can assume the prod
deploy role; the parity role already shows the correct scoped form). Tighten to
scoped `ref:` trust before launch; the prod one is the priority.

### THEME-5 — Fail-open defaults in shared infra
soa `ExpressServer` default CORS reflects any origin + credentials (downstream
must override — rostering & sds both correctly do); soa `secret-helper` fails open
to `{}`; soa config accepts empty-string as satisfied required var. Safe only
because consumers override; a new service that forgets inherits an unsafe default.

## Verified-sound (explicitly checked, no blocker)
- **Perimeter prod-off invariant** (XREPO-1) — janus→soa boundary; guard throws on perimeter-ON in prod, not runtime-spoofable, fails closed. ✅
- **SDS compound-key invariant** — all ~14 `student_year_hash` sites use `HMAC(salt,"{school_year}:{stable_id}")`; dbt 64-hex deploy gate. ✅
- **Rostering PII isolation** — separate `iam_pii_db`, AES-256-GCM + blind indexes, no cross-DB joins, permission+group-scoped PII reads. ✅
- **SDS secure-analytics FERPA posture** — isolated CMKs, one-way writer, 7yr Object-Lock, PII-read denies. ✅
- **rostering#774 preview-routing** — fixed; `PREVIEW_ORIGINATE_MAP` wired per sandbox. ✅
- **Token/crypto core** (janus) — alg pinned, iss/aud/exp enforced node+python, no claims-spoof escalation. ✅

## Open cross-repo / external carry-overs
| ID | Owner | Item | Status |
|---|---|---|---|
| XREPO-5 | coach | iam-api authz S1s directly affect the saga_api→iam migration (permission-driven UX assumes tier-2 enforcement not wired) — verify in coach slice. | ⏳ |
| XREPO-6 | soa + sds | no-publisher-confirms gap exists in soa relay AND sds ledger-api bespoke publisher; fix both together (`newConfirmChannel()`). | ⏳ |
| EXT-1 | shared IaC repo (out of session scope) | `iam_pii_db` backup/DR posture unverifiable here; needs explicit pre-launch check. | ⏳ |

## Remediation priority (recommendation)
1. **THEME-1** (authz floor at prod cutover) — 4 S1s; largest and highest-risk. Needs a real per-request authorization layer (or confirmed tier-2/OpenFGA wiring) before any prod exposure.
2. **rostering/OPS-1** rate limit + **THEME-2** alarms — cheap, high-value; without alarms you won't see the other failures.
3. **THEME-3/XREPO-6** publisher confirms — silent analytics data loss.
4. **sds/OPS-2** prod OIDC wildcard — small change, real exposure.
5. S2 data-exposure items (rostering audit-log PII, sds raw-lake, sds bulk PII S2S).

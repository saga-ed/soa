# 02 — Flow design: scheduling-topology (A/B `varies_by_day_type` → sessions)

> The concrete design for the second `flows.json` scenario. Builds on `01-understanding.md`
> (the oracle) and two code deep-dives (2026-07-02) that pinned every API signature, seed
> shape, and e2e pattern quoted below. Decisions locked by skelly in `HANDOFF.md`: approach
> (c) **purpose-built A/B seed, reveal reality**; first pattern **`varies_by_day_type`
> (weekday-driven)**. Parent: soa#214 · tracker: soa#221 (Flow content → new scenarios).
>
> **This doc is the review gate.** Get it reviewed before mass-authoring the seed + spec.

---

## 1. The scenario (one paragraph)

One program, one period, `rotationCount = 2`, `rotationPattern = varies_by_day_type`
(**weekday-driven** — rotations own weekdays, not day-types) on a **`SAME_EVERY_WEEK`
schedule**. **Rotation A** meets **Mon + Wed**, **Rotation B** meets **Fri**. Exactly one
pod (`podX`) is assigned to **both** rotations' slots, with a **different `treatmentKind`
per slot**: slot-A = `CONNECT` (tutored), slot-B = `NON_TUTORED`. Because sessions are a
read-time pure function of `(slot rrule) × (slot pod_assignment)`, the *same pod's* realized
session **switches treatment by weekday**: `CONNECT` on Mon/Wed, `NON_TUTORED` on Fri, with
no session Tue/Thu and exactly one card per pod per meeting day. This is the minimal true
A/B: one entity, two rotations, two treatments, switch is emergent.

Why the **weekday** variant and not the **day-type** variant: the day-type variant lives on
a `VARIES_BY_DAY_TYPE` *schedule*, which is exactly the path that emits **no recurring
`slot.created`** today (saga-dash#226, `scheduling-api/seed.ts:851`). The weekday variant
lives on a `SAME_EVERY_WEEK` schedule and is **rotation-managed** — each rotation's slot gets
a sub-RRULE restricted to its weekdays (`01 §3.2` rule 1). It sidesteps the name-fragile
day-type join and gives the cleanest deterministic oracle. `split_period` (intra-day) and
`custom` (date-map) remain explicit follow-ons.

---

## 2. The oracle table (the assertion truth)

Term dates are computed **relative to the run** so the flow never goes stale (mirror the
journey's `mondayOfCurrentWeek()`, `schedule.e2e.test.ts:37-53`). Let **M0 = Monday of the
current week = `TERM_START`**; term end = M0 + 6 weeks.

| Offset | Weekday | Rotation fires | Expected slot | `treatmentKind` (wire) | podX sessions |
|--------|---------|----------------|---------------|------------------------|:-------------:|
| **M0**   | Mon | **A** | `slotA` (rotationIndex 1) | **`CONNECT`**       | **1** |
| M0+1     | Tue | none  | —                         | —                   | **0** |
| **M0+2** | Wed | **A** | `slotA` (rotationIndex 1) | **`CONNECT`**       | **1** |
| M0+3     | Thu | none  | —                         | —                   | **0** |
| **M0+4** | Fri | **B** | `slotB` (rotationIndex 2) | **`NON_TUTORED`**   | **1** |

Global invariants across all five dates:
- **No pod renders > 1 card on any meeting day** (the saga-dash#226 duplicate-slot invariant:
  one active slot per `(period, rotation)`, `01 §4.2`).
- Every returned session's `date` equals the queried date; `status = NotStarted`;
  `viewerPermissionContextGroup = EMPTY_ORG_ID` (proof the authz grant resolved, not a mask —
  `sessions.e2e.test.ts:161-166`).
- `slotA` and `slotB` are **distinct** slot ids; `podX`'s session on Mon/Wed carries `slotA`,
  on Fri carries `slotB`.

**Topology assertions (DB projection tables, optional but high-value — `01 §6`):**
- `slot_projection`: exactly **2** rows for the period — `rotation_index` 1 and 2, with
  **distinct** rrules (A restricted to `BYDAY=MO,WE`, B to `BYDAY=FR`). This row is *the* A/B
  topology; if only 1 row (period-scoped) exists, the gap has bitten (see §6).
- `pod_assignment_projection`: **2** rows for `podX` — `(slotA → TUTORING)`,
  `(slotB → NON_TUTORED)` (**Prisma casing**: `TUTORING`, not `CONNECT`; `01 §9`).

---

## 3. Build sequence — API-built (recommended) vs direct-projection (fallback)

**Decision (Q3, recommended): API-built for the rotation emission→projection→read path.**
That path is exactly where the gap lives (`01 §5`), so driving it through the real APIs is
what "reveal reality" means. A **purpose-built seed fixture** handles only the *static
scaffolding* (org + program + period + pods + enrollments + authz grant + warmth); the
**spec** drives the *A/B-specific* mutations through live tRPC and asserts the reads. This
split keeps the seed deterministic and puts the mechanism-under-test on the real wire.

### 3a. Seed fixture (deterministic, `only: [scheduling-api, sessions-api]` + programs-api rides along)
Into the **Empty Org** (`deriveGroupId('emptyOrg') === EMPTY_ORG_ID ===
52a00136-285b-522c-bc70-0887cf46463a`), reusing the journey's actor precedent:
1. Program `P` + one period `per` (initially `no_rotation` — the spec flips it) + `podX`
   (and a second pod `podY` optional, to prove per-pod isolation) + ≥1 student enrollment per
   pod (SessionView asserts `participants.length ≥ 1`).
2. **The authz grant + warmth** — reuse `seedEmptyOrgAdminAuthz` (`sessions-api/seed.ts:710`,
   invoked at `:441`) which grants `DEV_ADMIN_PERMISSIONS` (incl.
   `sessions:lifecycle_non_hosted_sessions`) on the emptyOrg group, and the two
   `projectionReadiness.upsert({ warmedAt })` rows (`seed.ts:443-460`) — the read gate is
   `sessions-api.authz-projection` (`authz-projection.ts:20`); without warmth every read
   throws `SERVICE_UNAVAILABLE`. **Without the grant, `dayList` masks to 0** (false green).

### 3b. Spec setup — live tRPC (this is the path under test)
tRPC procedures pinned from code (`rpcGet` = query, `rpcPost` = mutation, both via
`page.request` carrying the `iam_session` cookie + `x-organization-id: EMPTY_ORG_ID` +
`...previewHeaders()`; `schedule.e2e.test.ts:97-105`):

1. **programs-api `periods.update`** → `{ id: perId, rotationPattern: 'varies_by_day_type',
   version }`. Version-guarded (`UpdatePeriodSchema` requires `version`; re-read via
   `periods.get` for the current version). Changing the pattern **auto-applies
   `DEFAULT_ROTATION_COUNT_FOR_PATTERN['VARIES_BY_DAY_TYPE'] = 2`**
   (`periods.service.ts:57-63`), so `rotationCount` becomes 2 without a separate call.
   (Belt-and-suspenders: `periods.setRotationCount(perId, 2)` is idempotent.)
2. **programs-api `periods.setRotationConfig`** →
   ```jsonc
   { "periodId": perId,
     "rotations": [
       { "rotationIndex": 1, "days": ["Monday", "Wednesday"] },
       { "rotationIndex": 2, "days": ["Friday"] } ],
     "calendarDays": [] }
   ```
   (`SetRotationConfigSchema`; `days` uses **capitalized** `WeekdaySchema`. No `treatmentKind`
   here — that is a PodAssignment, step 5.) Emits `programs.period_rotation_config.changed.v1`
   (full-state snapshot) → scheduling-api projects + **remints one slot per `(period,
   rotation)`**.
3. **scheduling-api `schedules.upsert`** →
   ```jsonc
   { "programId": P, "patternType": "SAME_EVERY_WEEK",
     "timezone": "America/New_York",
     "startDate": TERM_START, "endDate": TERM_END,
     "periodConfigs": [ { "periodId": perId, "colorKey": "blue",
       "activeDays": ["mon", "wed", "fri"], "startTime": "15:00", "endTime": "16:00" } ] }
   ```
   (`UpsertScheduleProcedureSchema`; `activeDays` uses **lowercase** `DayOfWeekSchema`.
   **Term dates mandatory** — without both, the slot stays a blank `rrule=''` placeholder
   that drives nothing, `01 §9`.)
4. **Poll `slots.list({ periodId })` until 2 real slots** (rrule/dtstart non-blank; mirror
   `listRealSlots`, `schedule.e2e.test.ts:108-111`), then capture `slotA` = the
   `rotationIndex 1` slot, `slotB` = `rotationIndex 2`. Assert A's rrule is restricted to
   Mon/Wed and B's to Fri (`BYDAY`). **This poll converging to 2 is the crux** (§6).
5. **programs-api `podAssignments.upsert`** (×2), gated on the slot existing in programs-api's
   local `slotProjection` mirror (poll):
   - `{ podId: podX, slotId: slotA, treatmentKind: 'CONNECT' }`
   - `{ podId: podX, slotId: slotB, treatmentKind: 'NON_TUTORED' }`
   (`UpsertPodAssignmentSchema`; wire enum `CONNECT | NON_TUTORED`. Poll
   `podAssignments.listForPod({ podId })` → 2, mirroring `schedule.e2e.test.ts:225-238`.)
6. **Assert via `sessions.dayList({ programIds: [P], date })`** for each oracle date (§4).

**Ordering note:** steps 2 and 3 are cross-service async (RabbitMQ). The remint is
future-only + `sourceTs`-guarded, and either interleaving converges; the **poll in step 4
absorbs the async** rather than relying on a fixed order. The exact interleaving (does
`setRotationConfig` before or after `schedules.upsert` matter for the first mint?) is the one
thing to nail empirically during authoring — see §6/§7.

### 3c. Fallback — direct-projection seed (only if the API path can't bootstrap)
If the live weekday-`varies_by_day_type` path won't mint 2 slot-scoped rules at all (a hard
gap, not just latency), fall back to a **direct-projection seed** that fabricates the target
end-state to isolate the *read engine*: two `slot_projection` rows (rotationIndex 1/2, rrules
`FREQ=WEEKLY;BYDAY=MO,WE` and `;BYDAY=FR`), matching `recurrence_rule_ref` rows (`ruleId =
slotId`, `slotId: null`), and two `pod_assignment_projection` rows (`podX→slotA=TUTORING`,
`podX→slotB=NON_TUTORED`) — the shape the current single-rotation seed *explicitly declines
to build* (`sessions-api/seed.ts:199`, the VARIES-modeling-gap comment). Green here + red on
the API path = **the read engine is correct and the gap is upstream in emission/projection**,
which is itself a precise, valuable finding. Prefer API-built; keep this in the back pocket.

---

## 4. Assertion surface + exact tRPC calls

All reads through **`sessions.dayList`** (input `{ programIds: [P], date }`; envelope keyed by
programId → `{ periods: PeriodGroup[], adhoc }`, flatten `periods.flatMap(p => p.sessions)` —
`sessions.e2e.test.ts:131-139`). Our spec's local `SessionView` type **must declare `slotId`
and `treatmentKind`** (the journey's local interface omits them, but they are real
`SessionViewSchema` fields — `slotId: string|null`, `treatmentKind` open-enum string).

Per meeting date (M0, M0+2, M0+4):
```
const s = dayListSessions(P, date).filter(x => x.podId === podX);
expect(s).toHaveLength(1);
expect(s[0].date).toBe(date);
expect(s[0].status).toBe('NotStarted');
expect(s[0].slotId).toBe(EXPECTED_SLOT[date]);          // slotA on Mon/Wed, slotB on Fri
expect(s[0].treatmentKind).toBe(EXPECTED_TREATMENT[date]); // CONNECT / NON_TUTORED  ← THE A/B assertion
expect(s[0].viewerPermissionContextGroup).toBe(EMPTY_ORG_ID);
```
Per non-meeting date (M0+1, M0+3): `expect(dayListSessions(P, date).filter(podX)).toHaveLength(0)`.

Global: across all sessions on any meeting day, `new Set(sessions.map(s => s.podId)).size ===
sessions.length` (no pod appears twice).

Optional **`rangeList`** cross-check (`{ programIds:[P], from: M0, to: M0+4 }`, ≤31-day cap):
`sessionsByDate` should have entries only for M0/M0+2/M0+4 with the right treatment each.

Optional **topology** (DB, via a Prisma client in the spec or a `db-*` helper): assert the 2
`slot_projection` + 2 `pod_assignment_projection` rows per §2.

**Warmth:** don't invent a readiness endpoint — the seed warms `sessions-api.authz-projection`
(§3a.2); the `expect.poll` on `dayList` itself (timeout 30_000) absorbs any residual
cold-read `SERVICE_UNAVAILABLE` retry, exactly as the journey polls the composed read rather
than a warmth flag.

---

## 5. The `flows.json` entry + spec location

Add to `~/dev/saga-dash/apps/web/dash/e2e/flows.json` — **which does not exist yet**; creating
it also advances the #221 "author real flows.json" item. Shape (validated against
`flowManifestSchema`; a present-but-invalid file is a hard error, a missing one is tolerated):
```jsonc
{ "schemaVersion": 1,
  "spa": { /* saga-dash descriptor — copy from examples/flows/saga-dash.flows.json */ },
  "flows": [
    { "name": "scheduling-topology",
      "description": "An A/B varies_by_day_type rotation realizes the right session (slot + treatment) per weekday.",
      "lanes": ["stack"],
      "progressive": false,
      "seed": { "reset": true, "profile": "roster" },
      "stages": [
        { "id": "topology", "phase": 1, "project": "scheduling-topology",
          "spec": "scheduling/topology-ab.e2e.test.ts",
          "requiredSystems": ["scheduling-api", "sessions-api", "programs-api"] } ] } ] }
```
Notes grounded in the flow model (`saga-stack-cli/src/core/flow/types.ts` + `examples/flows/README.md`):
- `spec` is repo-relative under `e2eDir` → physical path
  `~/dev/saga-dash/apps/web/dash/e2e/scheduling/topology-ab.e2e.test.ts` (new `scheduling/`
  sibling dir alongside `journey/`, `interactive/`).
- `project` = the Playwright project name; add a matching project to the saga-dash Playwright
  config (non-progressive → no `dependencies` chain, unlike journey stages).
- `requiredSystems` seeds the launch closure; `programs-api` rides along on `event` edges even
  if omitted, but list it explicitly (we drive `periods.*`/`podAssignments.*` on it).
- `seed.only` is available in the schema but the example backend flows rely on `profile` +
  closure to narrow which systems boot; the CLI sub-stack (`--only scheduling-api,sessions-api`)
  is applied at **stack-up** time, not in the flow's `seed` block.
- Until saga-dash authors its own `flows.json`, the CLI falls back to the **bundled example**
  (`examples/flows/saga-dash.flows.json`) via the `BUNDLED_EXAMPLE` registry row; the repo file
  takes precedence once present (the repo-file preference resolver is an M8 item — for this
  effort, running the repo file directly is fine).

---

## 6. Reveal plan — what's expected green vs what may go red (and why)

The oracle in §2 is the **intended** behavior. Per `01 §5`, no test proves it end-to-end
today, so treat these as the failure surfaces to watch. Each red **is the finding**; document
it verbatim into #221 / saga-dash#226.

| # | Assertion | Expected | Red would mean |
|---|-----------|:--------:|----------------|
| R1 | `slots.list` → **2** real slots, distinct rrules (§3b.4) | 🟢 if weekday-`varies_by_day_type` remints per-rotation slots | Only **1** period-scoped slot → weekday variant shares the #226 gap; rotation slots never mint. **The pivotal red.** |
| R2 | podX Mon/Wed → `CONNECT`, Fri → `NON_TUTORED` (§4) | 🟢 if R1 holds (treatment read verbatim from firing slot's pod_assignment) | If R1 red: one slot fires all 3 days → **same** treatment every day (no switch), or duplicate cards. |
| R3 | podX has **0** sessions Tue/Thu | 🟢 | A mis-minted period-scoped rule with `BYDAY=MO,WE,FR` (the M-W-F retraction footgun, `01 §3.4`) could still be correct here; the risk is the *inverse* — a rule not restricted to the rotation's weekdays. |
| R4 | No pod > 1 card per meeting day | 🟢 | Two rival slots firing the same day → duplicate cards (the saga-dash#226 invariant itself). |
| R5 | `treatmentKind` is the **wire** value `CONNECT` (§4) | 🟢 | If the read surfaced the Prisma `TUTORING`, the triple-enum boundary regressed. |

**Most likely outcome:** R1 is the hinge. If the weekday-driven `varies_by_day_type` path
mints 2 slot-scoped rules (plausible — it is the rotation-managed `SAME_EVERY_WEEK` path, not
the day-type-schedule path that #226 documents as broken), **the whole flow goes green and is
net-new proof** the A/B path works. If R1 is red, the flow has pinpointed that the weekday
rotation path shares the no-recurring-slot gap — a sharper, reproducible restatement of #226
than exists today. Either way the flow earns its keep.

---

## 7. Open questions for review (before authoring)

1. **Seed scaffolding mechanism.** §3a assumes a purpose-built fixture creates
   program/period/pods/enrollments into the Empty Org. Confirm: build that as a new seed entry
   in `sessions-api`/`scheduling-api` `seed.ts` (deterministic ids via `derive*`), or as a
   spec `beforeAll` that drives `programs.create`/`pods.create`/enrollment tRPC? Fixture is
   more deterministic; spec-driven exercises more of the real path. **Recommend fixture for
   scaffolding, live APIs for the A/B mechanism.**
2. **One pod or two?** `podX`-in-both-rotations is the minimal A/B. Adding `podY` in only
   rotation A proves per-pod isolation (podY has no Fri session) at low cost. **Recommend
   adding podY.**
3. **Assertion depth (Q4).** Ship v1 as count + treatment + slot per date (§4). Defer
   SWAP/ABSENT overrides, holidays/cancellations, and a schedule-edit re-projection check to a
   follow-on (they compound the reveal surface and aren't needed to prove the core switch).
4. **Interleaving of steps 2↔3** (setRotationConfig vs schedules.upsert first). Needs one
   empirical run to confirm which order first-mints the 2 slots; the §3b.4 poll makes the flow
   robust regardless, but document the observed order.
5. **`treatmentKind` default trap.** `podAssignments.upsert` with no `treatmentKind` defaults
   to `TUTORING`/`CONNECT` (`pod-assignments.service.ts:149`). We set it explicitly on both,
   so slot-B must **explicitly** send `NON_TUTORED` (omitting it would silently make B tutored
   too — a self-inflicted false green to guard against).

---

## 8. Deliverables checklist (feeds §221 "New flow #1")

- [ ] This design doc reviewed (gate).
- [ ] Purpose-built seed fixture: Empty-Org program + period + podX(+podY) + enrollments +
      authz grant + warmth (reuse `seedEmptyOrgAdminAuthz`).
- [ ] `saga-dash/apps/web/dash/e2e/flows.json` (created) + the `scheduling-topology` entry.
- [ ] Spec `saga-dash/apps/web/dash/e2e/scheduling/topology-ab.e2e.test.ts` (rpcGet/rpcPost +
      poll patterns from the journey; oracle from §2/§4).
- [ ] Playwright `scheduling-topology` project wired in the saga-dash config.
- [ ] Run report: `ss stack up --only scheduling-api,sessions-api` → `ss e2e run
      saga-dash/scheduling-topology`; capture green/red per §6 → back to #221 / saga-dash#226.

## References
`01-understanding.md` (oracle) · `HANDOFF.md` (locked decisions). Code (all quoted from the
two 2026-07-02 deep-dives): programs-api `periods.router.ts:15/45/86/100`,
`periods.service.ts:57-63/123/195-222/423`, `pod-assignments.router.ts:36`,
`pod-assignments.service.ts:34-40/149`; scheduling-api `schedules.router.ts:16`,
`seed.ts:851-890`; sessions-api `sessions.router.ts:62`, `sessions-read.service.ts:310`,
`authz-projection.ts:20`, `projection-readiness.service.ts`, `seed.ts:199/441-460/710`;
program-hub-types `periods.ts:32-107`, `scheduling.ts:185-262`, `pod-assignments.ts:25`,
`sessions.ts:17/131-206/346-350/455-460`; saga-dash `journey/schedule.e2e.test.ts`,
`journey/sessions.e2e.test.ts`, `data/roster-reset.ts:35`, `data/seed-users.ts:54`; flow model
`saga-stack-cli/src/core/flow/types.ts:50-150`, `examples/flows/{saga-dash,connectv3}.flows.json`,
`examples/flows/README.md`.

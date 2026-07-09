# 02b — split_period flow design (intra-day A/B → sessions)

> Sibling of `02-flow-design.md` (the weekday `varies_by_day_type` oracle). This is the
> **third** `flows.json` scenario for saga-stack-cli: the **`split_period`** topology — an
> A/B switch that is **intra-day** (both rotations meet the same date, each owning half the
> period's time window). Author-first process (per the AB precedent): pin the oracle here,
> **get it reviewed**, then author the spec.
>
> Tracker: soa **#221** ("New flow #2"). Parent: soa **#214**. saga-dash impl branch:
> `flow/scheduling-topology-split`.

## 0. TL;DR — this one is GREEN, not a reveal-reality bet

Unlike the weekday case (which was a "reveal reality / red-until-fixed" bet against the
VARIES modeling gap), **`split_period` intra-day time-window splitting is fully implemented
today**:

- `scheduling-api/src/services/rotation-slot-time.ts` — `splitWindow(start, end, timeSlot)`
  computes the half-window (floored midpoint) for `'First Half of Period'` /
  `'Second Half of Period'`.
- `scheduling-api/src/services/schedules.service.ts:605` — the dedicated `split_period`
  branch mints **one slot per rotation on the SAME full RRULE**, each carrying its half
  window (contrast the weekday branch at :593, which restricts each rotation's RRULE to its
  own weekdays and keeps the full window).
- Existing unit proof: `scheduling-api/.../schedules.service.test.ts:663` — "SPLIT_PERIOD:
  two slots on the full RRULE, each with its own time window" (period 10:00–11:00 →
  10:00–10:30 / 10:30–11:00, both `BYDAY=MO`).

So this flow **locks in working behavior against regression**. It is a self-seeding clone of
the AB spec with three deliberate oracle changes (§4).

## 0b. TWO AXES — the naming trap, and where the real gap is

`varies_by_day_type` names a value on **two independent axes**. Conflating them hides the gap:

| Axis | Values |
|---|---|
| **Schedule**-level `patternType` | `SAME_EVERY_WEEK` \| `VARIES_BY_DAY_TYPE` ← the "rotating **block** schedule" |
| **Period**-level `rotationPattern` | `no_rotation` \| `varies_by_day_type` \| `split_period` \| `custom` |

Coverage of the 2×4 matrix as of 2026-07-08:

| | SAME_EVERY_WEEK | VARIES_BY_DAY_TYPE |
|---|---|---|
| `varies_by_day_type` rotation | ✅ `topology-ab` | ❌ none |
| `split_period` rotation | ✅ `topology-split` (2a, this doc) | ❌ **`topology-split-daytype` (2b — THE TARGET)** |
| `no_rotation` / `custom` | journey / ❌ | ❌ |

**No e2e anywhere exercises a `VARIES_BY_DAY_TYPE` *schedule*.** `topology-ab` is a
SAME_EVERY_WEEK schedule with a weekday *rotation*; the journey is SAME_EVERY_WEEK. The
block-schedule column is entirely uncovered.

That column is also where the bug history lives — `programs-projection.ts`:
> "Without the split case here, a split period on a day-type schedule fell through to the
> period-keyed branch below, matched zero dates, minted zero slots, and produced **NO
> sessions at all**."

And it is **exactly what Jenny manually validated** (2026-07-08 eng sync): *"I could build out
an A/B rotating **block** schedule with **split periods**. The sessions appeared as I would
expect."* — which Sean asked to capture as an e2e ("capture the shape of the test that you ran
manually"). So **2b is the deliverable Sean's "complex scheduling topologies" concern points
at**; 2a is its isolation baseline.

## 1. Scope (locked)

**Two specs, both the 3-pod package** (`Split_period_topologies.md` Cases 1–3):

- **2a — `topology-split`** (SAME_EVERY_WEEK × `split_period`). The **isolation baseline**:
  proves `splitWindow` with the day-type variable held out, so when 2b reds you know which
  axis broke. §2–§7 below.
- **2b — `topology-split-daytype`** (VARIES_BY_DAY_TYPE × `split_period`). **The target** —
  Jenny's manual scenario, zero prior coverage, historically the zero-slot path. §10 below.

Deferred: uneven window / floored-midpoint (Case 4), schedule-edit remint (Case 7), one-half
cancel / per-date swap (Cases 8/9), and `custom` (date-map).

## 2. The oracle

**Scenario.** One program, one period, `rotationPattern = split_period`, `rotationCount = 2`,
schedule Mon/Wed/Fri, period window **15:00–16:00**.

- **Rotation 1** = `timeSlot: 'First Half of Period'` → **slotA**, window **15:00–15:30**.
- **Rotation 2** = `timeSlot: 'Second Half of Period'` → **slotB**, window **15:30–16:00**.
- Midpoint = `15:00 + floor((60)/2) = 15:30` (even → clean halves).

**Pods** (treatment is a property of the pod's assignment to a slot, NOT the rotation config):

| Pod  | slotA (first half) | slotB (second half) |
|------|--------------------|---------------------|
| podX | CONNECT            | NON_TUTORED         |
| podY | CONNECT            | —                   |
| podZ | —                  | NON_TUTORED         |

**Dates** — `M0 = next Monday STRICTLY after today = TERM_START`; term = M0 .. M0+6wks
(future-only, mirroring AB: the remint path is future-only). Per meeting day
(Mon M0, Wed M0+2, Fri M0+4):

| Pod  | first half (slotA, 15:00–15:30) | second half (slotB, 15:30–16:00) | sessions/day |
|------|----------------------------------|-----------------------------------|:------------:|
| podX | CONNECT                          | NON_TUTORED                       | **2** |
| podY | CONNECT                          | —                                 | 1 |
| podZ | —                                | NON_TUTORED                       | 1 |

- Tue (M0+1) / Thu (M0+3): **0** sessions for all pods.
- podX's two sessions have **distinct `slotId`** (→ distinct session ids, since identity is
  `(date, periodId, slotId, podId)` — `session-composition/src/session-id-v2.ts`) and
  distinct `intendedStart`/`intendedEnd`.
- All sessions group under the **`periods` bucket** (bucketed by period membership, #317),
  one period group; every session `status = NotStarted`,
  `viewerPermissionContextGroup = EMPTY_ORG_ID`.

## 3. Build sequence (API-built, self-seeding; no seed.ts)

Same framing as `02` §3: `ss` has no per-flow seed; stock `profile: 'roster'` supplies the
empty-admin authz grant + `projection_readiness` warmth, and the spec self-seeds via live
tRPC into the Empty Org (`x-organization-id: EMPTY_ORG_ID`). Actor = empty admin
(`useUser('empty')`). Ordered calls (base URL in parens):

1. `programs.create { name }` → programId  *(programs-api)*
2. `periods.create { programId, name, rotationPattern: 'split_period' }` → periodId
   *(programs-api; auto-sets `rotationCount = 2` via
   `DEFAULT_ROTATION_COUNT_FOR_PATTERN.SPLIT_PERIOD`, periods.service.ts:60)*
3. `periods.setRotationCount { id: periodId, rotationCount: 2 }` *(idempotent belt-and-suspenders)*
4. `pods.create` ×3 → podX, podY, podZ
5. `schedules.upsert` *(scheduling-api)*:
   ```jsonc
   { "programId", "patternType": "SAME_EVERY_WEEK", "timezone": "America/New_York",
     "startDate": TERM_START, "endDate": TERM_END,
     "periodConfigs": [ { "periodId", "colorKey": "blue",
       "activeDays": ["mon","wed","fri"], "startTime": "15:00", "endTime": "16:00" } ] }
   ```
6. `periods.setRotationConfig` *(programs-api)*:
   ```jsonc
   { "periodId",
     "rotations": [
       { "rotationIndex": 1, "timeSlot": "First Half of Period" },
       { "rotationIndex": 2, "timeSlot": "Second Half of Period" } ],
     "calendarDays": [] }
   ```
   `days`/`dayTypes`/`mergedFrom` default to `[]` (`RotationConfigSchema`,
   program-hub-types/src/periods.ts). `timeSlot` is a **strict enum** at the tRPC boundary
   (`TimeSlotSchema`: `'First Half of Period' | 'Second Half of Period' | 'Full Period'`), so a
   typo is **rejected**, not silently collapsed to a full window. `timeSlot` must be unique
   across rotations (periods.service.ts) — you cannot give both the same half.
7. Poll `slots.list({ periodId })` → filter real slots (`dtstart !== ''`) → **2**. Capture
   slotA (`rotationIndex 1`), slotB (`rotationIndex 2`). Assert
   `slotA.startTime==='15:00' && slotA.endTime==='15:30'`, `slotB.startTime==='15:30' &&
   slotB.endTime==='16:00'`.
8. `podAssignments.upsert` ×4 (via the SLOT_NOT_PROJECTED retry wrapper) — **treatmentKind
   EXPLICIT on every one**: podX→slotA CONNECT, podX→slotB NON_TUTORED, podY→slotA CONNECT,
   podZ→slotB NON_TUTORED.
9. Poll `podAssignments.listForPod({ podId: podX })` → 2.
10. Assert `sessions.dayList({ programIds:[programId], date })` per oracle date (§2).

## 4. What changes vs the weekday case (the 3 oracle divergences)

1. **Switch axis = time-of-day, not weekday.** Both rotations fire the same MWF; the
   discriminator is the slot's half-window (`intendedStart`/`intendedEnd`) + `slotId`, not
   which weekday fired. Config carries `timeSlot`, not `days`.
2. **The "one card per pod per meeting day" invariant INVERTS for podX.** A pod in both
   rotations legitimately gets **2 cards/day** (distinct slotId/window). The v1 global check
   becomes: podX == 2 (distinct slotIds), podY == 1, podZ == 1 per meeting day.
3. **Assert the realized time window.** The weekday spec never needed session times.
   Split's proof of `splitWindow` end-to-end is `SessionView.intendedStart` /
   `intendedEnd` (`'HH:MM'`, program-hub-types/src/sessions.ts). This is the marquee
   assertion.

## 5. Assertion surface

All realized-session reads via `sessions.dayList` (`periods` bucket; union `adhoc`
defensively). Per meeting day:

- `podX` sessions length **2**, distinct `slotId`; the slotA one = `{ treatmentKind:
  'CONNECT', intendedStart: '15:00', intendedEnd: '15:30' }`, the slotB one = `{ 'NON_TUTORED',
  '15:30', '16:00' }`.
- `podY` length 1 → slotA / CONNECT / first-half window. `podZ` length 1 → slotB /
  NON_TUTORED / second-half window.
- Every session: `date === queried`, `status === 'NotStarted'`,
  `viewerPermissionContextGroup === EMPTY_ORG_ID`.
- Non-meeting days (Tue/Thu): length 0 for all pods.

Topology (optional, high-value): `slots.list` → 2 real slots, distinct ids, windows
`[15:00,15:30]` / `[15:30,16:00]`.

## 6. Carry-forward facts (don't re-hypothesize — learned in the AB run, `03-run-results.md`)

- **Mint shape (RRULE vs ANCHOR):** accept BOTH. Key "real slot" on `dtstart !== ''`; assert
  the **window** (`startTime`/`endTime`), NOT rrule text. The SAME_EVERY_WEEK split-upsert
  path emits RRULE-shape (full `BYDAY=MO,WE,FR` + half window); a config-after-schedule
  interleaving can remint ANCHOR-shape. Both compose the same realized sessions.
- **Bucket = `periods`** (post-#317, by period membership). A rotation session in `adhoc` is a
  regression.
- **Remint race = FIXED (#316):** single `setRotationConfig`, poll to 2 slots. No re-apply loop.
- **Projection lag = TYPED (#320):** retry ONLY `SLOT_NOT_PROJECTED:` 409s on
  `podAssignments.upsert`; generic NOT_FOUND is terminal.

## 7. Traps specific to split (from source)

- **treatmentKind default trap** — omitting `treatmentKind` on `podAssignments.upsert`
  defaults to CONNECT/TUTORING (`pod-assignments.service.ts`); slotB/podZ MUST send
  `NON_TUTORED` explicitly or the second-half assertions false-green.
- **Duration is NOT halved (D24, schedules.service.ts:607):** `intendedDurationMinutes`
  carries the whole per-slot value even though the window is a half. Assert the **window**
  (`intendedStart`/`intendedEnd`), never `intendedDurationMinutes === 15`.
- **Stay on SAME_EVERY_WEEK** — `split_period` × VARIES_BY_DAY_TYPE is the special-cased
  path (`programs-projection.ts` ~:656; without the split case it minted zero slots). That's
  Case 10, a deliberate follow-on.

## 8. Deliverables

1. This doc (`02b-split-flow-design.md`) — **reviewed before authoring**.
2. `saga-dash/apps/web/dash/e2e/scheduling/topology-split.e2e.test.ts` — clone of
   `topology-ab.e2e.test.ts` with the §2 oracle and §4 divergences.
3. `saga-dash/.../e2e/flows.json` — a `scheduling-topology-split` flow entry.
4. `saga-dash/.../playwright.stack.config.ts` — a `scheduling-topology-split` project.
5. Run report (post-pairing): `03b-split-run-results.md` — pass/fail + any divergence.

## 9. Reveal plan (what should be green)

Everything. Engine + read path are implemented and unit-proven. The only realistic reds are
environmental (stack not warm → poll timeout) or a genuine regression in one of the four
carry-forward fixes (#316/#317/#320/D24). If slots.list stalls at 1, suspect #316; if
dayList sees 0 while slots exist, suspect #317 (bucket) or warmth.

---

# 10. Flow 2b — `topology-split-daytype` (VARIES_BY_DAY_TYPE × split_period) — **THE TARGET**

Jenny's manual scenario. Same period, same 3 pods, same split rotations — but the schedule is
a **block calendar** (A Day / B Day painted onto dates), and each day type carries its **own
block window** for the period. The split halves *that* window, per painted date.

## 10.1 Scenario

- Schedule: `patternType: 'VARIES_BY_DAY_TYPE'`, term M0..M0+6wks.
- **Day types**, each with a block for our period (deliberately DIFFERENT windows — that is
  the whole point):
  - **A Day** — block **09:00–10:00**, painted weekly on **Mon, Wed**.
  - **B Day** — block **13:00–14:00**, painted weekly on **Fri**.
- Period `rotationPattern: split_period`, `rotationCount: 2`; rotation 1 = `First Half of
  Period` (slotA), rotation 2 = `Second Half of Period` (slotB).
- Pods: podX→slotA CONNECT + slotB NON_TUTORED; podY→slotA CONNECT; podZ→slotB NON_TUTORED.

## 10.2 The oracle — **the same slot fires at different windows on different dates**

| Date | Day type | Block | podX slotA (CONNECT) | podX slotB (NON_TUTORED) | podY | podZ |
|---|---|---|---|---|---|---|
| Mon (M0)   | A Day | 09:00–10:00 | **09:00–09:30** | **09:30–10:00** | 09:00–09:30 | 09:30–10:00 |
| Tue (M0+1) | — (unpainted) | — | 0 sessions | 0 | 0 | 0 |
| Wed (M0+2) | A Day | 09:00–10:00 | **09:00–09:30** | **09:30–10:00** | 09:00–09:30 | 09:30–10:00 |
| Thu (M0+3) | — (unpainted) | — | 0 sessions | 0 | 0 | 0 |
| Fri (M0+4) | B Day | 13:00–14:00 | **13:00–13:30** | **13:30–14:00** | 13:00–13:30 | 13:30–14:00 |

`slotA` is ONE slot that realizes 09:00–09:30 on Mon/Wed and 13:00–13:30 on Fri. This is the
assertion no other spec can make, and it is the proof that the per-date
`occurrence_time_override` — not the slot row — drives realization.

**Both rotations meet on EVERY painted date, regardless of day-type name.** The split branch
gates on `config.some(r => r.timeSlot != null)` and bypasses `resolveRotationIndices`
entirely (which routes by day-type *name*). A/B naming is decoration; the halving is the
behavior. `topology-ab`'s name-routing does NOT apply here.

## 10.3 Build sequence (deltas from §3)

Steps 1–4 (program, period `split_period`, setRotationCount, 3 pods) and 8–10 (assignments,
assert) are **identical**. Two changes:

- **Order flips: `setRotationConfig` BEFORE `schedules.upsert`.** The upsert's split branch
  reads scheduling-api's projected rotation config (`loadRotationContext`); if `timeSlot` is
  not yet visible it falls through to the rotation-1 name-fallback at the FULL window. The
  reactive remint (`remintPeriodFutureSlots`, same split branch) self-heals either order
  (#316 advisory lock), so the poll to 2 slots still converges — but config-first exercises
  the path Jenny's UI actually drives.
- **`schedules.upsert` swaps `periodConfigs` for `dayTypes` + `placements`:**
  ```jsonc
  { "programId", "patternType": "VARIES_BY_DAY_TYPE", "timezone": "America/New_York",
    "startDate": TERM_START, "endDate": TERM_END,
    "dayTypes": [
      { "id": "a-day", "name": "A Day", "colorKey": "blue",
        "blocks": [ { "periodId", "startTime": "09:00", "endTime": "10:00" } ] },
      { "id": "b-day", "name": "B Day", "colorKey": "green",
        "blocks": [ { "periodId", "startTime": "13:00", "endTime": "14:00" } ] } ],
    "placements": [
      { "dayTypeId": "a-day", "date": TERM_START, "recurring": true,
        "recurrenceFrequency": "week", "recurrenceDays": ["mon","wed"],
        "recurrenceEndDate": TERM_END },
      { "dayTypeId": "b-day", "date": FRI_OF_M0, "recurring": true,
        "recurrenceFrequency": "week", "recurrenceDays": ["fri"],
        "recurrenceEndDate": TERM_END } ] }
  ```

### Traps (source-verified)
- **`placements[].dayTypeId` MUST be the client TEMP id** (`"a-day"`), not a real uuid.
  `createVariesByDayType` does `dayTypeByTempId.get(placement.dayTypeId)` and `continue`s on a
  miss — a real id silently emits **zero** occurrences (green-looking build, empty dayList).
- `recurrenceDays` is **lowercase** `DayOfWeekSchema` (`'mon'`); `recurrenceFrequency` is
  **`'week' | 'month'`** (NOT `'WEEKLY'`). `placementToRRule` returns `null` (→ silent
  `continue`) if `recurring` is false or `recurrenceDays` is empty.
- **`recurrenceEndDate` matters**: omitting it yields an open-ended rule expanded to a 2-year
  default horizon (`DEFAULT_HORIZON_YEARS`) — thousands of CalendarEvent rows. Always bound it.
- **`placement.date` must itself fall on a painted weekday** (it is the rrule `dtstart`).

## 10.4 Assertion surface (deltas from §5)

- **DO NOT assert `slot.startTime`/`slot.endTime`.** `ensureDayTypeRotationSlot` is keyed
  `periodId#rotationIndex` and **creates once**, so the slot row carries whichever painted
  date was processed first (A-Day's 09:00–09:30 here). It is a *nominal* window, not the
  oracle. Assert only that 2 real slots exist (`dtstart !== ''`, `rrule === ''` — ANCHOR shape
  is guaranteed on this path) with distinct ids and rotationIndex 1/2.
- **Assert `SessionView.intendedStart`/`intendedEnd` PER DATE** against the day type's halved
  block window (table §10.2). This is the marquee assertion.
- Per-pod counts per painted date: podX == 2 (distinct slotId), podY == 1 (slotA), podZ == 1
  (slotB). Unpainted Tue/Thu: 0 for all.
- Bucket: `periods` (#317), same as 2a.

## 10.5 Reveal plan

Expected green — both the upsert split branch and the remint split branch are implemented and
unit-covered (`programs-projection.test.ts` day-type split case). The reds that would matter:

| Symptom | Means |
|---|---|
| `slots.list` → 1 real slot at the FULL block window | the split branch's `timeSlot` gate missed → the historical zero-slot/full-window regression |
| 0 sessions on painted dates | placements never fanned out (temp-id trap) OR the day-type zero-slot regression |
| `intendedStart` = 09:00 on **Friday** | per-date `occurrence_time_override` not applied — sessions riding the slot's nominal window instead |
| podX has 1 session/painted date | `resolveRotationIndices` name-routing leaked in — split should route BOTH rotations to every date |

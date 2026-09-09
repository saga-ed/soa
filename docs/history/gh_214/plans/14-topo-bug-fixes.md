# Plan 14 — fix the two scheduling-topology findings (program-hub#316, #317)

Both bugs were surfaced by the `scheduling-topology` e2e flow (soa#221) and are
currently masked by test-side workarounds in `topology-ab.e2e.test.ts`. The
acceptance bar for this plan is therefore concrete: **fix the services, then
delete the workarounds and the flow stays green** — the flow becomes the
regression harness for both.

Repo: `program-hub` (both fixes). One branch, two commits (or two small PRs if
review prefers — they're independent).

---

## Fix 1 — #316: rotation-remint silently skipped on Schedule invisibility

**Site:** `apps/node/scheduling-api/src/event-handlers/programs-projection.ts:316`
(`if (scheduleRow.rows.length === 0) return;` inside the rotation-config
consumer's txn).

**Why it's wedged forever:** the idempotency guard at `:300` means a redelivery
of the same config applies nothing and returns before the remint — so once the
skip happens, no retry of the SAME event can heal it. Only a fresh
`setRotationConfig` (bumped `source_ts`) re-runs the remint. Silent + stable.

### Chosen approach: reciprocal trigger (primary) + loud skip (secondary)

**1a. Reciprocal trigger — the invariant fix.** The pair (Schedule row,
rotation-managed config) can land in either order; today only the config side
triggers the remint. Add the mirror: in the **schedule-upsert consumer** (same
file, the handler that projects the Schedule row), after a Schedule INSERT
(first visibility — not every update), query for existing rotation-managed
period configs for the program:

```sql
SELECT "periodId", rotations, "calendarDays", rotation_pattern
FROM <period-config projection> WHERE "programId" = $1
  AND rotation_pattern = ANY(ROTATION_MANAGED_PATTERNS)
```

and run `remintPeriodFutureSlots` for each, **in the same txn** as the schedule
projection (identical atomicity argument to the existing comment block at
`:302-309`). Whichever dependency lands second now completes the pair.

- Idempotency: remint after a skip mints from zero live slots → clean; if the
  config side DID remint already (no race this time), the schedule INSERT path
  doesn't fire again for updates, so no double-mint. Guard the trigger with
  "INSERT (or first-visible upsert), not UPDATE" — same `xmax = 0` /
  rows-affected discrimination the file already uses for the config upsert.

**1b. Loud skip — defense in depth.** At `:316`, when the config upsert
**applied** (`upserted.rows.length > 0`) but the Schedule row is absent, this
is no longer "nothing to do" — with 1a it should be transiently impossible, so
log at WARN with programId/periodId (`remint deferred: schedule not yet
visible — reciprocal trigger will complete it`). Do NOT nack/retry (1a makes
retry unnecessary, and nacking inside a multi-event projection consumer risks
redelivery storms — keep the consumer linear).

### Tests (scheduling-api)

- Unit/integration on the projection handler (existing harness in
  `__tests__` next to the consumer): (i) config lands BEFORE schedule →
  schedule-INSERT path remints (slots appear); (ii) schedule before config →
  existing path unchanged (pin it); (iii) schedule UPDATE does not re-mint;
  (iv) the WARN fires when config applies with no schedule.
- The lost-update companion (`schedules.upsert` after `setRotationConfig`,
  run-2 finding) becomes a regression test: either order converges to 2 slots.

### E2E acceptance

Remove the spec's re-apply workaround (`setRotationConfig`-until-2-slots loop)
from `topology-ab.e2e.test.ts`; run the flow 3× on slot 1 (the race is timing-
dependent — repetition is the point): green every time, single `setRotationConfig`.

**Risk:** M — touches an event consumer's transactional behavior; the mint path
itself (`remintPeriodFutureSlots`) is unchanged and already proven. Bounded by
the INSERT-only trigger condition.

---

## Fix 2 — #317: dayList buckets by origin, not period membership

**Site:** `apps/node/sessions-api/src/sectors/sessions/sessions-read.service.ts`
→ `groupIntoDayEntry`: `if (decorated.origin === 'manual_addition') → adhoc`.

Rotation-minted sessions are `manual_addition` **by design** (anchor-slot
occurrences) and carry a real `periodId` → they vanish from periods-only
readers despite correct realization.

### Chosen approach: classify by period membership

```ts
const isPeriodScoped = decorated.periodId !== undefined
  && periodMeta.has(decorated.periodId);      // membership in model.candidateTuples
if (!isPeriodScoped) { adhoc.push(decorated); continue; }
// else: group under its period — origin no longer consulted for bucketing
```

- `periodMeta` (built from `model.candidateTuples`) is already in scope — the
  membership test is a Map lookup, no new reads.
- **Open verification (do FIRST):** confirm true ad-hoc sessions
  (`adhoc.create` → `sessions-adhoc.service.ts`, `origin: 'manual_addition'`)
  either carry NO `periodId` or one outside `candidateTuples`. If they can
  carry a member `periodId`, the discriminator needs a second term (e.g. the
  synthetic-slot marker adhoc.create stamps) — resolve before coding.
- Keep `origin` on the view payload untouched (consumers may render a badge);
  only the BUCKETING changes.

### Tests (sessions-api)

- Extend `sessions-adhoc.unit.spec.test.ts` / the read-service unit suite:
  (i) rotation-minted session (manual_addition + member periodId) → its period
  group; (ii) true adhoc session → adhoc bucket (pin the discriminator);
  (iii) session with unknown periodId → adhoc (no crash, no phantom group).
- Contract note: this is a **wire-shape behavior change** for dayList — sweep
  saga-dash consumers reading `adhoc` (the #226 surfaces) to confirm none
  DEPEND on rotation sessions appearing there; the e2e spec's `dayListSessions`
  union keeps both suites green through the transition.

### E2E acceptance

Flip `topology-ab.e2e.test.ts`'s oracle back to `periods.flatMap(...)` (delete
the union workaround) → flow green on slot 1. saga-dash stage-6 sessions
day-list stays green (its sessions are schedule-originated — unaffected).

**Risk:** S — one predicate + tests; the main risk is the adhoc.create
discriminator, which the verification step settles up front.

---

## Sequencing & validation

1. Verify the adhoc.create `periodId` shape (Fix 2 pre-check) — 30 min.
2. Land Fix 2 (small, independent), then Fix 1 on top; program-hub CI + both
   services' suites green.
3. Pull program-hub on slot 0, rebuild (mind the fresh-skip trap), then the
   e2e acceptance: topology flow 3× WITHOUT workarounds on slot 1, journey
   `--through sessions` on slot 0 (dayList consumers unaffected).
4. Follow-up spec PR (saga-dash): remove both workarounds + their comments,
   referencing the fix SHAs.

**Out of scope:** the podAssignments.upsert 404 projection lag (finding 3 —
eventual-consistency by design; revisit only if it bites a non-test client)
and any UI change for saga-dash#226 (reads benefit automatically once #317
lands).

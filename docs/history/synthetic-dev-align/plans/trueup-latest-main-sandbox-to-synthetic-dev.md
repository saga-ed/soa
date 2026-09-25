# Plan — true up the `latest-main` sandbox to synthetic-dev's full-seed state

> ## ✅ Outcome (EXECUTED 2026-06-18/19 — "Goal 1")
> The `latest-main` sandbox's 5 DBs were directly loaded with synthetic-dev `--seed full` data
> (current-main schema) and the data confirmed by logging into the dash as
> `demo-dadmin@saga.org` / `password123`. Hard-won lessons that fed the canonical re-cut:
> - **pg18→pg15 strip:** local mesh dumps on pg18 emit `\restrict`/`SET transaction_timeout` that abort
>   a pg15 sandbox load (silently — the restore swallows errors and returns `"action":"restored"`
>   regardless). Strip those directives; verify loads by SSM-querying the DB, not the restore envelope.
> - **PII keys:** iam_pii must be seeded with the DEV FLEET's PII crypto keys (Secrets Manager
>   `rostering/dev/pii-dek`/`pii-hmac-key`), not local keys, or email_hash/encryption won't match and
>   login fails at the PII lookup. The seed already creates PASSWORD auth_associations (argon2id,
>   `password123`) for all demo users.
> - The **janus employee-SSO perimeter** sits in front of iam-api; reaching the product login needs
>   JumpCloud first (the dash gates jumpcloud → iam).
>
> Sibling: the fleet-wide counterpart (re-cut `canonical` so EVERY future sandbox gets this state) was
> then executed — see `rebaseline-canonical-from-synthetic-dev.md` Outcome block, verified via the fresh
> `canon-check-0619` composition.

**Status:** DONE 2026-06-18/19 (was DRAFT 2026-06-18 — see Outcome block)
**Scope:** the deployed `latest-main` switchboard sandbox + the `canonical` S3
seed snapshots (`s3://saga-db-seeds-dev/*-canonical/`). No local `up.sh` changes.
**Sibling track:** the cloud-side counterpart of `up-sh-db-seed-transition.md` —
that plan converges the *local* base onto `db:seed`/seed-ids; this one makes the
*deployed* `canonical` snapshot equal that same seeded state.

## Goal & success criterion

Make the deployed `latest-main` sandbox hold the same DB data as a fresh local
`./up.sh --reset --seed full`. User framing: *revise `canonical` to be
version-compatible copies of the synthetic-dev database state.*

**Acceptance test:** `./up.sh --reset --seed full` locally → `pg_dump` each
service DB → diff against the restored sandbox DBs (or against the canonical S3
dumps) → row-for-row parity, especially sessions-api projections + the
`projection_readiness` warm row.

## What's actually true (verified 2026-06-18, `saga-infra-dev` S3 read + seed code on `main`)

**Canonical already IS a synthetic-style seed — just slightly older.** The current
`profile-canonical.sql` dumps carry deterministic `seed-ids` data (dev id
`1e2ca0d8-…` present; Demo/Lincoln/Metro/Riverside districts), re-cut 2026-06-15
(iam/programs) / 06-11 (scheduling):

| DB (S3 prefix) | key rows | schemaRev (sidecar) |
|---|---|---|
| iam (`rostering-iam-canonical`) | users 205, user_profiles 205, groups 47, group_memberships 411, personas 10 | `20260519201834_add_login_profiles` |
| iam-pii (`rostering-iam-pii-canonical`) | user_pii 15 | `20260415162135` |
| programs (`program-hub-programs-canonical`) | Program 10, TutoringPeriod 24, ProgramSectionMapping 23, Pod 8 (+PodStudent 14/PodTutor 8), content_item 12 | `20260527000401_sessions_sector` |
| scheduling (`program-hub-scheduling-canonical`) | Schedule 9, RecurrenceRule 17, CalendarEvent 1626, PeriodScheduleConfig 15 | `20260521120100…` |
| **sessions** | **— NO SNAPSHOT EXISTS —** | — |

(205 users = the same superset as `../decisions/d2.1-user-count-superset.md`.
`districts`/`schools`/`sections` tables are 0 *by design* — the roster is modeled
AS `groups` = 47 ≈ 5 districts + 13 schools + 28 sections + demo.)

**The empty `*_projection` tables are NOT a defect.** `period_projection`,
`program_projection`, `user_projection`, `slot_projection`, `pod_assignment` in
the programs/scheduling dumps are EVENT-BUILT (scheduling-api `db:seed` writes 0
projection rows). They're empty in synthetic-dev's *own* `--seed full` dump too —
built lazily at runtime by event consumers. `outbox_event`/`consumed_events` are
transient (empty by design). So canonical *matches* synthetic-dev's at-rest state
for these. (Ties into the `soa_75` outbox/event track — seed-time vs runtime.)

**The dash read path is sessions-api's DB, which IS fully at-rest.** sessions-api's
`db:seed` writes every projection + the `projectionReadiness` warm row directly
(`program-hub/apps/node/sessions-api/src/prisma/seed.ts:110/137/192/226/298/344`).
This is the DB the dash's People/Schedule/Sessions pages actually read — and it
has **no canonical snapshot at all.**

## The three trueing-up actions, in priority order

### 1. Recompose `latest-main` to restore *current* canonical  *(cheap, do first)*
Canonical was refreshed 06-15. Any `latest-main` composed before that restored a
*stale* snapshot. A recompose/redeploy (re-running the composition, or
`POST /compositions/{name}/update` with `resetAllData` / `dbProfile=canonical`)
re-restores the current dumps. This alone may close most of the gap for
iam/programs/scheduling — no data engineering required.

> Needs sandbox-api access (CI bearer + perimeter bypass, or the OIDC'd console
> UI). `dbProfiles` defaults to `canonical` everywhere, so this is a redeploy, not
> a reconfigure.

### 2. ADD a `sessions` canonical snapshot  *(the high-value missing piece)*
The real gap. Sequence (existing primitives only — `saga-orch snapshot` →
db-host-v2 `POST /dbs/{name}/snapshot` → `pg_dump` → S3):

1. Seed a sessions DB to synthetic-dev's full-seed state — two options:
   - **(a) From synthetic-dev local:** `./up.sh --reset --seed full`, then
     `pg_dump --no-owner --no-acl <sessions_db>` of the local `sessions` DB.
     Requires an **S3-write tier** to upload as
     `s3://saga-db-seeds-dev/<sessions-prefix>/profile-canonical.sql` (+ a
     `profile-canonical.meta.json` sidecar with the matching `schemaRev`).
   - **(b) On a db-host scratch DB:** provision a sessions DB, run sessions-api
     `db:seed` against it, then `saga-orch snapshot --service-name sessions-api
     --seed-profile canonical`. The sanctioned path; writes the sidecar
     automatically (soa#148 capture).
2. Register the sessions service's canonical so compositions can restore it.

> Confirm the sessions service's registered switchboard name + expected S3 prefix
> (the others are `program-hub-programs-canonical` etc.) before uploading.

### 3. Re-baseline iam/programs/scheduling canonical to current synthetic-dev main  *(optional, closes minor drift)*
Drift is small (personas: 2 `admin` rows vs rostering #397's per-district 6 — the
d1.1 gate; Program 9→10). For exact parity:
- Snapshot synthetic-dev at the **same `main`** `latest-main` runs (so `schemaRev`
  matches — restore migrate-forwards if behind, hard-fails if ahead/destructive,
  per switchboard `snapshot-schema-versioning.md`).
- Re-cut each: iam is **TWO DBs** (iam + iam-pii — both). content-api has a 05-31
  canonical — decide if in scope.
- Same option (a) or (b) as step 2.

## Open items / decisions
- **S3-write tier** for option (a) uploads — not held at Observer/AppInfra-read;
  needs the seed-bucket write grant (AppInfra/Platform or a db-host operator path).
- **Sessions service registration** — confirm its switchboard name + canonical S3
  prefix before cutting the snapshot.
- **Automate?** Flow B (re-snapshot-canonical) is design-only (switchboard
  `snapshot-schema-versioning.md`); this is the manual version. Worth wiring into
  CI once proven once by hand. → candidate `decisions/` doc: *whether/when to
  execute, and whether to automate canonical re-baselining.*

## Related artifacts
- `up-sh-db-seed-transition.md` — the local-side base→`db:seed` transition (sibling).
- `../decisions/d2.1-user-count-superset.md` — the 205-user superset rationale.
- `../decisions/d1.1-base-journey-split.md` — base vs journey layering.
- synthetic-dev `INTEGRATION.md` — the `--sandbox`/`--compose-rest` hybrid (the
  *consumer* of canonical; does NOT push local data into a sandbox).
- switchboard `docs/snapshot-schema-versioning.md` — sidecar/`schemaRev` + Flow B.

---

*Verified against live dev S3 + program-hub/rostering `main` on 2026-06-18.*

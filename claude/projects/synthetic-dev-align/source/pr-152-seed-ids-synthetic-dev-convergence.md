<!-- Snapshot of saga-dash PR #152 :: docs/seed-ids-synthetic-dev-convergence.md
     Source: saga-ed/saga-dash @ branch docs/seed-ids-onboarding
     Captured 2026-06-04. Trust the live PR if this diverges. -->

# Proposal: seed synthetic-dev's canonical base from seed-ids (`db:seed`), run scenarios on top

> **Companion to [`seed-ids-onboarding.md`](./seed-ids-onboarding.md) and
> [`seed-ids-local-mesh-runbook.md`](./seed-ids-local-mesh-runbook.md).** A proposal for converging the
> local `synthetic-dev` stack onto the deterministic seed-ids base while keeping scenarios as the
> journey layer on top. Status: **draft for discussion.**

## Context

Two seeding mechanisms describe the **same** synthetic roster (5 districts / 13 schools /
28 sections / 168 students / 22 tutors / 6 dev personas), but with different ID behavior:

| | seeds via | foundational IDs | on reset |
|---|---|---|---|
| **synthetic-dev (local)** | scenario runner (`rostering` + `program-hub` `scripts/scenarios`) | assigned at create time → **non-deterministic** | **new UUIDs → re-login + reconfigure** |
| **`db:seed` (each service)** | `@saga-ed/*-seed-ids` derive | `uuidv5(...)` → **deterministic** | **identical UUIDs** |
| **AWS preview / CI mesh** | `db:seed` → canonical S3 snapshots | deterministic | restore = identical |

So **local dev and preview/CI already diverge**: preview/CI is built on the deterministic
seed-ids base; synthetic-dev still mints per-run UUIDs via the scenario runner (verified: the
scenario files import no seed-ids; `synthetic-dev/README.md` documents "reset → new UUIDs,
re-login"). That divergence is the source of synthetic-dev's "re-login after every `--reset`"
friction and means a local repro isn't guaranteed to match a preview repro.

**Important: this is not "delete the scenario runner."** We still need scenarios for *journeys*
(enrollments, schedules, sessions, attendance flows). The proposal is to **layer** them.

## Target model — layered, not either/or

- **Base layer = seed-ids `db:seed` (deterministic).** Orgs, schools, sections, users, roster,
  programs, content. Stable UUIDs that correlate across services by construction and match exactly
  what preview/CI restores from the canonical snapshots. Stable across reseeds → **the base never
  forces a re-login**.
- **Journey layer = scenarios, on top of that base.** The dynamic, per-run state a test/demo
  exercises. Scenarios **reference the canonical seed-ids** (`groupId('seed')`,
  `programId('lincoln-fall')`, `personId('s-137')`) for foundational entities instead of creating
  their own, then add journey rows. Per-run dynamic data (a session, an attendance record) can stay
  non-deterministic — only the *base* needs to be stable.

## Proposed changes

1. **`up.sh` seed phase → run `db:seed` for the base.** Where `up.sh`'s `--seed roster` currently runs
   the scenario to build the base roster, run each service's `pnpm db:seed` instead (iam-db,
   programs-api, scheduling-api, +content-api when present). This is also what the deployed
   `_deploy-ecs-api.yml` migrate/seed path already does — so `up.sh` converges on the production
   seeding path it already mirrors for migrations (`migrate deploy`, d1.5).
2. **Make scenarios seed-ids-aware.** In `rostering` + `program-hub` `scripts/scenarios`, resolve
   foundational entity IDs through the seed-ids packages (`groupId`/`userId`/`programId`/`personId` or
   the `derive` subpath) rather than minting them. The scenario then only creates the *journey* rows
   (enrollment, schedules, sessions) against the already-seeded canonical base. Add a `--seed full`
   that = `db:seed` base + scenario journey layer.
3. **Stabilize the dev user.** With a `db:seed` base, the dev user is `userId('dev')` =
   `1e2ca0d8-…-1186`; set `AUTH_DEVUSERID` to that and retire the separate `…beef` dev-user seeder.
   `./up.sh --login` and the saga-dash session then survive `--reset`.
4. **`verify.sh`** — assert the base counts against the deterministic seed-ids catalog (already the
   right numbers: 5/13/28/168/22/6, 9 programs, 12 content items) and that key IDs match
   `deriveGroupId('seed')` etc.

## Payoff

- **local == preview == CI** — one canonical roster, one set of UUIDs everywhere; a local bug
  reproduces in preview by construction.
- **No re-login / reconfigure after `--reset`** for the base — `userId('dev')`, `groupId('seed')`,
  saga-dash `config.json`, and bookmarks all stay valid.
- **Scenarios keep their full value** for journeys, now anchored to stable canonical IDs.
- synthetic-dev keeps everything it's good at — orchestration, `verify.sh`, PR-pinning, sis-api,
  `--login`, drift-patching — only the *seed source* changes.

## Non-goals / what stays

- Scenarios are **not** removed — they become the journey layer on top of the canonical base.
- Per-run dynamic journey data may remain non-deterministic; only the base must be stable.
- No change to the orchestration/verify/login harness.

## Open questions

- **Base parity:** does each service's `db:seed` cover everything the scenario's base does today
  (personas + the 593 memberships, per-district admin personas)? The seed-ids `db:seed` seeds users +
  PII + password auth + memberships; per-district admin personas for riverside/metro/oakdale/frontier
  were a noted seed-ids follow-up — confirm/close that gap so login parity holds for every persona.
- **Journey/base split:** which rows the current scenarios create are "base" (move to `db:seed`) vs
  "journey" (stay in the scenario)? Enrollment is the obvious journey item; programs/periods are base
  (already in `program-seed-ids` `db:seed`).
- **Scenario refactor scope:** how much of `scripts/scenarios` changes to consume seed-ids vs mint.

## References

- seed-ids reference + ID inventory: [`seed-ids-onboarding.md`](./seed-ids-onboarding.md)
- local mesh runbook + the layered model: [`seed-ids-local-mesh-runbook.md`](./seed-ids-local-mesh-runbook.md)
- synthetic-dev: `soa/tools/synthetic-dev/{README,getting-started}.md` + the drift log
- original design (fixture/snapshot/scenario vocabulary): `rostering/claude/seed-scenario-handoff.md`
- canonical snapshots / preview seeding: the canonical-seed-mesh campaign (db-host-v2 + `db:seed` → S3)

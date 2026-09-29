# 01 — Seth's plan, synthesized

> Source: saga-dash PR #152 (three docs). Raw snapshots in
> `../source/pr-152-*`. This is the distilled "what is he actually
> proposing and why" — read this before `03-convergence-analysis.md`.

## The big idea in one paragraph

Saga has shipped a set of tiny, **dev-only** packages —
`@saga-ed/iam-seed-ids`, `@saga-ed/program-seed-ids`,
`@saga-ed/content-seed-ids` (all `0.1.0-dev.0` on CodeArtifact) — that
hand **every** service the **same UUIDs** for shared seed data **by
construction**. Each ID is `uuidv5("<kind>:<slug>", ROOT_NAMESPACE)` (or a
fixed literal). Two services that import the package compute the **same
id for the same slug**, so a program's `organizationId` equals the iam
district's id with **no shared DB, no HTTP call, and no seed ordering
dependency**. Seth's plan is to make the local `synthetic-dev` stack seed
its **base** from these packages (via each service's `db:seed`) so that
**local dev == AWS preview == CI** — while keeping the scenario runner
for **journey** data on top.

## The three packages (the "what exists")

| Package | Repo · path | Role |
|---|---|---|
| `@saga-ed/iam-seed-ids` | `rostering/packages/core/iam-seed-ids` | **Foundational** — districts/schools/sections/users/roster |
| `@saga-ed/program-seed-ids` | `program-hub/packages/core/program-seed-ids` | Programs/periods/sessions/slots (depends on iam-seed-ids) |
| `@saga-ed/content-seed-ids` | `program-hub/packages/core/content-seed-ids` | Content items (standalone) |

The frozen contract:

- **`ROOT_NAMESPACE = b2c4f1a0-5e3d-4c9a-8f6b-1d2e3f4a5b6c`** — changing it
  re-randomizes every id and breaks every consumer. **Never touch it.**
- **`CANONICAL_SOURCE = 'canonical'`** — the `source` tag iam-api writes on
  every canonical group; consumers filter on it.

Two import worlds:

- **Browser-safe** (saga-dash, janus): import the root → frozen literal
  UUIDs, no `node:crypto`.
- **Node-only** (`*-api` seeds, codegen): import the `/derive` subpath for
  live `uuidv5` derivation.

The seeded inventory (the same roster synthetic-dev already produces):
**5 districts, 13 schools, 28 sections, 6 named dev users, 168 students +
22 tutors (190 roster), 9 programs, 12 content items.** Login is any
`{dev,multi,many,new,frontier,none}@saga.org` / `password123`.

> Note the **division of labor** Seth is careful about: *"Events remain
> the runtime propagation path; seed-ids are the seed-time agreement."*
> This is the clean boundary with the soa_75 outbox/event work — seed-ids
> do **not** replace events; they make the *seed-time starting state*
> agree so events have a consistent base to propagate from.

## The correlation proof (the runbook's centerpiece)

The local-mesh runbook's whole point is **Step 5**: demonstrate the same
UUID across services with **nothing running and no HTTP**:

1. `deriveGroupId('seed')` (pure offline function) → `71698462-…-0c3f`
2. iam-api's `groups` table wrote that id (`source='canonical'`,
   `source_id='seed'`).
3. programs-api's `Program.organizationId` **references** that same id —
   computed **offline** from the slug, iam-api never consulted.

All three are identical. That is "integrate through the packaged
seed-ids" — and it's exactly what AWS preview/CI already do by restoring
canonical S3 snapshots seeded from `db:seed`.

## The convergence proposal (the actual ask of this initiative)

### The target model — layered, **not** either/or

- **Base layer = seed-ids `db:seed` (deterministic).** Orgs, schools,
  sections, users, roster, programs, content. Stable UUIDs that correlate
  across services by construction and match what preview/CI restore from
  canonical snapshots. **Stable across reseeds → the base never forces a
  re-login.**
- **Journey layer = scenarios, on top of that base.** Enrollments,
  schedules, sessions, attendance flows — the dynamic, per-run state a
  test/demo exercises. Scenarios **reference** the canonical seed-ids
  (`groupId('seed')`, `programId('lincoln-fall')`, `personId('s-137')`)
  for foundational entities instead of minting their own, then layer
  journey rows on top. Per-run dynamic data may stay non-deterministic;
  only the **base** must be stable.

### The four proposed changes

1. **`up.sh` seed phase → run `db:seed` for the base.** Where `up.sh`'s
   `--seed roster` currently runs the scenario to build the base roster,
   run each service's `pnpm db:seed` instead (iam-db, programs-api,
   scheduling-api, +content-api when present). This is also what the
   deployed `_deploy-ecs-api.yml` migrate/seed path already does — so
   `up.sh` converges on the production seeding path it already mirrors for
   migrations.
2. **Make scenarios seed-ids-aware.** In `rostering` + `program-hub`
   `scripts/scenarios`, resolve foundational entity IDs through the
   seed-ids packages rather than minting them. The scenario then only
   creates *journey* rows. Add a `--seed full` = `db:seed` base + scenario
   journey layer.
3. **Stabilize the dev user.** With a `db:seed` base, the dev user is
   `userId('dev')` = `1e2ca0d8-…-1186`; set `AUTH_DEVUSERID` to that and
   retire the separate `…beef` dev-user seeder. `./up.sh --login` and the
   saga-dash session then survive `--reset`.
4. **`verify.sh`** — assert the base counts against the deterministic
   catalog (5/13/28/168/22/6, 9 programs, 12 content) and that key IDs
   match `deriveGroupId('seed')` etc.

### The payoff Seth claims

- **local == preview == CI** — one canonical roster, one set of UUIDs
  everywhere; a local bug reproduces in preview by construction.
- **No re-login / reconfigure after `--reset`** for the base —
  `userId('dev')`, `groupId('seed')`, saga-dash `config.json`, and
  bookmarks all stay valid.
- **Scenarios keep their full value** for journeys, anchored to stable
  canonical IDs.
- synthetic-dev keeps everything it's good at — orchestration,
  `verify.sh`, PR-pinning, sis-api, `--login`, drift-patching — only the
  *seed source* changes.

### Non-goals Seth is explicit about

- Scenarios are **not** removed — they become the journey layer.
- Per-run dynamic journey data may stay non-deterministic; only the base
  must be stable.
- No change to the orchestration / verify / login harness.

## Seth's own open questions (carried into `03`)

1. **Base parity** — does each service's `db:seed` cover everything the
   scenario base does today (personas + the ~593 memberships, per-district
   admin personas)? Per-district admin personas for
   riverside/metro/oakdale/frontier were a noted seed-ids follow-up.
2. **Journey/base split** — which rows current scenarios create are
   "base" (move to `db:seed`) vs "journey" (stay)? Enrollment = obvious
   journey; programs/periods = base.
3. **Scenario refactor scope** — how much of `scripts/scenarios` changes
   to consume seed-ids vs mint.

## Status of the proposal

The convergence doc is explicitly **"draft for discussion, not a
decision."** The onboarding + runbook docs are reference/grounded; the
convergence is the open question this initiative exists to resolve.

# Research 07 — Playlisting current state (the CLI-driven coach-content-seeding pipeline)

**Effort:** ss `develop` coach concierge (saga-ed/soa#305), input to "port playlisting into coach-api" plan
**Task:** find + fully characterize CURRENT playlisting, wherever it lives.
**Repos read:** `/home/skelly/dev/coach`, `/home/skelly/dev/saga-dash`, `/home/skelly/dev/rostering`, `/home/skelly/dev/program-hub`, `/home/skelly/dev/student-data-system`, `/home/skelly/dev/soa`
**Date:** 2026-07-14

---

## Headline — the premise is inverted; the port is mostly ALREADY DONE

The task framing was "PORT playlisting OUT of saga-dash INTO coach-api." Evidence
contradicts the premise on both ends:

1. **saga-dash has NO playlisting/content-seeding code.** Broad grep for
   `playlist`, `playlist_name`, `available_playlists`, `group_track_map`,
   `content_name`, `content_release`, `materializ`, `ContentInstance`,
   `content-archive`, `user_policy` across saga-dash `apps/` + `packages/`
   (non-test, non-worktree) returns **two false positives only**:
   `apps/web/dash/playwright.stack.config.ts:205` ("occurrence roster is
   materialized") and `packages/web/pages/program-config/src/onboarding/podbuilder-helpers.ts:672`
   (calendar-event "materialized"). `git -C saga-dash log --all --oneline | grep -i playlist`
   is **empty**. saga-dash does not seed coach content and never did.

2. **The CLI-driven content-seeding pipeline ALREADY lives in the coach repo**
   (`/home/skelly/dev/coach`), writing to coach's own Postgres (`coach_api`).
   It is `@saga-ed/coach-content-publish` (binary **`coach-content`**) +
   `@saga-ed/coach-db` seed + the coach-api **reconcile** runtime materializer.

3. **What historically WAS separate playlisting lived in the LEGACY `saga_api`
   monolith, not saga-dash** — the `user_policy` GraphQL resolver
   (`playlist_name` / `available_playlists` / `playlist_version` /
   `default_track_content`) and a `content_track_collections_coach` table keyed
   by `org_name`. coach-api has **already replaced** that with its own
   `group_track_map` table (schema comment on `GroupTrackMap`:
   *"Replaces the dead saga_api path (`content_track_collections_coach` keyed by
   `org_name` + policy `default_track_content`)"*). `saga_api` is not checked out
   under `~/dev` — treat its internals as documented-but-unverified-locally.

So "make coach-api a one-stop shop for coach content seeding" is **already the
state of the tree** for the publish→materialize path. The only residual
saga_api/rostering coupling is the *playlist-selection policy* on `user_policy`,
and even that is superseded by `group_track_map` for the two-store path. See
"What is actually left to move" at the end.

> Cross-check: this extends, and does not contradict, `research/03-coach-admin-and-playlisting.md`
> (which already found "playlisting has no dedicated UI; the coach repo owns the
> authoring→publish→materialize CLI"). This doc adds the exact data model, the
> saga_api legacy seam, and the concrete "what's left."

---

## 1. What IS "playlisting" (precise domain definition)

In Coach's domain, **a "playlist" == a "track" == a `content_name`** — a named,
published, coherent set of curriculum units/modules a tutor works through.
Evidence:

- `apps/web/coach-web/src/lib/types/coach.ts:49-51` — `PlaylistData` = "Content
  playlist containing units and progress" (the tutor's assembled track).
- `saga-ed/saga-dash#463` (title): *"Coach playlists: tag-based content + user
  attributes instead of maintaining 4 playlists (MS/HS × online/in-person)"* —
  i.e. historically **4 hand-maintained playlists** keyed by grade-band × modality.
  (This issue is filed in saga-dash the *tracker*, but it is a coach-content
  concern; no saga-dash *code* implements it.)
- Legacy selection fields on `user_policy` (saga_api):
  `playlist_name` (String!, the active playlist), `available_playlists`
  ([String!], selectable), `playlist_version`, `default_track_content`,
  `default_track` — documented in
  `coach/review_reports/coach-api/cross-api-plan.md:97-101,216-220,385-387`.

**The problem it solves:** deciding *which* curriculum a given tutor is served
(by grade band / modality / district), and *seeding* that curriculum's content
so the coach dashboard/player has something to render. Two separable halves:
- **(a) Content authoring→publish** — turn a content-archive into servable
  release rows. (CLI; coach-owned.)
- **(b) Assignment/selection** — map a tutor (via their district/section group)
  to a track, and **materialize** a per-user content instance. (Runtime
  event-reconcile + a dev CLI; coach-owned. Legacy equivalent was saga_api
  `user_policy` + `content_track_collections_coach`.)

There is **no playlisting web UI** anywhere (confirmed doc 03): no `/playlist`
route in coach-web; `/explore` is the tutor's own within-instance module browser.

---

## 2. Where the CLI is TODAY (exact repo / path / command)

**Package:** `@saga-ed/coach-content-publish`
**Location:** `/home/skelly/dev/coach/packages/node/coach-content-publish/`
**Binary:** `coach-content` — entry `src/cli.ts` (`#!/usr/bin/env node`)
**Target DB:** `DATABASE_URL` → coach's `coach_api` Postgres (via `@saga-ed/coach-db` `getPrisma()`).

### Commands (`src/cli.ts` USAGE)
```
coach-content status
coach-content diff     --archive <path> [--ref <sha>] [--structure-overlay <dir>]
coach-content publish  --archive <path> --ref <sha> [--approve] [--note <s>]
                       [--structure-overlay <dir>] [--allow-large-delete] [--allow-missing-content]
coach-content rollback --to <releaseId> --approve
coach-content materialize --user <id> --content <name> [--replace | --delete]
```
Exit codes: `0` ok/no drift · `1` error · `2` drift pending approval.

### Inputs
- **Source content:** the `saga-ed/content-archive` GitHub repo (the durable
  source of truth), layout (`archive.ts` header):
  - `curriculum/content_coach/<name>.json` — curriculum STRUCTURE docs (extended JSON)
  - `exports/<teacher_id>/polls/<mongo_id>/poll.json` — authored polls (leaf content)
  Acquired either from a git checkout (`--ref <sha>` → `git archive | tar -x`) or a
  CodeArtifact-extracted npm tarball detected by a `_meta.json` `{sha, ref}` at root.
- `--structure-overlay <dir>` — optional local overlay of structure docs.
- `materialize` inputs: `--user <id>` `--content <name>` `[--replace|--delete]`.

### Outputs (what it writes, in coach_api Postgres — `src/store.ts`)
- **`publish`** → inserts a `content_release` (+ `content_release_curriculum`,
  `content_release_poll` children) and **atomically upserts the
  `active_content_release` singleton** pointer — one interactive tx (timeout
  lifted to 120s because the real path tunnels ~7 MB over SSM; see store.ts
  comment). Idempotent by `content_hash` (a payload equal to active = no-op).
- **`rollback`** → repoints `active_content_release` at a prior release id.
- **`materialize`** → inserts a `content_instance` (+ `content_instance_module`
  children) for `(userId, contentName)` from the **active** release's curriculum
  doc, deriving the nav via `deriveTemplates` (shared with coach-api). Guarded:
  requires the doc to carry a **top-level `nav`** (the instance shape) — the
  served subject doc keys nav per-unit and is *not* materializable. `--replace`
  deletes first; `--delete` is the e2e-teardown counterpart. This is a
  **dev/e2e helper** that mirrors coach-api's runtime materializer.

### How it's invoked (CI, real publishes)
`/home/skelly/dev/coach/.github/workflows/publish-content.yml` (`workflow_dispatch`):
inputs `archive-version`, `approve` (default false = dry-run `diff`), `note`.
Runs `coach-content` **directly on a hosted runner** (no ECS task), reaching the
dev Postgres through an **SSM port-forward tunnel** via the shared jump host
(same pattern as `postgres_mirror_to_dev.yml` in `saga-ed/iac`). Uses the
`coach_api_app` (DML-only) role. `content-archive` is installed as a CodeArtifact
package (`npm pack` + tar extract). `concurrency: publish-content-dev` (one at a time).
Design writeup: `coach/claude/coach-content-publish-workflow-scope.md`.

### How content gets seeded LOCALLY (the ss stack path — this is the "seeding")
The dev stack does **not** run `coach-content publish`; it runs the coach-db
seed, which bakes a fixture release + instance + the projections directly:
- ss step `coach-pg` (`soa/packages/node/saga-stack-cli/src/core/seed/profiles.ts:416-425`):
  `cwd packages/node/coach-db`, `command pnpm db:seed`, `DATABASE_URL` forced to
  mesh :5432 `coach_api`. Comment: *"coach's WHOLE seed (Postgres) — coach-db
  db:seed (local-snapshot): content_instance + the THREE iam→coach projections
  (persona_definition, persona_assignment, group_track_map) + the content_release
  the curriculum read path serves from."* Single-store now (no mongo companion).
- Seed impl: `coach/packages/node/coach-db/src/seed/local-snapshot.ts` +
  `persona-projections.ts`. Idempotent. Bakes: one `content_release`
  (`curriculum-coach`, units `unit_1..4`) + active pointer; one materialized
  `content_instance` for `demo-tutor-1@saga.org` on track **`spring-pilot`**; the
  three projections; a `group_track_map` row pointing the **demo district**
  (`a0da8362-1a93-5d1d-aeaa-b6d8960e9821`) at the tutor's own track (derived from
  the instance so map/instance can't drift — `local-snapshot.ts:158-171`).

---

## 3. Data model + the seam to what the viewer reads

The coach viewer/dashboard reads `content_instance` rows (per-user materialized
nav). Those rows are produced two ways — both coach-owned:

```
                        saga-ed/content-archive (GitHub, source of truth)
                                     │  coach-content publish --approve
                                     ▼
  content_release ── content_release_curriculum (structure docs, keyed by name==content_name)
     │  └────────── content_release_poll (leaf poll render payload)
     │
  active_content_release (singleton pointer, id='active')  ◄── the atomic cutover
     │
     │  ┌─ coach-content materialize --user --content   (CLI, dev/e2e)
     ▼  ▼
  content_instance  (UNIQUE(user_id, content_name); + content_instance_module,
     ▲                content_instance_completed_module, module_answer)
     │
     └─ coach-api RUNTIME reconcile (the real prod path):
        apps/node/coach-api/src/sectors/cns/events/iam-projection-handlers.ts
        + instance-materializer.ts (materializeInstance, same deriveTemplates)
```

### The assignment seam (group → track → instance)
coach-api consumes `iam.persona_assignment.{added,removed}` +
`iam.persona_definition.upserted` off the shared `iam.events` RabbitMQ exchange
and projects them into Postgres (`persona_assignment`, `persona_definition`).
`reconcile(personaId)` (in `iam-projection-handlers.ts`) then:
1. Recognizes a coach tutor by the permission **`coach:access_coach_app`** in
   `persona_definition` (never a personaId or role name).
2. For each active **district- or section-scoped** assignment
   (`MATERIALIZED_GROUP_KINDS = ['district','section']`, Phase 2a):
   looks up **`group_track_map.content_name` by `group_id`** → the track; unmapped
   group falls back to `DEFAULT_CONTENT_NAME = 'base-coach'`.
3. `materializeInstance(tx, user_id, content)` → `INSERT … ON CONFLICT
   (user_id, content_name) DO NOTHING` (idempotent, create-if-missing only).

Read side: `PostgresAssignmentStore` (`apps/node/coach-api/src/sectors/cns/assignments/`)
joins `persona_assignment` → `group_track_map` **on `group_id` alone** (not
`group_kind`); `fetchDashboardFromAssignments` (coach-web `src/lib/api/cns.ts`)
flattens every matched instance's modules into one `allModules[]`. **Caveat
(pre-existing):** an *unmapped* group's fallback (`base-coach`) instance has no
`group_track_map` row → no assignment join row → the instance materializes but is
**invisible** to the dashboard read path.

### Key tables (coach-db `src/prisma/schema.prisma`)
| model | table | role |
|---|---|---|
| `ContentRelease` (:203) | `content_release` | immutable published snapshot; `archive_sha`, `content_hash` |
| `ContentReleaseCurriculum` (:226) | `content_release_curriculum` | structure doc, `@@id([releaseId,name])`; `name` == `content_name` |
| `ContentReleasePoll` (:243) | `content_release_poll` | leaf poll render payload (`pollId`==module content_id) |
| `ActiveContentRelease` (:266) | `active_content_release` | singleton pointer `id='active'`; **flipping it IS the publish** |
| `ContentInstance` (:29) | `content_instance` | per-user materialized track; **`@@unique([userId, contentName])`** |
| `ContentInstanceModule` (:65) | `content_instance_module` | mutable nav graph rows (state/holds/unlocks) |
| `GroupTrackMap` (:293) | `group_track_map` | **group_id → content_name** (the assignment routing table) |
| `PersonaDefinition` (:155) | `persona_definition` | personaId → permission names (coach-relevance signal) |
| `PersonaAssignment` (:171) | `persona_assignment` | iam assignment interval (validFrom/validUntil, groupKind) |

Provenance: `ContentInstance` materialization at section grain = coach PRs
**#448 / #463 Phase 2a** (commit `273eb53` "materialize ContentInstances at
section grain"). `group_track_map` = the ratified domain-boundary exception
(**coach#91, commit 95417fd**). `coach-content materialize --delete` = commits
`36d68c7` / `8573e69`. `group_track_map` baked into seed = `1b54e46`.
Materialize-on-iam-events = `beb7fcf` (Phase 1 step 4b).

---

## 4. Dependencies

- **Databases:** ONLY coach's `coach_api` Postgres. (Single-store now — the
  former `coach-mongo` curriculum store is dead; profiles.ts comment.) The CLI's
  `DATABASE_URL` selects it; local mesh :5432, coach-db standalone default :5433.
  Roles: `coach_api_app` (DML) for publish; `coach-db db:push` applies schema.
- **External source input:** `saga-ed/content-archive` (GitHub repo /
  CodeArtifact package) — curriculum structure docs + authored polls. Written
  upstream by content-archive's own `publish-content-archive.yml` +
  records-pusher Lambda (manifest gate applied there, so archive main is
  delete-safe).
- **iam / rostering (event producer):** the assignment path depends on the
  `iam.events` exchange (`iam.persona_assignment.*`, `iam.persona_definition.upserted`)
  emitted by rostering's iam-api; ids derive from `@saga-ed/iam-seed-ids`
  (`demo-*` cohort) which iam-db's `prisma/seed.ts` also emits. Cold-start
  bootstrap of `persona_definition` from `iam-api personas.list` (a brand-new
  queue has no history).
- **Infra (real publishes):** SSM port-forward tunnel + shared jump host (iac),
  CodeArtifact. GitHub Actions `workflow_dispatch`.
- **saga-dash-specific coupling that makes it "live in saga-dash":** NONE FOUND.
  The only cross-repo selection coupling is to the **legacy `saga_api` monolith**
  `user_policy` resolver (`playlist_name`/`available_playlists`), which coach-api's
  cross-api MVP calls (`cross-api-plan.md`) and which `group_track_map` supersedes
  for the two-store path — not saga-dash.

---

## 5. What would ACTUALLY have to move to make coach-api own it end-to-end

Because publish + materialize + reconcile + seed already live in coach, the
"port" is mostly **already complete**. Residual items (all coach-repo-internal
or legacy-monolith, NOT saga-dash):

1. **Retire the `user_policy` selection dependency (legacy saga_api).** coach-api
   still has a cross-api MVP that reads `user_policy(playlist_name,
   available_playlists)` from saga_api (`cross-api-plan.md` Stage 1). To be fully
   self-owned, playlist *selection* must resolve entirely from `group_track_map`
   (+ future Phase 2b tag-filter), removing the saga_api round-trip. This is the
   one genuine "move it into coach-api" item, and it is *the legacy monolith*, not
   saga-dash.
2. **Second track + switchable mapping for a `develop --playlist` scenario.** The
   committed seed has only ONE track (`spring-pilot`). A develop-playlist surface
   needs ≥2 published `content_name`s and a `group_track_map` (or policy) toggle
   so a persona resolves to a chosen playlist, then `materialize` + `devLogin`.
   (This is *seed/dev-tooling* work, not a port.)
3. **(Optional) A `coach-content publish` step in ss** if the develop flow should
   exercise the archive→release path rather than the baked-fixture seed. Today ss
   seeds the release directly via `coach-db db:seed` (no `publish` run locally).
4. **Nothing to move out of saga-dash** — there is nothing there.

---

## Top open questions / unconfirmed

1. **Is the task premise a factual error, or is there a *different* "playlisting"
   the requester means?** Confirmed absent from saga-dash. Strongest candidate
   for "the thing in saga-dash" is actually the **legacy `saga_api` monolith**
   `user_policy`/`content_track_collections_coach` — needs confirmation that the
   requester conflates saga_api with saga-dash. `saga_api` is **not checked out
   locally** (`~/dev`), so its internals are documented-only (cross-api-plan.md,
   GroupTrackMap schema comment) and **unverified here**.
2. **saga-dash#463 "tag-based content" (Phase 2b)** — the 4-hand-maintained-
   playlists → tag-filter replacement is filed in the saga-dash tracker but is a
   coach-content-publish job. Is any of it implemented? (Not found; reconcile
   still does a direct `group_track_map` lookup, no tag filter.)
3. **Does "port into coach-api" mean "add a develop/seed concierge in ss"** rather
   than moving code? Given the pipeline already lives in coach, the actionable
   deliverable for #305 is likely a `develop coach --playlist` scenario over the
   existing coach-content/coach-db seed, per doc 03/05 — not a code migration.

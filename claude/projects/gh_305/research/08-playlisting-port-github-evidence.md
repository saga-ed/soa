# 08 — Playlisting port to coach-api: independent GitHub/repo evidence

**Author:** research agent (parallel to direct ask of Seth Paul)
**Date compiled:** 2026-07-14
**Scope:** Is "playlisting" (CLI-driven coach content seeding) being ported out of the
legacy stack into `coach-api`? What already exists, what's in flight, and Seth's
trajectory.

**Lead engineer:** Seth Paul (github `SethPaul`, sethcpaul@gmail.com). Every commit
cited below is authored by Seth — coach-api's content pipeline is effectively a
single-owner effort right now.

---

## TL;DR

**The "playlisting port" is not a future project — it is ~80% built and actively
shipping in `saga-ed/coach`, all by Seth.** "Playlist" is legacy nimbee/saga_api
terminology; in coach-api the same concept is modeled as **tracks** (`content_name`) +
**group→track mapping** (`group_track_map`) + a **content-publish CLI**
(`coach-content`). If gh_305 proposes to build playlisting seeding into coach, it would
be **joining an effort already underway**, not building net-new. The remaining open work
is the tag/attribute-matching idea from saga-dash #463 (Phase 2b, PR **#237 OPEN**).

---

## 1. Terminology reconciliation (why saga-dash has zero "playlist" hits)

`grep -ril playlist` across the **saga-dash** working copy and its history returns
**nothing**. "Playlist" is **not** a saga-dash concept. It is a legacy **nimbee /
saga_api** concept that lives in the **user_policy / rostering** layer:

- `gh search code --owner saga-ed playlist` surfaces the canonical definitions in
  **rostering**:
  - `rostering:claude/permission_policy_registry.md` — `coach_playlist_name`
    (`policy.coach.playlist_name`, "Primary Coach playlist for content resolution",
    consumers: **nimbee, coach**) and `coach_available_playlists`
    (`policy.coach.available_playlists`).
  - `rostering:claude/default_user_persona.md` — `coach.playlist_name` →
    `coach:coach_playlist_name`.
- coach-api's own planning doc names the legacy fields explicitly:
  `coach:review_reports/coach-api/cross-api-plan.md` lists the legacy `user_policy`
  shape — `playlist_name` (String! active playlist), `available_playlists` ([String!]),
  `playlist_version`, `default_track`, `default_track_content`.

**Mapping (legacy → coach-api):**

| Legacy (nimbee/saga_api `user_policy`) | coach-api reconstruction |
|---|---|
| `playlist_name` / active playlist | `content_name` (a **track**), keyed on `content_instance(user_id, content_name)` |
| group/district → which playlist | **`group_track_map`** table (`group_id → content_name`) |
| `DEFAULT_TRACK_NAME` fallback | `DEFAULT_CONTENT_NAME = 'base-coach'` (code comment: "mirrors legacy DEFAULT_TRACK_NAME") |
| playlist authoring/seeding | **`coach-content` CLI** (`@saga-ed/coach-content-publish`) |
| tag/attribute matching (aspirational, #463) | `tagFilter` + `filterContentByTags` (Phase 2b, in flight) |

So "port playlisting into coach-api" == "coach-api owns tracks + group_track_map +
content-publish + tag filtering." That is exactly what Seth has been building.

---

## 2. What ALREADY EXISTS in coach (merged / on main)

### 2a. The content-publish CLI — the seeding pipeline itself
`packages/node/coach-content-publish` — **`@saga-ed/coach-content-publish`**, bin
**`coach-content`**. Description: *"publish authored content from
saga-ed/content-archive into Coach's Postgres as immutable snapshot releases."*

Commands (from its README / `src/cli.ts`):
```
coach-content status
coach-content diff       --archive <checkout> [--ref <sha>] [--structure-overlay <dir>]
coach-content publish    --archive <checkout> --ref <sha> [--approve] [--note] ...
coach-content rollback   --to <releaseId> --approve
coach-content materialize --user <id> --content <name> [--replace|--delete]
```
This IS CLI-driven content seeding (no UI), matching the team's description of
playlisting. Pipeline: producer authors → export → S3 → records-pusher Lambda →
`content-archive` main → `coach-content publish --ref <sha> --approve` (the human gate) →
Postgres release rows + atomic `active_content_release` pointer flip → coach-api serves
live, no deploy. `materialize` shares `deriveTemplates` with coach-api's reconcile
materializer (verified in `src/store.ts:13,205-211`) so CLI seeding and event-driven
materialization cannot drift.

Relevant merged PRs building this:
- **coach #202** (MERGED 2026-07-09) "Content release snapshot: carry poll
  questions/tag_list through publish to Postgres"
- **coach #206** (MERGED 2026-07-09) "replace content_assignments Mongo collection with
  AssignmentStore"
- **coach #207** (MERGED 2026-07-09) "flip CONTENT_STORE_BACKEND default to postgres
  (Phase 1/4)"
- **coach #209** (MERGED 2026-07-10) "scope a content-publish workflow for coach#181 leg
  1" (docs/CI for `publish-content.yml`)
- **coach #234** (MERGED 2026-07-13) "lift $transaction timeout so full-archive publish
  survives the SSM tunnel" — fixes full 643-poll archive publish over the SSM tunnel.

### 2b. Track resolution — group_track_map + reconcile materializer
- `packages/node/coach-db/src/prisma/schema.prisma` — model **`GroupTrackMap`**
  (`group_id → group_kind → content_name`), plus `ContentInstance`,
  `ContentInstanceModule`, `ContentInstanceCompletedModule`, `ContentRelease`,
  `ContentReleaseCurriculum`, `ContentReleasePoll`, `PersonaDefinition`,
  `PersonaAssignment`.
- `apps/node/coach-api/src/sectors/cns/events/iam-projection-handlers.ts` — the
  **reconcile** path: joins `persona_assignment` → `group_track_map` on `group_id`,
  materializes a `content_instance` for the tutor's resolved track; falls back to
  `DEFAULT_CONTENT_NAME='base-coach'` for unmapped groups (explicitly "mirrors legacy
  DEFAULT_TRACK_NAME").
- `apps/node/coach-api/src/sectors/cns/events/instance-materializer.ts` — the
  materializer.
- **coach #235** (MERGED 2026-07-13) "bake group_track_map into the local seed" — seeds
  the demo district's `group_track_map` row (contentName derived from the tutor's own
  `content_instance`, not hand-authored, so map and instance can't drift).

### 2c. Multi-track / section-grain (the #448/#463 Phase 2a work) — MERGED
- **coach #230** (MERGED 2026-07-13) "cross-track completion read overlay (#448)" —
  completed modules shared across tracks stay complete when a user switches tracks.
- **coach #232** (MERGED 2026-07-13) "materialize ContentInstances at section grain
  (#448/#463 Phase 2a)" — reconcile now materializes both `district` and `section`
  grains.

---

## 3. IN-FLIGHT: Phase 2b — the tag/attribute-matching idea (the open playlisting frontier)

**coach PR #237 — OPEN (created 2026-07-14), branch
`worktree-coach-448-463-phase2b-content-tags`, author SethPaul.**
Title: *"feat(coach-api): content tag-filter narrowing + grain-rank resolution (#463
Phase 2b)."*

This is the direct implementation of **saga-dash #463** — "tag all content
(`required`/`optional`/`MS`/`HS`/`online`/`in-person`), give users attributes, resolve
the intersection instead of maintaining 4 hand-built playlists." From the PR body:
- **`filterContentByTags`** (new in `@saga-ed/coach-db`): pure pre-pass narrowing
  `nav`/`units` to tag-filter survivors, applied before shared `deriveTemplates`
  (keeps the coach-content CLI's unfiltered publish path untouched). Rules: empty
  filter = no narrowing; untagged module always survives (opt-in narrowing); a tagged
  module survives only if it carries **every** tag in the filter (AND-semantics).
- **Grain-rank resolution**: when a district and a section assignment collide on the
  same `content_name`, the section's `tagFilter` wins (flat rank, no org-hierarchy
  walk).
- **Update path**: an already-materialized instance converges its module rows to the
  current filter on next reconcile — a `tagFilter` change propagates with **no deploy**;
  `completed_module` rows are never touched.
- Test plan: 29 Postgres integration tests + 9 unit tests + full coach-api suite (317
  passing).

Precursor checkpoint commits already on branch/merged:
- `4c4f967` "feat(coach-db): schema for content tags (#463 Phase 2b, checkpoint)"
- `5ac5661` "feat(coach-api): tag-filter application + grain-rank resolution (#463 Phase
  2b)"

**Also open:** coach #233 (DRAFT) — a docs-only rds-gate runbook fix, unrelated.

### Driving issues (both in **saga-dash**, both OPEN, opened by product 2026-07-10)
- **saga-dash #448** (OPEN) — "Test: Coach module progress retained when switching Coach
  tracks" (requested by Tom Fischaber). Drives the cross-track completion overlay
  (coach #230).
- **saga-dash #463** (OPEN) — "Coach playlists: tag-based content + user attributes
  instead of maintaining 4 playlists (MS/HS × online/in-person)." Explicitly frames it
  as a **discussion kickoff, not a final design** — yet Seth has already shipped Phase
  2a and opened Phase 2b against it. He is **ahead of** the product conversation.

---

## 4. Seth's trajectory (from git history)

Reading `git log --author=Seth` on coach, the arc is a deliberate, multi-phase
re-platforming of coach content off the legacy shared Mongo onto coach-owned Postgres:

1. **Retire legacy dependencies** — abandon saga_api `session.context` S2S (coach #226),
   require iam-api auth + retire saga_api (coach #208), read identity direct from iam
   whoami.
2. **Two-store split** (planning: `claude/coach-content-two-store-plan.md`, DRAFT
   2026-06-17, authored by Seth "infra-platform lead"): read-only authored content vs.
   per-user mutable progress. Progress-store → Postgres first (Phase 1), content
   ingestion second (Phase 2).
3. **Content publish pipeline** (Phase 2): the `coach-content` CLI + immutable releases
   + atomic pointer flip (coach #202/#206/#207/#209/#234) — GitHub `content-archive`
   becomes the durable source of truth.
4. **Track resolution + multi-track** (Phase 2a): group_track_map, reconcile
   materializer, section grain, cross-track completion (coach #230/#232/#235).
5. **Tag/attribute matching** (Phase 2b, IN FLIGHT): coach #237 — the #463 vision.

A playlisting seeding effort fits this roadmap **exactly** — it is literally the current
head of it. There is no separate, competing port; this is the port.

The two-store plan also pins the data reality: current-year coach content lives in prod
Mongo `saga_blank` (`content_coach` = 8 structure docs — `base-coach`, `original-coach`,
`partners-coach`, `qtf-coach`, `preservice-coach`, `curriculum-coach`, `spring-pilot`,
`new-mexico-coach` — referencing 112 module `content_id`s). The archive is the richer
source; the 8 structure docs are the one gap being version-controlled directly.

---

## 5. Planning / doc artifacts in coach mentioning playlisting/tracks/content-ownership

- `claude/coach-content-two-store-plan.md` — the master strategy doc (Seth, DRAFT
  2026-06-17).
- `review_reports/coach-api/cross-api-plan.md` — enumerates the legacy `user_policy`
  playlist fields coach-api must own (`playlist_name`, `available_playlists`,
  `playlist_version`, `default_track`, `default_track_content`); "Coach-owned session"
  goal.
- `claude/coach-content-publish-workflow-scope.md` — the publish workflow scope (coach
  #209).
- `claude/coach-postgres-deploy-handoff.md`, `claude/coach-cold-start-runbook.md`,
  `claude/coach-rds-gate-runbook.md` — operational runbooks for the Postgres content
  store.
- `packages/node/coach-content-publish/README.md` — the CLI contract.
- `apps/web/coach-web/src/lib/types/coach.ts` — frontend `PlaylistData` interface
  ("Content playlist containing units and progress") — the one place coach *frontend*
  still uses the word "playlist" for the served track.

Legacy/dropped elsewhere (not coach): commons
`epic/flamingos/sprint-2/transition_2026_05_07.applied.md` shows *"fixture-cli: add coach
playlist support to named fixture profiles"* was **[drop]** (nimbee#8283, dropped) — i.e.
the old fixture-cli playlist-seeding path was abandoned in favor of the coach-owned
pipeline. student-data-system `sds_67` and rostering runbooks reference seeding a
"partners-coach playlist" via the legacy bootstrap — the world coach-api is replacing.

---

## 6. Answers to the four questions

1. **Existing coach code doing part of playlisting?** Yes, substantially. The
   `@saga-ed/coach-content-publish` CLI (`coach-content` — status/diff/publish/rollback/
   materialize) is the content-seeding pipeline; `group_track_map` + reconcile
   materializer + `content_instance` model is the track-resolution ("which playlist")
   layer; both merged to main. What's still "only legacy" is the **saga_api/nimbee
   `user_policy` playlist fields** (`playlist_name`, `available_playlists`) that coach-api
   plans to serve from its own session endpoint (cross-api-plan) but hasn't fully cut
   over — and the 8 real `content_coach` structure docs, being version-controlled into
   the archive.

2. **In-flight PR/branch/issue porting/reimplementing playlisting?** Yes — **coach PR
   #237 (OPEN, 2026-07-14)**, branch `worktree-coach-448-463-phase2b-content-tags`,
   author SethPaul: content tag-filter narrowing + grain-rank resolution, implementing
   saga-dash **#463**. Merged precursors: #230, #232, #235 (2026-07-13); #202/#206/#207/
   #209/#234 (2026-07-09→13). Driving issues saga-dash #448 and #463 (both OPEN,
   2026-07-10).

3. **Seth's trajectory / roadmap fit?** A clean multi-phase re-platforming of coach
   content onto coach-owned Postgres (two-store plan → publish CLI → track resolution →
   section grain → tag matching). A playlisting seeding effort is the **current head of
   this roadmap**, not adjacent to it. The #448/#463 section-grain / cross-track / tag
   work is exactly the frontier.

4. **Docs/planning artifacts?** Yes — see §5: `coach-content-two-store-plan.md`,
   `cross-api-plan.md`, `coach-content-publish-workflow-scope.md`, the publish CLI
   README, plus operational runbooks. They collectively describe coach owning content
   end-to-end.

---

## 7. Bottom line for gh_305

**We would be joining an effort already underway, not building net-new.** Seth has
already ported the CLI-driven content-seeding pipeline (`coach-content`) and the
track-resolution model into coach-api, and is actively landing the tag/attribute-matching
layer (PR #237, open today). Any gh_305 concierge/seeding step for coach content should
**build on `@saga-ed/coach-content-publish` and `group_track_map`**, coordinate with Seth
on the open #463 Phase 2b, and treat saga-dash #448/#463 as the live driving issues.
Confirm with Seth whether the legacy `user_policy` playlist-field cutover (cross-api-plan
§ session endpoint) is in scope or deferred — that's the one piece still straddling the
legacy stack.

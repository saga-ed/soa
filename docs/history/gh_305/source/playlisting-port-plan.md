# Sibling plan — coach owns "playlisting" (REFRAMED after research)

_Sibling to the `ss develop` plan (`plan.md`). Evidence: `../research/07`, `08`, `09`._

## ⚠️ Premise correction (read first)

The ask was "port the playlisting functionality **out of saga-dash** and into coach-api." Three
independent research passes converge on a correction:

1. **saga-dash has zero playlisting code.** Grep for `playlist`, `playlist_name`,
   `available_playlists`, `group_track_map`, `content_name`, `content_release`, `ContentInstance`
   across saga-dash apps/packages **and full history** returns nothing (2 unrelated "materialized"
   false positives). There is nothing in saga-dash to move.
2. **"Playlist" is legacy `saga_api`/nimbee terminology**, living in the rostering/iam **policy**
   layer: `user_policy.{playlist_name, available_playlists, playlist_version, default_track}` and the
   iam policy key `coach:coach_playlist_name` (rostering `permission_policy_registry.md`; consumers
   listed as *nimbee, coach*). `saga_api` isn't checked out locally, so its internals are
   documented-only.
3. **coach-api has ALREADY re-platformed it, and it's ~80% shipped — all by Seth.** The CLI-driven,
   no-UI seeding pipeline you remember now lives in the **coach repo** as
   `@saga-ed/coach-content-publish` (bin `coach-content`), backed by the `group_track_map` table
   (schema comment: *"Replaces the dead saga_api path"*) + the reconcile materializer.

**So this is not a from-saga-dash port. It is: join an effort already underway in coach, finish two
small coach-owned pieces, and add the seeding hook `ss develop coach` needs.** saga-dash leaves the
loop entirely (it was never in it).

## The legacy → coach-api mapping

| Legacy (`saga_api`/nimbee `user_policy`) | coach-api today |
|---|---|
| `playlist_name` / active playlist | `content_name` — a **track**; `content_instance(user_id, content_name)` |
| group/district → which playlist | **`group_track_map`** (`group_id → content_name`) |
| `DEFAULT_TRACK_NAME` fallback | `DEFAULT_CONTENT_NAME = 'base-coach'` |
| playlist authoring / seeding CLI | **`coach-content`** CLI (`publish`/`materialize`/`rollback`/…) |
| tag/attribute matching (aspirational) | `tagFilter` + `filterContentByTags` — **in flight, PR #237** |

## What already exists (merged on coach `main`)

- **The content-publish CLI** = the CLI-driven seeding pipeline: `coach-content
  status|diff|publish|rollback|materialize`, Prisma → `coach_api` Postgres, source =
  `saga-ed/content-archive`. `materialize` shares `deriveTemplates` with coach-api's live reconcile,
  so CLI seeding and event materialization can't drift. (coach #202/#206/#207/#209/#234)
- **Track resolution**: `group_track_map` + reconcile materializer joins `persona_assignment →
  group_track_map` and materializes the tutor's `content_instance` (fallback `base-coach`). (coach
  #235 bakes it into the local seed; #230 cross-track completion; #232 section-grain #448/#463 Phase
  2a)

## In-flight (Seth, opened 2026-07-14 — coordinate, don't collide)

- **coach PR #237 (OPEN)** — `feat(coach-api): content tag-filter narrowing + grain-rank resolution
  (#463 Phase 2b)`. Implements saga-dash **#463** (tag content + user attributes, resolve the
  intersection instead of maintaining 4 hand-built playlists).
- **Driving product issues (both OPEN):** saga-dash **#448** (track-switch progress retention) and
  **#463** (tag-based playlists). #463 is framed as a discussion kickoff — Seth is *ahead* of it.

## The genuine remaining "into coach-api" work (the real, small port)

1. **Legacy `user_policy` selection cutover.** coach-api's `cross-api-plan.md` (§ session endpoint)
   still lists the legacy `user_policy` playlist fields coach-api intends to own. Confirm with Seth
   whether retiring coach-api's last cross-api dependence on `saga_api` playlist *selection* (resolve
   fully from `group_track_map` / iam policy) is **in scope or deferred**. This is the only piece
   still straddling the legacy stack.
2. **A coach-owned assignment writer.** Verified gap: **nothing writes `group_track_map` in
   production** — only `db:seed` writes it; reconcile only reads it. The live "which playlist" signal
   is the iam policy `coach:coach_playlist_name`, with **no projector into coach**. To own playlisting
   end-to-end, coach needs one of: (a) an **iam-policy → `group_track_map` projector** (event-driven,
   matches the existing iam-projection-handlers pattern) for live parity, and/or (b) a **`coach-content
   playlist assign --group <g> --content <track>` CLI verb** that writes `group_track_map` (the
   dev/seed path). Keep it **CLI-driven, no UI** — add a `playlist` subcommand group to the existing
   `coach-content` CLI (`src/playlist.ts` beside `src/store.ts`), surfaced from coach-api via a
   delegating `package.json` script (precedent: `db:seed:run`). **Do not add a new package; do not
   read saga-dash/`saga_api` `user_policy` at runtime** (would re-couple coach and violate its domain
   boundary).

## How this unblocks `ss develop coach`

- **`--scenario content-viewer` (primary): needs NOTHING new.** `db:seed` already lands a working
  track + a materialized `demo-tutor-1` instance; the viewer renders today (once soa#300 is fixed).
- **`--scenario playlist`: blocked today** — only one track (`spring-pilot`) is seeded and there's no
  coach-owned way to switch a persona's track. After item 2b, the one-command local path is:
  `db:seed` → `coach-content publish` a 2nd track → `coach-content playlist assign --group
  <demo-district> --content track-2` → `coach-content materialize --user demo-tutor-1 --content
  track-2 --replace`; `develop coach` wraps those, `devLogin`s demo-tutor-1, opens coach-web on the
  chosen playlist — all inside coach.

## Proposed scope (recommendation)

- **Option A (minimal, recommended now):** add the `coach-content playlist assign` verb (writes
  `group_track_map`) + seed/publish a 2nd track. Pure coach, no legacy cutover, **directly unblocks
  `develop coach --scenario playlist`**. Small, ships fast, non-colliding with PR #237.
- **Option B (the "real" port):** A **+** the legacy `user_policy` selection cutover / iam-policy
  projector for live production parity. Bigger, spans the cross-api-plan, gated on Seth + product
  (#463).

Recommend **A now** (it's the piece `develop` actually needs), track **B** as a coach-repo follow-up
coordinated under saga-dash #448/#463 and Seth's #237.

### ✅ DECISION (2026-07-14): Option A locked (Sean)

Scope for this effort = **Option A**. Concretely:
1. **`coach-content playlist assign --group <groupId> --content <content_name>`** — a new `playlist`
   subcommand group on the existing `@saga-ed/coach-content-publish` CLI (`src/playlist.ts` beside
   `src/store.ts`); writes/upserts a `group_track_map` row via Prisma → `coach_api` Postgres. No new
   package. No UI. Likely companions: `playlist list` (show current group→track map) and
   `playlist unassign`. Surface from coach-api via a delegating `package.json` script (precedent
   `db:seed:run`). **Must not read `saga_api`/saga-dash `user_policy` at runtime.**
   **Writes ONLY the `group_id → content_name` track mapping** (Sean, 2026-07-14) — it does **not**
   set `tagFilter` or grain; those stay owned by coach PR #237's Phase 2b path, so the verb is
   strictly additive to Seth's work.
2. **Seed/publish a 2nd track** so a persona can be switched between ≥2 playlists locally (seed ships
   only `spring-pilot` today).
3. Wire the one-command local seeding path into `ss develop coach --scenario playlist`
   (publish 2nd track → `playlist assign` → `materialize --replace`).

**Out of scope (deferred to Option B / follow-up):** the legacy `user_policy` selection cutover and
the iam-policy (`coach:coach_playlist_name`) → `group_track_map` projector for live prod parity.

**Build dependency (question 3) — RESOLVED (Sean, 2026-07-14):** `playlist assign` writes **only**
the `group_id → content_name` mapping and leaves `tagFilter`/grain to coach PR #237. The verb is
therefore additive to Seth's Phase 2b by construction, and the #237 seam no longer blocks the design.
Issue-filing is now fully ready — held only pending an explicit "file it" (outward-facing action that
tags Seth) or Seth's ack that we're not duplicating something in-flight.

## Open questions for Seth (we've pinged him; these are the specifics)

1. Is the legacy `saga_api` `user_policy` playlist-selection cutover (cross-api-plan § session
   endpoint) in your scope, or deferred?
2. Do you want a coach-owned `group_track_map` writer — an iam-policy (`coach:coach_playlist_name`)
   projector for live parity, a `coach-content playlist assign` CLI verb for dev/seed, or both?
3. Does PR #237 (Phase 2b tag-filter) reshape the assignment seam in a way a `playlist assign` verb
   should account for?

## Where the issue should live / status

- **coach repo** (this is coach-api work), coordinated under the existing saga-dash #448/#463 and
  Seth's #237 — **not** a soa issue, and **not** a "saga-dash port."
- **HOLDING on filing.** Draft issue body is ready (Option A). File once Seth confirms scope, to
  avoid duplicating/colliding with #237.

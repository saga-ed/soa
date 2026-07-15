# Research 09 — coach-api as the target landing zone for a ported "playlisting" CLI

**Effort:** ss `develop` coach concierge (saga-ed/soa#305)
**Question:** Where does a port of saga-dash "playlisting" LAND in the coach repo so
coach owns its content pipeline end-to-end — kept CLI-driven, no UI? What is reuse
vs new, where does the input come from, and how does it unblock `ss develop coach`?
**Repos read:** `/home/skelly/dev/coach` (coach-api, coach-content-publish, coach-db),
`/home/skelly/dev/rostering` (iam-db registry/seed), `/home/skelly/dev/saga-dash`.
**Date:** 2026-07-14

---

## Headline

The port is **reuse-heavy**. Coach already owns the entire *content* half of
playlisting — authoring→publish→release rows→materialize→instance — as a mature,
CLI-driven pipeline (`coach-content`). What coach does **not** yet own is the
*playlist-assignment* half: the decision "which group/tutor gets which track" and
"what content composes a track." Today that decision is an **iam policy value**
(`coach:coach_playlist_name`) sourced from legacy `saga_api`'s `user_policy`, and it
reaches coach only as a **hand-seeded `group_track_map` row** — there is **no
production write-path in coach that turns a playlist assignment into a
`group_track_map` row** (VERIFIED GAP, see §2/§3). The port's real new surface is a
thin CLI that writes `group_track_map` (assignment) and, optionally, composes a
track by tag-filter (definition, = coach's deferred Phase 2b).

**The landing zone is the existing `@saga-ed/coach-content-publish` package** — add a
`playlist` subcommand group to its `coach-content` CLI. That is the exact harness,
DB-access pattern, and idempotency model a ported playlisting CLI needs, already
built. No oclif, no new bin scaffolding.

> **Naming caveat for the orchestrator:** the task says playlisting is "currently in
> saga-dash." The local `saga-dash` checkout has **zero** playlist code
> (`grep -rli playlist` over `saga-dash/{apps,packages}` → empty). Playlisting lives
> in **legacy `saga_api`** (the nimbee/PHP monolith) and survives in the fleet only as
> the iam policy `coach:coach_playlist_name` (rostering `iam-db/src/registry.ts:159`,
> default `'coach'`; seeded `'base-coach'` for the district tutor). Treat "port
> playlisting" as "port the legacy `saga_api` playlist-resolution concept," not "move
> a saga-dash module."

---

## 1. Where a playlisting CLI physically lives + what runs it

### The harness (concrete)
Coach has **no oclif / no CLI framework and no `bin/` dir in coach-api**. One-off jobs
run one of two ways, both delegating from a `coach-api` `package.json` script to a
workspace package:

- `coach-api` `package.json:scripts` → `db:deploy` = `pnpm --filter @saga-ed/coach-db db:deploy`;
  `db:seed:run` = `pnpm --filter @saga-ed/coach-db db:seed`
  (`/home/skelly/dev/coach/apps/node/coach-api/package.json`).
- **The canonical CLI precedent to copy** is `@saga-ed/coach-content-publish`
  (`/home/skelly/dev/coach/packages/node/coach-content-publish`): a workspace package
  with `"bin": { "coach-content": "./dist/cli.js" }`, built by `tsup`, whose
  `src/cli.ts` is a plain `node:util` `parseArgs` dispatcher that gets a Prisma client
  via `getPrisma()` from `@saga-ed/coach-db` and selects the target Postgres with
  `DATABASE_URL`. ~230 lines, no framework. Exit codes `0/1/2`.

### Recommended landing spot
**Extend the existing `coach-content` CLI**, do NOT create a new package. Add a
`playlist` command group in
`/home/skelly/dev/coach/packages/node/coach-content-publish/src/cli.ts`
(new `src/playlist.ts` store module beside `src/store.ts`). Rationale:

- Playlisting is *the same DB, the same release/instance tables, the same
  idempotency contract* as publish/materialize — `group_track_map`, `content_release`,
  and `content_instance` all live in `coach-db`'s Prisma schema, which this package
  already imports. A sibling package would duplicate the `getPrisma()`/tsup/bin wiring
  for zero benefit.
- `coach-content` already owns `materialize` (a "dev/e2e helper" that is exactly a
  playlist-instantiation step). `playlist` sits naturally next to it.

Then surface it from coach-api the way `db:seed:run` is surfaced — add a
`coach-api` `package.json` script, e.g.
`"playlist": "pnpm --filter @saga-ed/coach-content-publish exec coach-content playlist"`,
so `ss` (and humans) invoke `pnpm --filter @saga-ed/coach-api playlist assign …`.

**Closest precedent to copy, file by file:**
| Concern | Copy from |
|---|---|
| bin + parseArgs dispatcher + exit codes | `coach-content-publish/src/cli.ts` |
| Prisma-through-`getPrisma()`, tx, idempotent writes | `coach-content-publish/src/store.ts` |
| group_track_map row shape + derivation | `coach-db/src/seed/persona-projections.ts` (`groupTrackMaps`, `GroupTrackMapRow`) |
| track→instance derivation (shared, must not drift) | `coach-db/src/content/derive-templates.ts` (`deriveTemplates`) |
| delegating package.json script | `coach-api/package.json` `db:seed:run` |

---

## 2. What coach ALREADY does (reuse, not rebuild) — the seam

Coach owns the whole content half already. The pipeline and the exact tables:

```
                    ┌───────────────────────── coach owns ALL of this today ─────────────────────────┐
content-archive     coach-content publish            group_track_map            coach-content materialize
  checkout    ──►   (createRelease, store.ts)   ──►   (group → content_name) ──► (deriveTemplates)     ──► coach-web
  (git sha)         content_release (+curricula      = "which track a group's   content_instance          renders
                     +polls) + atomic active          tutors get")               (+_module/_completed)     dashboard
                     pointer flip
        │                    │                                │                          │
   PLAYLIST DEFINITION   RELEASE ROWS                 PLAYLIST ASSIGNMENT          INSTANCE (section-grain,
   (what content is       (immutable snapshot          (group→track binding)        PRs #448/#463)
    in the track)          = a track version)
```

Concretely, already-built and reusable verbatim:

1. **Publish → `content_release` rows.** `coach-content publish --archive <checkout>
   --ref <sha> --approve` (`cli.ts` `publish` case → `store.ts#createRelease`) inserts a
   release + curricula + polls in one tx and atomically flips the `active_content_release`
   singleton pointer. A **release *is* a track version**; a `content_release_curriculum`
   row keyed by `name` **is** a playlist/track (`content_name`). No coach-api deploy —
   readers join through the pointer (60s subject cache).
2. **Materialize → `content_instance`.** `coach-content materialize --user <id>
   --content <name>` (`store.ts#materialize`) derives a per-user instance from the ACTIVE
   release via the **shared** `deriveTemplates` (`coach-db/src/content/derive-templates.ts`)
   — the *same* function coach-api's event-driven reconcile materializer uses, so the CLI
   path and the live path cannot drift. This is section-grain (`ContentInstance`, PRs
   #448/#463).
3. **`group_track_map` READ path.** coach-api resolves which track a tutor materializes
   by joining `persona_assignment ⋈ group_track_map` **on `groupId` alone** in
   `PostgresAssignmentStore` (`src/sectors/cns/assignments/`), and the reconcile
   materializer looks up `SELECT content_name FROM group_track_map WHERE group_id=$1`
   (`src/sectors/cns/events/iam-projection-handlers.ts:~210`), falling back to
   `DEFAULT_CONTENT_NAME='base-coach'` when unmapped.
4. **`group_track_map` SEED write.** `coach-db db:seed` writes one demo-district row via
   `groupTrackMaps(contentName)` (`persona-projections.ts`), pointing the demo district at
   the seeded tutor's own track so map and instance can't drift.

**Reuse seam (one line):** `playlisting-input → coach-content publish (content_release rows) →
group_track_map (group→content_name) → coach-content materialize (content_instance) →
coach-web`. Everything except the **write of the `group_track_map` binding** (and, for
tag-composed tracks, the *definition* of what content is in a track) already exists.

---

## 3. What is NEW (the parts only legacy/saga_api has today)

The port must add the **assignment half**. Two pieces, in priority order:

1. **Playlist ASSIGNMENT — write a `group_track_map` row (the load-bearing new piece).**
   VERIFIED GAP: nothing in coach writes `group_track_map` in production. `reconcile`
   only *reads* it; the only *writer* is the offline `db:seed`. In the live fleet the
   assignment lives as the iam policy `coach:coach_playlist_name` on a persona
   (rostering `iam-db/prisma/seed.ts:~919`, tutor → `'base-coach'`), and there is **no
   projector** turning that policy into a `group_track_map` row (searched coach-api
   `src/sectors/cns/events/*` — the iam projection handlers project
   `persona_assignment`/`persona_definition`, NOT the playlist policy). So the port's
   core new code is a CLI verb (and, for parity with live, eventually an iam-policy →
   `group_track_map` projection) that **upserts `(group_id, group_kind, content_name)`**.
   This is small — a Prisma upsert mirroring `groupTrackMaps()` — but it is the piece
   that makes coach self-sufficient.
2. **Playlist DEFINITION — compose a track from tags/attributes (coach's deferred Phase 2b).**
   Legacy maintained **4 hand-authored playlists** (MS/HS × online/in-person); saga-dash#463
   (OPEN) moves to *tag-based* content selection. Coach-api's own comments call this the
   **Phase 2b tag-filter resolver that replaces the direct `group_track_map` lookup** and
   explicitly say it is NOT built (`iam-projection-handlers.ts` SECTION_GROUP_KIND doc:
   "True 'section narrows district's content set' is Phase 2b's job … do not attempt it
   here"). If the port wants real playlist *authoring* (not just assignment of
   already-published tracks), this is the new logic: select a subset of a release's
   content by tag → publish it as a named track. For a **v1 CLI-driven port this can be
   deferred** — treat each published `content_name` as a pre-composed playlist and only
   build the assignment verb.

Everything else the legacy playlist flow did (instantiate the chosen track for a user)
is already `materialize`.

---

## 4. Input-source decision (where playlisting input comes from post-port)

Two distinct inputs; keep them separate:

- **Content/track DEFINITION input → a `content-archive` checkout, via `coach-content
  publish`.** This is already the model and the durable source of truth (GitHub archive
  → publish → release rows). For dev, `coach-db db:seed` loads an **offline twin** release
  (`fixtures/content-release.json`) so no archive checkout is needed. Recommendation:
  **coach-db seed fixture for the default dev path; content-archive checkout only for
  real/legacy-parity tracks.** No saga-dash and no coach-db of saga-dash is involved.
- **Playlist ASSIGNMENT input → a coach-owned config, NOT a saga-dash read.** The
  assignment (`group → content_name`) must come from something coach owns. Ranked:
  1. **CLI args** (`--group <id> --content <name>`) for interactive dev — matches how
     `materialize` already takes `--user/--content`. [recommended for the CLI port]
  2. **coach-db seed** (`groupTrackMaps`) for the baseline — already exists.
  3. **iam policy projection** (`coach:coach_playlist_name` → `group_track_map`) for
     eventual live parity — the durable answer, but out of scope for a CLI-first port.

  It must **not** read a saga-dash DB or `user_policy` at runtime — that would re-couple
  coach to saga-dash, the opposite of the port's goal, and violates coach-api's stated
  domain boundary (coach treats `groupId` as "an opaque mapping key, not org logic").

**Net:** post-port, coach's inputs are (a) a content-archive checkout *or* the coach-db
seed fixture (definition) and (b) CLI args *or* the seed (assignment). saga-dash leaves
the loop entirely.

---

## 5. Proposed CLI command signature

Add to the existing `coach-content` CLI (mirrors its `status/diff/publish/materialize`
verbs, `parseArgs`, exit codes, `DATABASE_URL`-selected Postgres):

```bash
# ── assignment (the load-bearing new verb; upserts a group_track_map row) ──
coach-content playlist assign --group <groupId> --content <content_name> [--kind district|section]
coach-content playlist unassign --group <groupId>
coach-content playlist list                      # active release's tracks (content_names) ⋈ their group_track_map bindings

# ── definition (Phase 2b; optional for v1 — compose a named track by tag) ──
coach-content playlist define --name <content_name> --from-tags <tag,...>   # NEW resolver; or --from-archive-doc <name>

# ── already exists, reused as the instantiate step ──
coach-content materialize --user <id> --content <content_name> [--replace]
```

A full "switch a persona's playlist" dev flow becomes three existing/near-existing calls:
`publish` (or seed) a 2nd track → `playlist assign --group <demo-district> --content <track-2>`
→ `materialize --user demo-tutor-1 --content track-2 --replace`.

---

## 6. How this unblocks `ss develop coach`

The `develop coach --scenario playlist` path (plan.md scenario 5) is blocked today
because **only one track (`spring-pilot`) is seeded and there is no way to switch which
playlist a persona resolves without saga-dash / legacy `user_policy`.** After the port:

**One-command local seed of switchable coach content, saga-dash out of the loop:**
```bash
# baseline (exists today): brings up coach-api pg + curriculum + one track + instance
pnpm --filter @saga-ed/coach-db db:seed

# NEW, enabled by the port — add a 2nd track and flip the assignment, no saga-dash:
coach-content publish  --archive <checkout|fixture> --ref <sha> --approve   # or a 2nd seed track
coach-content playlist assign --group <deriveGroupId('demo')> --content <track-2>
coach-content materialize --user <demo-tutor-1 id> --content track-2 --replace
```
`ss develop coach --scenario playlist` then wraps exactly these steps as a concierge
flow (the plan's M3/M4), `devLogin`s as `demo-tutor-1@saga.org`, and opens coach-web —
the developer sees the *chosen* playlist drive the rendered content, and can iterate on
playlist assignment purely inside the coach repo. That self-sufficiency (coach seeds and
switches its own playlists) is the concrete unblock: `develop coach` no longer needs
saga-dash or legacy `saga_api` to demonstrate playlisting.

For the **primary** `--scenario content-viewer`, nothing new is even required — `db:seed`
already lands a working track+instance; the port matters specifically for the
`--scenario playlist` (and multi-tutor `--admin`) scenarios that need ≥2 tracks and a
switch.

---

## Unknowns / flags for the orchestrator

- **VERIFIED GAP (high-confidence):** no coach production write-path for `group_track_map`
  exists — only `db:seed` writes it and `reconcile` reads it. The iam
  `coach:coach_playlist_name` policy is defined (rostering registry) but I found **no
  projector** consuming it into coach. The port's assignment verb fills a real hole, not
  just a dev convenience.
- **"playlisting currently in saga-dash" is imprecise** — no playlist code in the local
  saga-dash checkout; the concept is legacy `saga_api` + the iam policy. Confirm with the
  team lead whether the port target is "legacy saga_api playlist resolution" (assumed
  here) or a specific saga-dash surface I couldn't locate.
- **Definition (Phase 2b tag-filter) scope** is a product decision (mirrors plan.md open
  decision #1): v1 can treat each `content_name` as a pre-composed playlist and ship only
  the assignment verb; real tag-based authoring (saga-dash#463) is a larger, separate build.
- **group_kind on assign:** `group_track_map` join is on `groupId` alone (kind-agnostic on
  read), but coach materializes only `district`+`section` kinds — the `--kind` flag should
  default to `district` to match the seed.

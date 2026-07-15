# Research 03 — Coach admin dashboard & playlisting (prompt-2 scenarios 4 & 5)

**Effort:** ss `develop` coach concierge (saga-ed/soa#305)
**Area:** the two *secondary* coach surfaces — (4) "the admin dashboard that
currently ships with the coach repo" and (5) "the interface for playlisting".
**Author repos read:** `/home/skelly/dev/coach`, ss CLI at
`packages/node/saga-stack-cli`, plus GitHub (`saga-ed/coach`, `saga-ed/saga-dash`).
**Date:** 2026-07-14

---

## Headline

Neither secondary surface is a distinct app; both live inside the SvelteKit
`coach-web` monorepo (or its plumbing), and **neither is a finished, live-backed
UI today**:

- **"Admin dashboard" = the Coach *Reports* surface** — an org-wide "Admin Report"
  table of tutors × unit completion (plus a per-tutor progress view and a
  progress-detail modal). It is a **route inside `coach-web`** (`/reports` and an
  embedded `/embed/reports/coach`), not a separate app, and **View 1 currently
  renders from MOCK data**, not from the (existing) coach-api resolvers or the seed.
- **"Playlisting" has NO dedicated UI in the coach repo.** In coach, a *playlist* ==
  a *track* == a `content_name` == a published content archive/release. The
  *selection/assignment* of a playlist to a tutor is a **saga-dash / rostering**
  concern (`user_policy.playlist_name` / `available_playlists`) projected into
  coach-api via the `group_track_map` table. The coach repo only owns the
  *authoring→publish→materialize* CLI pipeline that produces the tracks, and the
  reconcile logic that maps a district group → a track.

A builder should treat scenario 4 as **"log in as the district-admin persona and
land on `/reports`"** and scenario 5 as **"stand up ≥2 tracks and a
`group_track_map` / policy so a persona resolves to a chosen playlist"** — see the
concrete requirements and the open questions at the end (both surfaces are
partly aspirational relative to prompt-2's wording).

---

## Context: what coach-web actually is today

`coach-web` (SvelteKit, client-only SPA, `ssr=false`) is a **tutor-facing** rebuild.
Nav (`apps/web/coach-web/src/lib/ui/Navbar.svelte:23-29`) exposes: Dashboard `/`,
Explore `/explore`, **Reports `/reports`**, My Progress `/my-progress`, Widget
Gallery. There is **no `/admin` and no `/playlist(s)` route** — confirmed by
`find apps/web/coach-web/src/routes -type d` (routes: embed, reports, timer,
widget-gallery, explore, todos, my-progress, up-next, units, coach-api-test).

Auth is **always required** (no dev-bypass): root layout
`apps/web/coach-web/src/routes/+layout.ts` fetches an iam session then a single CNS
content-instance; `data.instance = instances[0]`. A user with no instance gets an
empty state (in-flight PR #236 `fix/coach-dashboard-no-track-empty-state`).

Mesh ports (ss manifest `packages/node/saga-stack-cli/src/core/manifest`):
- `coach-web (:8800)` — SvelteKit SPA, reaches iam THROUGH coach-api
  (`src/core/manifest/types.ts:28`)
- `coach-api (:6105)` — GraphQL/tRPC (`types.ts:27`, `services.ts:475`)
- coach's Postgres app DB `coach_api` (mesh :5432; coach-db's own default is :5433)
- iam-api :3010 (devLogin mints `iam_session`)

---

## Scenario 4 — the "admin dashboard" (Coach Reports)

### What it is / what it administers
Three views over tutor coaching progress (types in
`apps/web/coach-web/src/lib/types/reports.ts`, api in
`apps/web/coach-web/src/lib/api/reports.ts`):
- **View 1 — Admin Report:** org-wide table, rows = tutors, columns = units, cells =
  modules-complete/total. Backend query `coachReport(content_name)`.
- **View 2 — Tutor Progress:** one tutor's unit-level progress —
  `userCoachProgress(user_id)`.
- **View 3 — Progress Detail modal:** module-level detail —
  `coachProgressDetail(user_id, instance_id)`.

### Where it lives (files — all inside coach-web, a ROUTE not an app)
- Standalone page: `apps/web/coach-web/src/routes/reports/+page.svelte` +
  `+page.ts` (reads `?org=` query param, default `'Direct Test Org'`).
- Embedded (into saga-dash): `apps/web/coach-web/src/routes/embed/reports/coach/+page.svelte`
  + `+page.ts` — filters `org`, `programId`, **`trackId`**, `search` from query params.
- Reusable component: `apps/web/coach-web/src/lib/reports/CoachReport.svelte`.
- Feature parts: `apps/web/coach-web/src/lib/features/reports/{ReportHeader,CoachReportTable,ProgressCell}.svelte`
  and `apps/web/coach-web/src/lib/features/coach-progress-modal/CoachProgressModal.svelte`.

### CRITICAL status caveat — View 1 is MOCK-backed today
`CoachReport.svelte:13` imports `reportsStore` from
`apps/web/coach-web/src/lib/stores/reports.ts`. That store's `fetchReport()`
(line ~57) calls `getMockReport(orgName)` from `$lib/data/mock-reports` — **not**
the real GraphQL. The `organizations` dropdown is also mock (`getMockOrganizations`).
Only `fetchUserProgress` / `fetchProgressDetail` in that same store call the *real*
`api/reports.ts` functions (`GetUserCoachProgress` / `GetCoachProgressDetail`).

So: the org-wide admin table **renders with zero live seed today**; wiring it to
real data means pointing `reportsStore.fetchReport` at
`api/reports.ts#fetchCoachReport` (`coachApi.GetCoachReport`) — which already exists
and works against coach-api.

### Backend (exists, real)
Resolvers: `apps/node/coach-api/src/sectors/reports/gql/reports.resolver.ts`
(`coachReport`, `userCoachProgress`, `coachProgressDetail`). Data service
`reports.data.ts#getCoachReport` builds the report purely from CNS:
`getContentByName(content_name)` → `getAssignmentsByContentName` → 
`getContentInstancesByUserIdsAndContentName`. **No authz / role check** in the
resolver; `content_name` is the *track*. `first_name/last_name/email` come back as
placeholders (`''`/`null`) — names are not populated by this path.

### Roles / personas / data it needs
- The nav shows "Reports" to everyone; the "admin" framing is UI-only, **not
  code-gated**.
- The seed ships an **elevated persona specifically for this**:
  `demo-dadmin@saga.org` (`personaAdminDemo`, district admin) exists "to exercise
  the elevated-UI (district admin) persona" — see
  `packages/node/coach-db/src/seed/persona-projections.ts:19-21,104-105,143-145`.
  Both tutor and admin personas carry `coach:access_coach_app`.
- To back **View 1 with real data** you need, for one `content_name`: a published
  content release, **multiple users assigned** to it, and content instances
  (progress) for them. The committed seed only materializes ONE tutor
  (`demo-tutor-1`) on ONE track (`spring-pilot`), so a live admin table would show
  a single row — a `--admin` scenario likely wants extra seeded tutors/assignments.

### `develop coach --admin` shape (concrete)
Stack up (coach-api + coach-web + iam-api + Postgres) → coach-db seed →
`devLogin` as **`demo-dadmin@saga.org`** → open `coach-web` at **`/reports`** in the
foreground. Works today against MOCK data with no extra seed; live data needs the
rewire above + multi-user seed.

---

## Scenario 5 — the "interface for playlisting"

### What "playlist" means in coach
A **playlist == a track == a `content_name`** — a published content archive
release (a coherent set of units/modules a tutor works through). Direct evidence:
- `saga-ed/saga-dash#463` (OPEN): *"Coach playlists: tag-based content + user
  attributes instead of maintaining 4 playlists (MS/HS × online/in-person)"* — i.e.
  historically **4 hand-maintained playlists**, keyed by grade band × modality.
- coach's user policy carries the coach-specific fields **`playlist_name`,
  `available_playlists`, `playlist_version`** on `user_policy` (documented in the
  coach-api cross-API review: `review_reports/coach-api/cross-api-plan.md:77,97-99,216-218,385-387`
  and `ISSUES.md:668`). `user_policy` is a **rostering / saga-dash** projection,
  forwarded to coach on the auth cookie.
- `apps/web/coach-web/src/lib/types/coach.ts:49-51` — `PlaylistData` = "Content
  playlist containing units and progress" (i.e. the tutor's assembled track).

### The coach-side mechanism: `group_track_map`
coach-api resolves *which track a tutor materializes* from a third iam→coach
projection table, `group_track_map` (district group → `content_name`):
- `apps/node/coach-api/src/sectors/cns/events/iam-projection-handlers.ts`:
  `DISTRICT_GROUP_KIND='district'` (:49), `DEFAULT_CONTENT_NAME='base-coach'` (:118),
  fallback `contentName = mappedName ?? DEFAULT_CONTENT_NAME` (:213). A district
  **not** in `group_track_map` silently falls back to `base-coach`, and the
  assignment read path returns an empty page for it.
- Seeded by `packages/node/coach-db/src/seed/persona-projections.ts#groupTrackMaps`
  and written in `local-snapshot.ts:158-171` (points the demo district at the
  track the seeded tutor's own instance is on, so map and instance can't drift).

### Is there a playlisting UI in the coach repo? — NO
- No `/playlist` route; `/explore`
  (`apps/web/coach-web/src/routes/explore/+page.svelte`) is the *tutor's own*
  module browser/skill-filter **within their instance**, not a playlist-assignment UI.
- The **assignment/selection** interface (which playlist a tutor gets) is a
  **saga-dash / rostering** surface (`user_policy.playlist_name` /
  `available_playlists`); issue #463 lives in `saga-ed/saga-dash`, **not** coach.
  This *contradicts prompt-2's* "interface for playlisting that ships with the
  coach repo" — flagged as an open question.
- What the coach repo DOES own is the **authoring→publish pipeline** that produces
  tracks (see below). That is the closest thing to "playlisting" inside coach, but
  it is **CLI-driven, no web UI**.

### The content authoring / publish pipeline (coach-owned, CLI)
`@saga-ed/coach-content-publish` — binary **`coach-content`**
(`packages/node/coach-content-publish/src/cli.ts`). Commands:
`status | diff | publish --archive <path> --ref <sha> [--approve] [--structure-overlay <dir>] | rollback --to <releaseId> --approve | materialize --user <id> --content <name> [--replace|--delete]`.
`DATABASE_URL` selects the coach_api Postgres. Publishes archive content into
Postgres as immutable **snapshot releases** (= track versions); `materialize`
builds a per-user `content_instance` from a release.
Full pipeline (legacy author → archive → publish → materialize → dashboard) is
documented in `apps/web/coach-web/e2e/authoring/README.md`. There is a gated
Playwright `authoring` project (`E2E_AUTHORING=1`, `pnpm test:e2e:authoring`) that
exercises it end-to-end — but that is *flow testing*, not a develop surface.

### `develop coach --playlist` shape (concrete)
The developable target is the **track/policy plumbing**, not a page:
publish/seed **≥2 tracks** (content_names), set `group_track_map` (or the
saga-dash `user_policy.playlist_name` / `available_playlists`) so a persona
resolves to a chosen playlist, `materialize` the instance, then `devLogin` +
open the dashboard to see the selected playlist drive the rendered content. The
committed seed only has **one** track (`spring-pilot`) — a `--playlist` scenario
must add tracks and a switchable mapping.

---

## Seed & run — concrete facts for a builder

### coach-db seed (the read-path baseline)
`packages/node/coach-db/src/seed/README.md` + `local-snapshot.ts`. One command:
```bash
# Postgres up + schema applied first:
#   (apps/node/coach-api) docker compose up -d --wait postgres   # :5433 standalone
#   (coach-db) pnpm db:push
DATABASE_URL=postgresql://coach_api_app:dev-password-coach-api-app@localhost:5433/coach_api \
  pnpm --filter @saga-ed/coach-db db:seed
```
Seeds (idempotent): `content_instance` (+`_module`/`_completed_module`) from
`fixtures/content-instances.json`; `persona_definition` + `persona_assignment`
(derived from `@saga-ed/iam-seed-ids`); `group_track_map` (demo district → the
tutor's track).

Identities baked in:
- **Tutor:** `demo-tutor-1@saga.org` — userId `1c939568-1464-5f9a-b5a4-0bc73a0454cb`.
- **District admin:** `demo-dadmin@saga.org` — `personaAdminDemo` (the elevated-UI
  persona for the Reports/admin scenario).
- **Group:** demo district `a0da8362-1a93-5d1d-aeaa-b6d8960e9821`.
- **Track (content_name):** `spring-pilot` (the only materialized instance).
  Content release name `curriculum-coach`, units `unit_1..unit_4`.
  Fallback default track = `base-coach` (`DEFAULT_CONTENT_NAME`).

Under the synthetic-dev mesh (`AUTH_AUTHENABLED=true`), `devLogin` as
`demo-tutor-1@saga.org` authenticates as this tutor and the dashboard shows the
seeded `spring-pilot` instance out of the box.

### coach-web run (standalone)
`apps/web/coach-web/package.json`: `dev` = `vite dev` (ss serves it on **:8800**),
`build` (prebuild runs `graphql-codegen`), `preview`. Env `.env`:
`PUBLIC_COACH_API_URL=http://localhost:6105`, `PUBLIC_LOGIN_URL`,
`PUBLIC_DASHBOARD_URL`. coach-api needs `CONTENT_STORE_BACKEND=postgres`.

---

## Pattern to mirror — `ss e2e connect`
`packages/node/saga-stack-cli/src/commands/e2e/connect.ts` is the existing
concierge to copy. It: discovers a flow from a `flows.json`
(`discoverFlowManifest`), resolves it (`resolveFlow`), recurses a **prerequisite**
built headless, then opens a **headed foreground** surface via
`executeResolvedFlow`. Relevant flags to echo for `develop coach`:
`--reuse` (skip reset + prerequisite, run against current stack state),
`--prereq-from-snapshot` / `--refresh-snapshot` (checkpoint restore / bake),
`--tunnel` (repoint browsers at vms tunnel hosts). A `develop coach` command would
analogously: ensure stack up + coach built, seed (db:seed / `coach-content
materialize`), `devLogin` as the chosen persona, then open coach-web at the
scenario's route (`/` dashboard, `/reports` admin, or a playlist-configured state)
in the foreground. Note coach-web already ships its own `e2e/flows.json`
(`apps/web/coach-web/e2e/flows.json`) — the develop concierge is *active dev*, so it
need not reuse the e2e flow, but the discovery machinery is shared.

---

## Open questions (block/shape the develop-coach plan)

1. **prompt-2 vs reality (admin):** The org-wide admin Report (View 1) is
   **mock-backed** in coach-web today. Does `develop coach --admin` want the mock
   view (works now, no seed) or a **live-backed** table (needs rewiring
   `reportsStore.fetchReport` → `api/reports.ts` **and** seeding multiple assigned
   tutors on one `content_name`)?
2. **prompt-2 vs reality (playlisting):** There is **no playlisting UI in the coach
   repo**. Playlist *selection* is a saga-dash/rostering surface
   (`user_policy.playlist_name`/`available_playlists`). Is scenario 5's "interface"
   actually saga-dash, or is a coach-web playlist UI planned/in-flight? (Nothing
   found in coach open PRs #236/#237/#233 or issues.)
3. **What is developable for `--playlist`?** If no UI exists, is the target the
   track plumbing (publish ≥2 tracks + switch `group_track_map`/policy +
   `materialize`) so a dev can iterate on how playlist choice drives content? If so,
   the seed needs a **second track** added (only `spring-pilot` exists today).
4. **Admin persona sufficiency:** `demo-dadmin` exists and carries
   `coach:access_coach_app`, but the Reports resolver has **no authz** and names
   come back empty. Does the admin scenario need real org/member data (names/emails)
   that the current CNS-only path does not provide?
5. **Legacy authoring UI:** legacy `wmcm` (Angular content creator) and `xlr8_dash`
   are noted as migration targets (`claude/api-poc/research/legacy-coach-architecture.md`),
   but only the CLI publish pipeline and the mock Reports exist so far. Is an
   authoring/admin **web** UI planned for coach-web, or does authoring stay
   legacy + `coach-content` CLI?

# 06 — Coach seed data, personas & logins for `ss develop coach`

**Area:** what a developer needs SEEDED and LOGGED-IN to open coach and see real
content, across the three coach scenarios in `prompt-2.md`:
(3) new coach incl. the ported content viewer, (4) coach + the admin dashboard,
(5) coach + the playlisting interface.

**Headline:** Coach already ships a complete, committed OFFLINE seed
(`coach-db db:seed` → the `local-snapshot`) that renders the tutor Dashboard out of
the box for **one** identity — `demo-tutor-1@saga.org`. The `ss` stack already wires
that seed in as the `coach-pg` + `coach-mongo` seed steps under `--with coach`. The
main gaps a `develop coach` concierge must close are NOT "no seed" — they are
(a) a **still-open manifest auth bug (soa#300)** that breaks coach-web browser login
against local iam, (b) seed steps that are **`failureMode: 'warn'`** so a fresh dev
can get a green stack with an empty coach and not know, (c) the **admin/reports**
scenario needing *multiple* tutors on one track (only one is seeded), and (d) the
**content-viewer** dashboard/Explore content **mismatch** (Dashboard = spring-pilot,
Explore = synthetic curriculum-coach). Playlisting has **no shipped UI** yet.

---

## 1. What coach seeds today (EXISTS, works)

### 1a. `coach-db db:seed` — the canonical offline snapshot
- Entry: `packages/node/coach-db/src/seed/local-snapshot.ts` → built to
  `dist/seed/local-snapshot.js`, invoked by the `db:seed` npm script.
- **No iam-db / saga_api / broker dependency** — pure committed fixtures. Idempotent
  (delete-and-reinsert the snapshot rows). Seeds four things into the coach Postgres
  (`coach_api` DB):

| Table | Source | What it gives you |
|---|---|---|
| `content_instance` (+ `_module`, `_completed_module`) | `src/seed/fixtures/content-instances.json` | One progress instance for **demo-tutor-1**, so the Coach Dashboard renders. |
| `persona_definition` + `persona_assignment` | `src/seed/persona-projections.ts` (DERIVED from `@saga-ed/iam-seed-ids`, not literals) | The iam-event projection snapshot for demo-tutor-1 (TUTOR) + demo-dadmin (ADMIN). |
| `group_track_map` | `persona-projections.ts` `groupTrackMaps()` | Points the "Demo District" at the track the seeded tutor's instance is on (added in PR #235). |
| `content_release` (+ curricula/polls + `active` pointer) | `src/seed/fixtures/content-release.json` | An offline content release so a `CONTENT_STORE_BACKEND=postgres` coach-api serves content. |

- **The seeded instance is spring-pilot legacy-parity** (coach PR #228,
  `worktree-coach-legacy-parity-seed`): instance `37a5187e-…`, `contentName =
  spring-pilot`, **59 modules, 13 complete** (nav 13 COMPLETE / 11 IN_PROGRESS /
  35 UNLOCKED). It is a faithful transform of the live legacy
  `qa.wootmath.com/coach` instance for `direct_test_2025_tutor1`, re-keyed to
  demo-tutor-1. So a local coach Dashboard matches legacy side-by-side.
- **The `content_release` fixture is still synthetic `curriculum-coach`** (27 poll
  titles) — release id `00000000-0000-4000-8000-c0ac4f1c7000`. PR #228 explicitly
  **deferred** publishing a real spring-pilot release, so Dashboard (spring-pilot,
  59) and Explore/content-viewer (curriculum-coach, 27) currently show **different
  curricula**. This is the biggest content-viewer footgun (see §4/§5).

### 1b. `coach-mongo` curriculum (the dual-store other half)
- coach-api is DUAL-STORE: `coach_api` Postgres (progress) + the mesh Mongo
  (curriculum read path). Manifest launch env: `MONGO_DATABASE=saga_local`,
  `CONTENT_DATABASE=wmlms_local`.
- Curriculum fixtures live in the coach-api repo:
  `apps/node/coach-api/scripts/data/content_coach.json` (→ `saga_local.content_coach`)
  and `scripts/data/content.json` (→ `wmlms_local.content`). These are `mongoimport
  --mode upsert` static committed fixtures.

### 1c. `cold-start/coach-bootstrap.ts` — NOT for local dev
- `packages/node/coach-db/src/cold-start/coach-bootstrap.ts` reads iam-db DIRECTLY to
  rebuild the projection at a real cold start. **Blocked on the rostering#558 grant;
  not runnable, needs `IAM_DB_URL`.** The `local-snapshot` is its offline twin.
  The concierge should NOT touch this — use `db:seed`.

---

## 2. How the seed is applied — local vs synthetic-dev / `ss`

### 2a. Manual local (coach repo, from `coach-db/src/seed/README.md`)
```bash
# 1. Postgres up + schema applied
cd apps/node/coach-api && docker compose up -d --wait postgres
cd packages/node/coach-db && pnpm build && pnpm db:push   # build copies fixtures into dist/
# 2. Seed (coach-db's OWN default port is :5433)
DATABASE_URL=postgresql://coach_api_app:dev-password-coach-api-app@localhost:5433/coach_api \
  pnpm --filter @saga-ed/coach-db db:seed
```
> **Gotcha:** `db:seed` runs `dist/seed/local-snapshot.js` — you MUST `pnpm build`
> first (its `build` script copies `src/seed/fixtures/*` into `dist/seed/fixtures/`).
> A stale/unbuilt dist silently seeds old fixtures or fails to find them.

### 2b. Under the `ss` synthetic-dev stack (EXISTS)
Two seed steps in `saga-stack-cli/src/core/seed/profiles.ts`, both in the `full`
profile and both `failureMode: 'warn'`:
- **`coach-pg`** (profiles.ts ~L417): `service: coach-api`, `cwd:
  packages/node/coach-db`, `command: ['pnpm','db:seed']`, `env: inlineDatabaseUrl`
  forcing the mesh **:5432** `coach_api` (== `$COACH_DB_URL`, overriding coach-db's
  own :5433 default). `requiresServiceUp: []` — offline direct pg seed.
- **`coach-mongo`** (profiles.ts ~L437, + `coach-mongo-content` sub-step): two
  `docker exec … mongoimport … --mode upsert` into the mesh mongo container
  (`saga_local.content_coach`, `wmlms_local.content`) via `stdinFile`.
- Bundle: `--with coach` (`core/bundles.ts`) = services `coach-api`, `coach-web`
  (+ the `coach_api` DB). Native prep already provisions the `coach_api` role/DB and
  migrates it (`databases.ts` `coach_api.migrate = { dir: packages/node/coach-db,
  cmd: db:deploy, databaseUrlOverride: true }`).

```bash
ss stack up --with coach          # boots coach-api :6105 + coach-web :8800 + deps, seeds
ss stack seed --with coach        # (re)seed a running stack
```
Note the coach service `seed: []` arrays in the manifest are empty — coach seeding is
driven by the **profile** steps (`coach-pg`/`coach-mongo`), which the `full` seed
profile always runs; it is NOT gated behind a per-service `SeedStepRef`.

---

## 3. Personas / logins a coach developer uses

Coach runs **real iam auth** in the mesh (`AUTH_AUTHENABLED=true` on coach-api;
`AUTH_JWKSURL`/`AUTH_ISSUER` point at local iam). `devLogin` resolves an email → user.
All three identities derive from the shared `@saga-ed/iam-seed-ids` `DEMO_MEMBERSHIPS`
catalog and are materialized by rostering `iam-db/prisma/seed.ts` — coach's projection
byte-matches the live `iam.*` events (one seed universe, PR coach#223).

| Persona (email) | userId | Persona / group | Seeded content? | Use it for |
|---|---|---|---|---|
| **demo-tutor-1@saga.org** | `1c939568-1464-5f9a-b5a4-0bc73a0454cb` | `personaTutorDemo`, Demo District `a0da8362-…`, carries `coach:access_coach_app` | **YES** — spring-pilot instance, Dashboard renders 59 modules | THE coach tutor. Scenarios (3) content-viewer & default dev. |
| **demo-dadmin@saga.org** | `deriveUserId('demo-dadmin')` | `personaAdminDemo`, Demo District, carries `coach:access_coach_app` | Projection only — **no content_instance** | Scenario (4) admin/reports elevated UI. |
| **demo-tutor-2@saga.org** | `033c9598-535b-5fd4-b722-19c32585410c` | `personaTutorDemo` (declared) | **NO** — `seed-users.ts` sets `rendersModules:false`; no instance seeded | second tutor — needed to make admin report non-trivial (currently absent). |

- Canonical alias source: `apps/web/coach-web/e2e/data/seed-users.ts` (`tutor1`,
  `tutor2`); `AUTHENTICATED_ALIASES = ['tutor1']` (only tutor1 gets a session today).
- **Login via `ss`:** `ss stack login demo-tutor-1@saga.org` mints a native headless
  `devLogin` cookie jar (`<stateDir>/cookies.txt`); `--browser` also opens an
  auto-logged-in Chromium via the vendored `browser-login.mjs`
  (`src/commands/stack/login.ts`). Default user is `dev@saga.org` — for coach you
  MUST pass `demo-tutor-1@saga.org` or the Dashboard is empty.
- **`AuthLoginHostOverride` / training-apex is NOT local dev.** coach PRs #229/#231
  (`coach.saga-training.org`, `AuthLoginHostOverride`, `AuthIssuerOverride`) are for
  DEPLOYED alternate-apex environments. The concierge login path is local
  `devLogin`; training-apex is out of scope for `develop coach`.

---

## 4. What each scenario needs seeded to be NON-EMPTY

### (3) Coach incl. the ported content viewer
- **Surface:** the ported "ContentViewer" is now an **in-app route inside coach-web**,
  not a separate app: `apps/web/coach-web/src/routes/units/[unitName]/[moduleId]/+page.svelte`
  — the legacy "vscroll" module-playback shell — reached from Dashboard / Explore
  (`src/routes/explore`). Rendering is gated by `areAllQuestionTypesPorted`; modules
  with an un-ported task type never reach the route. Poll content comes from
  `$lib/api/curriculum` `fetchPollContent`.
- **Legacy origin:** the haxe ContentViewer lives behind
  `https://my.sagaeducation.org/auth/content-viewer` (the `/auth/` path segment is
  load-bearing for legacy cookie passthrough — see coach `claude/projects/sub-domain`).
  It is NOT cloned locally; the modern experience is the coach-web `/units/…` port.
  (A standalone `apps/content-viewer/` SvelteKit app appears only as a TARGET in
  coach `claude/shared/sources/project-breakdown.md` — a plan/POC, not shipped.)
- **Seeded?** The mongo curriculum (`coach-mongo`) + the PG `content_release`
  (`curriculum-coach`, 27 polls) both seed, so the viewer renders. **BUT** the
  Dashboard shows **spring-pilot** (59 modules) while Explore/the content-viewer
  renders **synthetic curriculum-coach** (PR #228 verification note: *"Explore still
  renders synthetic curriculum-coach"*). Which store serves depends on
  `CONTENT_STORE_BACKEND`: unset (default in the mesh manifest) ⇒ **mongo** store
  (coach-mongo curriculum); `=postgres` ⇒ the `content_release` fixture. The concierge
  should decide/label which the developer gets and warn about the mismatch.

### (4) Coach + the admin dashboard
- **Surface EXISTS today:** `src/routes/reports/+page.svelte` (standalone) and
  `src/routes/embed/reports/coach/+page.svelte` (iframe embed for the Haxe Saga
  Dashboard). Client: `src/lib/api/reports.ts` → GraphQL `coachReport(content_name)`;
  resolver `apps/node/coach-api/src/sectors/reports/gql/reports.resolver.ts` +
  `reports.data.ts`.
- **What it needs:** `getCoachReport(content_name)` = `getContentByName` →
  `getAssignmentsByContentName` → distinct `user_id`s → their `content_instance`s.
  It builds a **row per tutor** on that track. With only **demo-tutor-1** seeded on
  spring-pilot, the report has ONE row. **Gap:** to demo the admin dashboard
  meaningfully the concierge should seed **multiple tutor instances on the same
  `content_name`** (e.g. demo-tutor-2, demo-dadmin) — today's fixtures don't.
- The frontend passes the content/org name (default `'Direct Test Org'` /
  `content_name`) — note the report is keyed by **content_name**, and the seed's
  `group_track_map` maps the demo district → spring-pilot.

### (5) Coach + the playlisting interface
- **No shipped standalone playlisting UI.** "Playlist"/"Content Creator" appears only
  in coach POC/plan docs (`claude/shared/sources/project-breakdown.md` "Content
  Creator (C)", "apps/content-creator"). The closest shipped artifact is the coach-web
  **authoring** e2e project: `pnpm test:e2e:authoring` (`E2E_AUTHORING=1`,
  `apps/web/coach-web/e2e/authoring/`), which runs coach-api with
  **`CONTENT_STORE_BACKEND=postgres`** against Postgres :5433 and exercises the poll
  authoring→publish pipeline. Publishing uses `packages/node/coach-content-publish`
  (archive → PG ContentReadStore). Treat scenario (5) as **in-flight / authoring
  pipeline**, and flag to the builder that a first-class playlisting UI may not exist
  to hand off yet.

---

## 5. Gaps a fresh developer hits today (what the concierge must automate)

1. **soa#300 (OPEN, NOT fixed in this worktree's manifest) — coach-web can't
   browser-auth local iam.** `src/core/manifest/services.ts`: coach-web `launch.env`
   sets only `PUBLIC_COACH_API_URL` (no `PUBLIC_IAM_API_URL`), so post-coach#226 the
   browser `auth.whoami` falls back to the checked-in `.env` default
   `https://iam.wootdev.com` (remote) and a local cookie is invalid. AND iam-api
   `CORS_ORIGIN` (services.ts L63) = `${DASH_URL},${CONNECT_WEB_URL}` — **no coach-web
   origin**, so the whoami is CORS-blocked. **Fix the concierge needs:** add
   `PUBLIC_IAM_API_URL: '${IAM_URL}'` to coach-web env + a `COACH_WEB_URL` token in
   iam-api `CORS_ORIGIN`. Until this lands, `--with coach` gives a stack you can't log
   into in a browser (the coach#228 workaround was a worktree env override +
   `--disable-web-security` Chromium).
2. **Seed steps are `failureMode: 'warn'`.** `coach-pg`/`coach-mongo` failing (coach
   repo absent, unbuilt coach-db dist, mongo container name mismatch) does NOT fail the
   stack — a dev gets a green `ss stack up` and an EMPTY coach and no signal. The
   concierge should **hard-verify** coach seeded (e.g. assert `content_instance` count
   > 0 for demo-tutor-1, or drive the Dashboard) before handing off.
3. **coach-db must be built before seed.** `db:seed` runs the `dist` entry and needs
   `pnpm build` to have copied the fixtures. Concierge should ensure the build.
4. **Content mismatch (Dashboard spring-pilot 59 vs Explore/viewer curriculum-coach
   27).** Confusing for a content-viewer developer. Concierge should either publish a
   spring-pilot release or clearly document which curriculum each surface shows.
5. **Admin report is sparse (1 tutor).** Seed more tutor instances on one track.
6. **Login must target `demo-tutor-1@saga.org`.** The default `dev@saga.org` yields an
   empty coach — the concierge must log in the coach persona, not the generic dev user.
7. **Slots:** coach-web is a frontend; `ss` slots >0 are "backend sub-stack today"
   (connect excluded pending port tokenization) — confirm coach-web behaves under
   `--slot N` (the effort's prompt-1 pins slot 1) or run coach at slot 0.

---

## 6. Concrete commands (copy-paste)

```bash
# Build + link the ss CLI (from this worktree)
cd /home/skelly/dev/soa/.claude/worktrees/gh305-ss-develop/packages/node/saga-stack-cli
pnpm build && pnpm link --global          # `ss` on PATH; or run `node bin/dev.js …`

# Bring coach up (api :6105, web :8800) + its deps, seeded
ss stack up --with coach                  # add --slot 1 per the effort's slot pin
ss stack seed --with coach                # (re)seed a running stack
ss stack status --with coach              # health

# Log in THE coach tutor (empty otherwise) — headless jar, or --browser for Chromium
ss stack login demo-tutor-1@saga.org --browser
#   admin/reports scenario:
ss stack login demo-dadmin@saga.org --browser

# Manual coach-db reseed (coach repo) — build first, mesh :5432 or local :5433
cd /home/skelly/dev/coach/packages/node/coach-db && pnpm build
DATABASE_URL=postgresql://coach_api_app:dev-password-coach-api-app@localhost:5432/coach_api \
  pnpm --filter @saga-ed/coach-db db:seed

# Authoring / playlisting pipeline (scenario 5, in-flight) — coach-web repo
cd /home/skelly/dev/coach/apps/web/coach-web && pnpm test:e2e:authoring   # CONTENT_STORE_BACKEND=postgres
```

Coach dev URLs (slot 0): coach-web `http://localhost:8800`, coach-api
`http://localhost:6105` (health at root `/health`, GraphQL under `/coach/v1/graphql`).

---

## 7. Key file pointers

- `coach: packages/node/coach-db/src/seed/local-snapshot.ts` — the offline seeder.
- `coach: packages/node/coach-db/src/seed/persona-projections.ts` — persona/group/track derivation from iam-seed-ids.
- `coach: packages/node/coach-db/src/seed/fixtures/content-instances.json` — demo-tutor-1 spring-pilot instance (59 mod / 13 complete).
- `coach: packages/node/coach-db/src/seed/fixtures/content-release.json` — curriculum-coach release (27 polls).
- `coach: packages/node/coach-db/src/seed/README.md` — manual seed how-to.
- `coach: packages/node/coach-db/src/cold-start/coach-bootstrap.ts` — iam-db cold-start (blocked, NOT local).
- `coach: apps/web/coach-web/e2e/data/seed-users.ts` — persona alias catalog.
- `coach: apps/web/coach-web/src/routes/units/[unitName]/[moduleId]/+page.svelte` — ported content-viewer (vscroll module playback).
- `coach: apps/web/coach-web/src/routes/reports/ & src/routes/embed/reports/coach/` — admin dashboard surfaces.
- `coach: apps/node/coach-api/src/sectors/reports/gql/reports.data.ts` — coachReport data path.
- `coach: apps/node/coach-api/scripts/data/content_coach.json, content.json` — mongo curriculum fixtures.
- `ss: src/core/seed/profiles.ts` (~L417 `coach-pg`, ~L437 `coach-mongo`) — how ss seeds coach.
- `ss: src/core/bundles.ts` — `--with coach` bundle def.
- `ss: src/core/manifest/services.ts` (coach-api ~L475, coach-web ~L515, iam CORS L63) — coach service wiring + the soa#300 auth gap.
- `ss: src/commands/stack/login.ts` — persona devLogin.
- `ss: src/commands/e2e/connect.ts` — the concierge to MIRROR for `develop coach`.
- soa#300 (OPEN) — coach-web local iam wiring bug the concierge must fix.
- coach PRs: #228 (spring-pilot parity seed), #235 (group_track_map seed), #223 (collapse onto iam-seed-ids demo-* users), #229/#231 (training-apex — deploy-side, out of scope).

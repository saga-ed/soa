# 04 — How Coach is wired into soa's synthetic-dev / `ss` stack (research for `develop coach`)

**Area:** the coach side of the `ss` (saga-stack-cli) synthetic-dev stack — services, closure,
bring-up, seeding, login, and the browser-plane wiring a `ss develop coach` concierge must drive.
**Scope note:** this doc is the *plumbing* map (how coach runs under `ss`). The product *surfaces*
themselves (ported content-viewer, admin dashboard, playlisting) are only mapped enough to route the
concierge — a sibling research area should own those in depth.

All paths below are absolute. The CLI lives at
`/home/skelly/dev/soa/.claude/worktrees/gh305-ss-develop/packages/node/saga-stack-cli` (referred to
as `<cli>` from here). The coach monorepo is at `/home/skelly/dev/coach`.

---

## Headline

Coach already has a first-class, working place in the `ss` stack: **two services** (`coach-api`,
`coach-web`), a **`coach` bundle** (`--with coach`), a **`coach_api` mesh Postgres DB**, a **dual mongo
curriculum store**, and **two seed steps** (`coach-pg`, `coach-mongo`). Bring-up, closure, and the
tunnel/browser-plane overlay all handle coach today (the soa#298 overlay gap is **fixed & merged**,
commit `0c8b50e`). All three coach scenarios (3 = tutor+content-viewer, 4 = admin dashboard, 5 =
playlisting) run on the **same `coach-api`+`coach-web` pair** — they differ by **login persona** and
**route**, not by services. A `develop coach` command is mostly an *orchestration* over existing
primitives. **Two real gaps the plan must fix first:** (A) **soa#300** — `coach-web` browser→iam auth
is broken (stale manifest wiring), which blocks actually *using* coach-web in a browser; (B) the
default seed is `roster`, which **does not seed coach** — coach only seeds under `--seed full` (or a
new coach seed add-on), and the identity must be **`demo-tutor-1@saga.org`**, not the CLI default
`dev@saga.org`.

---

## What exists today (evidence)

### 1. Coach services in the manifest

`<cli>/src/core/manifest/services.ts`:

- **`coach-api`** (lines 475–514):
  - `repo: 'COACH'`, `subpath: 'apps/node/coach-api'`, port **6105** (`EXPRESS_SERVER_PORT`), `healthPath: '/health'` (root, not under `/coach/v1`).
  - `databases: ['coach_api']` (pg) **plus** `mesh: ['connect-mongo']` — DUAL-STORE: coach_api Postgres for progress + the mesh mongo (`saga_local` + `wmlms_local`) for curriculum read-path.
  - `dependsOn: ['iam-api']` (`depKinds: { 'iam-api': 'url' }`). `RABBITMQ_ENABLED: 'false'` (rabbitmq intentionally NOT gated on).
  - Launch env of note: `DATABASE_URL=${COACH_DB_URL}`, `MONGO_PORT=${CONNECT_MONGO_PORT}`, `MONGO_DATABASE=saga_local`, `CONTENT_DATABASE=wmlms_local`, `AUTH_JWKSURL=${IAM_URL}/.well-known/jwks.json`, `EXPRESS_SERVER_CORSALLOWEDDOMAINS=${COACH_WEB_HOST}`, and **`SAGA_API_TARGET=${SAGA_API_TARGET_COACH}`** → defaults to **`https://staging.wootmath.com`** (an EXTERNAL upstream; see open questions).
  - `tunnelSlug: 'coach'`, `optional: false`.
- **`coach-web`** (lines 515–539):
  - `repo: 'COACH'`, `subpath: 'apps/web/coach-web'`, port **8800**, SvelteKit SPA, `healthPath: '/'`, `isFrontend: true`.
  - `dependsOn: ['coach-api']` (`depKinds: { 'coach-api': 'browser' }`).
  - Launch env is **only** `PUBLIC_COACH_API_URL: '${COACH_API_URL}'` — **this is the soa#300 bug** (see below). Stale comment at line 524: *"Reaches iam server-side THROUGH coach-api, so it only needs the coach-api URL."*
  - `tunnelSlug: 'coach-web'`.

There is **no** separate `coach-db`, `coach-content`, or coach-owned `iam` service. `coach-db` is a
*package* (`packages/node/coach-db`), the source of the pg schema + seed, not a running service.
`iam-api` is the shared mesh iam. Curriculum "content" is the mesh mongo, seeded by `coach-mongo`.

Service-id enum: `<cli>/src/core/manifest/types.ts:27-28` (`coach-api`, `coach-web`), repo `COACH`
(line 43), db `coach_api` (line 69).

### 2. `coach_api` database

`<cli>/src/core/manifest/databases.ts:88-97`:
- `coach_api` is a **mesh-provisioned** pg app DB (not a pre-seeded volume): CREATE USER/DATABASE/GRANT at provision.
- `ownerRole: 'coach_api_app'`, `ownerPw: 'dev-password-coach-api-app'`.
- Migrations live in the **package**, not the app: `migrate: { dir: 'packages/node/coach-db', cmd: 'db:deploy', databaseUrlOverride: true }` — `DATABASE_URL` is forced to the mesh `:5432` (coach-db's own default is `:5433`).

### 3. Bundle / closure

`<cli>/src/core/bundles.ts:51-54`: **`coach` bundle → `['coach-api', 'coach-web']`**, no `seedAddOn`.
`--with coach` is pure sugar unioned into the closure (`combineRequested`), then `computeClosure`
runs. **A bundle with no seed add-on is a no-op for `stack seed`** (bundles.ts:15-16 explicitly says
`--with coach` is a seed no-op).

### 4. Coach launch tokens

`<cli>/src/core/launch-plan.ts` (`defaultLaunchContext`, ~lines 615–644):
- `COACH_API_PORT = ports['coach-api']` (6105), `COACH_API_URL = http://localhost:${ports['coach-api']}`, `COACH_WEB_HOST = 'localhost'`, `SAGA_API_TARGET_COACH = 'https://staging.wootmath.com'`, `CONNECT_MONGO_PORT = mongoPort` (27037 slot 0), `COACH_DB_URL = pgUrl('coach_api', pgPort)`.
- `IAM_URL` token exists and is already consumed by coach-api — it is available to be given to coach-web too (relevant to the soa#300 fix).

### 5. Bring-up: `ss stack up`

- Command: `<cli>/src/commands/stack/up.ts`. `--with coach` (options include `coach`, up.ts:88).
- Bare `stack up` expands to the full **non-optional** set (coach-api/coach-web are `optional:false`, so a bare full up **includes coach**). `--only`/`--with` boot just the closure.
- Native path: `computeClosure` → `StackApi.up(closure)` (up.ts:216-234). Prep (build/install/db:generate/provision/migrate) is closure-scoped.
- **Skip-if-repo-absent:** if `/home/skelly/dev/coach` isn't cloned, coach-api/coach-web are *warned-and-skipped*, and dependents are transitively skipped, rather than failing the run (`<cli>/src/stack-api.ts` ~lines 275, 741, 763; commit `be4e387` "skip-if-repo-absent launcher"). COACH repo path resolves via `$COACH` → default `$DEV/coach` (`<cli>/src/runtime/repos.ts:51`, `REPO_ENV_VAR.coach → 'COACH'`).
- Optional login-after-up: `stack up --login` mints a jar for `DEFAULT_LOGIN_USER = dev@saga.org` (up.ts:573) — **NOT the coach identity**; the concierge needs `demo-tutor-1@saga.org` instead.

### 6. Browser-plane / tunnel overlay — soa#298 gap is FIXED

`<cli>/src/core/launch-plan.ts`, `tunnelOverlay()` (lines 314-394). Two functions splat lane
overlays: `sandboxOverlay` (iam dep-repoint) + `tunnelOverlay` (browser-plane CORS/URLs), combined in
`laneOverlay` (line 405). **coach cases now exist** (lines 372-391):
- `coach-api` → `EXPRESS_SERVER_CORSALLOWEDDOMAINS: '${COACH_WEB_HOST},${td}'` (admits the bare tunnel domain).
- `coach-web` → `PUBLIC_COACH_API_URL: 'https://coach-api.${td}'` + `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: 'coach.${td}'`.

These were added by **commit `0c8b50e` "finish ss tunnel mode — coach overlay + e2e --tunnel (#298)"**,
already on `main`/this worktree. So the "coach missing from the TS browser-plane overlay
(launch-plan.ts:375)" gap from soa#298 is **closed** for **tunnel** mode. **BUT** these overlays fire
only when `TUNNEL_DOMAIN` is set (`tunnelOverlay` returns `{}` in pure-local mode, line 316). Pure
local `stack up --with coach` relies on the base manifest launch env — which is where **soa#300**
bites.

### 7. soa#300 — coach-web local iam wiring is STALE (OPEN — blocks local browser use)

Issue `saga-ed/soa#300` (OPEN). Since **coach#226**, coach-web reads identity **direct from iam in the
browser** (`WHOAMI_URL = ${PUBLIC_IAM_API_URL}/trpc/auth.whoami`, saga-dash pattern). The manifest was
never updated. Two concrete breakages in `<cli>/src/core/manifest/services.ts`:
1. **coach-web sets no `PUBLIC_IAM_API_URL`** (only `PUBLIC_COACH_API_URL`, line 531). So it falls back to its checked-in `.env` default `PUBLIC_IAM_API_URL=https://iam.wootdev.com` (remote) — a local `ss` cookie is invalid ⇒ app 503s at sign-in.
2. **`iam-api` `CORS_ORIGIN` excludes coach-web.** Base launch env is `CORS_ORIGIN: '${DASH_URL},${CONNECT_WEB_URL}'` (services.ts, iam-api def) → no coach-web origin ⇒ the direct-from-browser `whoami` is CORS-blocked.

**Fix (per the issue):** add `PUBLIC_IAM_API_URL: '${IAM_URL}'` to `coach-web` launch.env; add a
`COACH_WEB_URL` token (`http://localhost:${ports['coach-web']}`) and append it to iam-api
`CORS_ORIGIN` (`${DASH_URL},${CONNECT_WEB_URL},${COACH_WEB_URL}`). **Impact:** blocks anyone
browser-testing local coach-web — i.e. it blocks the *whole point* of `develop coach`. The coach#228
verification worked around it by running coach-web from a worktree with
`PUBLIC_IAM_API_URL=http://localhost:3010` + a `--disable-web-security` Chromium. **The `develop
coach` plan should land the soa#300 manifest fix as a hard prerequisite.**

### 8. Seeding — coach DBs + identity

Seed profiles: `<cli>/src/core/seed/profiles.ts:42-45`:
- `roster: ['iam-registry', 'iam-dev-user', 'iam', 'sessions']` — **NO coach steps.** This is the DEFAULT profile for both `stack up` (up.ts:101 "an absent --seed still seeds the roster baseline") and `stack seed` (seed.ts:81 default `roster`).
- `full: [ … 'programs', 'scheduling', 'content', 'coach-pg', 'coach-mongo' ]` — the only profile that seeds coach.

The two coach seed steps (`profiles.ts:417-466`):
- **`coach-pg`** — `service: 'coach-api'`, `databases: ['coach_api']`, `cwd: 'packages/node/coach-db'`, `command: ['pnpm','db:seed']`, `DATABASE_URL` forced to the mesh `:5432` coach_api. `failureMode: 'warn'` (coach may be absent). This runs coach-db's **`local-snapshot.ts`** (`/home/skelly/dev/coach/packages/node/coach-db/src/seed/local-snapshot.ts`).
- **`coach-mongo`** — `service: 'coach-api'`, `cwd: 'apps/node/coach-api'`. Two mongoimports via `docker exec -i <mongo container>`: `scripts/data/content_coach.json` → `saga_local.content_coach`, and (optionalStep `coach-mongo-content`) `scripts/data/content.json` → `wmlms_local.content`. `--mode upsert` so re-seeds converge. Always seeds (mongo not a tracked DbId; not skipped on a pg-snapshot restore — compose-seed-plan.ts:125-128).

Closure narrowing: `composeSeedPlan` (`<cli>/src/core/seed/compose-seed-plan.ts`) DROPS a step whose
`service` isn't in the active closure. So `coach-pg`/`coach-mongo` only run when **coach-api is in the
closure AND the profile selects them** (i.e. `full`). There is a `perSystem` narrowing hook
(compose-seed-plan.ts:85) and `--only`/`--exclude` on `stack seed`, but **no `coach` seed add-on and
no `coach` `perSystem` shortcut today** — the concierge must select `full` or the plan should add a
coach seed add-on to the bundle.

**Identity / seed alignment (critical):** coach's seed is anchored on the **`demo-tutor-1`** persona
(`/home/skelly/dev/coach/packages/node/coach-db/src/seed/local-snapshot.ts` header, and
`.../seed/persona-projections.ts`):
- `COACH_TUTOR_USER_ID = deriveUserId('demo-tutor-1')` = `1c939568-1464-5f9a-b5a4-0bc73a0454cb`, email **`demo-tutor-1@saga.org`**.
- `persona_assignment` groupId = `deriveGroupId('demo')` = `a0da8362-1a93-5d1d-aeaa-b6d8960e9821` ("Demo District").
- Both `demo-tutor-1` (TUTOR) and `demo-dadmin` (admin) carry `coach:access_coach_app` (persona-projections.ts:35-39, 152). The seeded `content_instance` renders the Coach Dashboard out-of-the-box **only for `demo-tutor-1@saga.org`**.
- **`group_track_map` bake** (coach#235, commit `1b54e46` "bake group_track_map into the local seed"): `groupTrackMaps(contentName)` (persona-projections.ts:96) writes `[{ groupId: deriveGroupId('demo'), groupKind: DISTRICT, contentName }]` so the tutor's group is mapped to the seeded content track. Migration `20260618140000_add_group_track_map_and_instance_unique`.

So the persona projection (persona_definition/assignment) is DERIVED from the shared
`@saga-ed/iam-seed-ids` catalog to byte-match the mesh iam's own roster seed — meaning coach's local
seed is only correct if the **iam roster seed has materialized `demo-tutor-1`** (the `iam` seed step,
via rostering `iam-db/prisma/seed.ts` DEMO_MEMBERSHIPS). That's satisfied by the `roster`/`full`
profile's `iam` step; the coach steps assume it.

### 9. Login the concierge must mint

Native headless login: `<cli>/src/runtime/login.ts` + command `<cli>/src/commands/stack/login.ts`.
`stack login [email]` POSTs iam devLogin and writes a Netscape cookie jar `<stateDir>/cookies.txt`.
Default email `dev@saga.org` (`<cli>/src/core/login.ts:20 DEFAULT_LOGIN_USER`). For coach the concierge
must pass **`demo-tutor-1@saga.org`** (tutor/content-viewer/playlisting, scenarios 3 & 5) or
**`demo-dadmin@saga.org`** (admin dashboard, scenario 4). Note the native jar is **headless** (curl-
style). Actually *browsing* coach-web needs a real browser session — `stack login --browser` opens an
auto-logged-in Chromium (routes to the vendored `browser-login.mjs`). Once soa#300 is fixed, a
browser session against local coach-web will work; until then it 503s.

### 10. `e2e connect` — the concierge to mirror

`<cli>/src/commands/e2e/connect.ts` is the template: resolve a flow, recurse the prerequisite
(reset+seed owned by the journey), open a HEADED Playwright project in the FOREGROUND (stdio
inherited), `--reuse` to skip the rebuild+reset against the current stack. `develop coach` is the
*active-development* analogue: bring up the coach closure, seed coach, log in as the coach persona,
and hand back a running dev server (foreground `pnpm dev` for coach-web) — NOT a Playwright flow.

### 11. Tunnel overlay for coach (invite-a-coworker)

`stack tunnel` / `stack up --tunnel` (command `<cli>/src/commands/stack/tunnel.ts`,
`<cli>/src/runtime/tunnel-prep.ts`). With coach in the closure, the tunnelOverlay (§6) now sets coach
CORS + `PUBLIC_COACH_API_URL=https://coach-api.<moniker>.vms.wootdev.com` + Vite allowed-hosts. soa#298
also flagged a **vendored `tunnel.sh` SERVICES-table drift** (coach missing) — verify that was
re-vendored if the concierge ever shells the vendored script; the native TS path is the one that
matters and is fixed.

---

## What a `develop coach` command must orchestrate (the exact recipe)

Same for all three coach scenarios except the trailing persona + route:

1. **Ensure repos** — COACH cloned at `$DEV/coach` (else coach is skipped). Optionally auto-pull SOA + COACH.
2. **Bring up the coach closure:** `ss stack up --with coach` (closure = `coach-api`, `coach-web`, `iam-api`, + mesh: mongo `connect-mongo`, pg `coach_api`, redis for iam). Provision + migrate `coach_api` (coach-db `db:deploy`).
3. **Seed:** run the `full` profile **or** at minimum the coach steps + their iam prerequisite:
   - `iam-registry`, `iam-dev-user`, `iam` (so `demo-tutor-1`/`demo-dadmin` exist), then
   - `coach-pg` (coach-db `db:seed` → content_instance + persona projection + content_release + group_track_map bake), and
   - `coach-mongo` (curriculum → `saga_local.content_coach` + `wmlms_local.content`).
   Command today: `ss stack seed full` (after up) or `ss stack up --with coach --seed full`.
4. **Login as the coach identity** (NOT `dev@saga.org`):
   - scenarios 3 (content-viewer) & 5 (playlisting): `demo-tutor-1@saga.org`
   - scenario 4 (admin dashboard): `demo-dadmin@saga.org`
   Use `stack login --browser <email>` for a real browser session (headless jar alone won't drive the SPA).
5. **Hand back a running dev app** — coach-web dev server at `http://localhost:8800`, coach-api at `:6105`. Optionally deep-link the scenario's route (content-viewer vs admin vs playlisting — sibling research area owns the exact routes).

---

## Missing wiring the plan must FIX FIRST (ranked)

1. **soa#300 (BLOCKER) — coach-web ↔ local iam browser auth.** Land the manifest fix: `coach-web.launch.env += PUBLIC_IAM_API_URL: '${IAM_URL}'`; add `COACH_WEB_URL` token and append to `iam-api` `CORS_ORIGIN`. Without this, local coach-web 503s at sign-in — `develop coach` cannot deliver a usable browser app. (`<cli>/src/core/manifest/services.ts`, coach-web ~line 531 + iam-api CORS_ORIGIN.)
2. **Default seed doesn't cover coach.** `--with coach` carries no seed add-on and the default profile is `roster`. Either (a) the concierge forces `--seed full`, or better (b) add a `coach` **seed add-on** to the bundle registry (`<cli>/src/core/bundles.ts`) wiring `['coach-pg','coach-mongo']` (mirroring `playback`), so `develop coach` seeds coach without dragging in programs/scheduling/content it may not need. Also consider a `perSystem` `coach` shortcut in compose-seed-plan.
3. **Login persona default is wrong for coach.** The concierge must default to `demo-tutor-1@saga.org` (or `demo-dadmin@saga.org` for admin), not `DEFAULT_LOGIN_USER=dev@saga.org`; otherwise the seeded content_instance/persona won't render.
4. **External upstream dependency:** `coach-api.SAGA_API_TARGET` defaults to `https://staging.wootmath.com` (`SAGA_API_TARGET_COACH`). Confirm which coach surfaces actually hit it (content-viewer may) and whether it needs VPN/network — flag for the concierge's preflight.

---

## Key files (absolute)

- `<cli>/src/core/manifest/services.ts:475-539` — coach-api / coach-web service defs.
- `<cli>/src/core/manifest/databases.ts:88-97` — `coach_api` db (owner role/pw, migrate via coach-db package).
- `<cli>/src/core/bundles.ts:51-54` — `coach` bundle (no seed add-on — gap #2).
- `<cli>/src/core/launch-plan.ts:314-394` — sandbox/tunnel overlays incl. coach-api/coach-web cases (soa#298 fix, `0c8b50e`); tokens at ~615-644.
- `<cli>/src/core/seed/profiles.ts:42-45` (profiles), `:417-466` (coach-pg, coach-mongo steps).
- `<cli>/src/core/seed/compose-seed-plan.ts:77-128` — profile→steps, partial-stack drop, coach-mongo always-seed.
- `<cli>/src/runtime/login.ts` + `<cli>/src/commands/stack/login.ts` + `<cli>/src/core/login.ts:20` — native login + `DEFAULT_LOGIN_USER`.
- `<cli>/src/commands/stack/up.ts` (bring-up), `<cli>/src/commands/stack/seed.ts` (seed), `<cli>/src/commands/e2e/connect.ts` (concierge template).
- `<cli>/src/runtime/repos.ts:51` — COACH repo path resolution.
- `/home/skelly/dev/coach/packages/node/coach-db/src/seed/local-snapshot.ts` — coach-pg seed (content_instance, persona, content_release).
- `/home/skelly/dev/coach/packages/node/coach-db/src/seed/persona-projections.ts` — demo-tutor-1/demo-dadmin ids, `groupTrackMaps`, group_track_map bake (coach#235).
- `/home/skelly/dev/coach/apps/node/coach-api/scripts/data/{content_coach.json,content.json}` — coach-mongo curriculum fixtures.
- Migration `/home/skelly/dev/coach/packages/node/coach-db/src/prisma/migrations/20260618140000_add_group_track_map_and_instance_unique/`.

## Concrete commands (from `<cli>`, `node bin/dev.js …`)

```bash
# plan-only: see the coach closure + launch/seed plan
node bin/dev.js stack up --with coach --dry-run

# bring up just the coach closure natively + seed coach + mint the coach jar
node bin/dev.js stack up --with coach --seed full            # roster default does NOT seed coach
node bin/dev.js stack login --browser demo-tutor-1@saga.org  # tutor + content-viewer (scenarios 3/5)
node bin/dev.js stack login --browser demo-dadmin@saga.org   # admin dashboard (scenario 4)

# reseed an already-running stack (coach steps only run under full)
node bin/dev.js stack seed full

# invite-a-coworker (tunnel) — coach overlay now wired
node bin/dev.js stack up --with coach --tunnel

# coach-web dev server ends up at http://localhost:8800 ; coach-api at http://localhost:6105
```

## Open questions (for the develop-coach plan / sibling research)

1. **Scenario→surface→route mapping.** All three run on the same coach-api+coach-web pair; a sibling area must pin the exact coach-web routes for (3) ported content-viewer, (4) admin dashboard, (5) playlisting, and whether any need extra seed/config beyond `demo-tutor-1`. (content-viewer landed in coach commits `14b0ff1`/`76e435f`, "changed from iframe for content viewing".)
2. **Does soa#300 get fixed in gh_305 or is it a separate PR to depend on?** It's an open, self-contained manifest fix; the plan should either own it or hard-depend on it.
3. **Should `develop coach` introduce a `coach` seed add-on** (bundles.ts) so it seeds coach without the full profile's programs/scheduling/content, or is `--seed full` acceptable for a dev stack?
4. **`SAGA_API_TARGET_COACH=https://staging.wootmath.com`** — which coach surfaces hit external staging, and does the concierge need a network/VPN preflight or a local override?
5. **Admin (`demo-dadmin`) content baseline:** the seed's content_instance is anchored on `demo-tutor-1`; confirm the admin dashboard (scenario 4) has enough seeded data under `demo-dadmin` to render, or whether it reads the same Demo District aggregate.
6. **coach#155 status:** coach-db `db:seed` local-snapshot is referenced as possibly-unmerged in older comments (`profiles.ts:410-413` "coach#155 unmerged"); confirm it's merged now (local-snapshot.ts exists on coach `main`, so likely yes).

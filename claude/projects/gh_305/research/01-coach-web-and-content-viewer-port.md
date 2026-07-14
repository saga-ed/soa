# Research 01 — coach-web & the ported content-viewer application

_Research agent `coach-web-port` for the "ss develop coach" concierge effort (saga-ed/soa#305)._
_Area: the new coach-web SvelteKit frontend and the PORTED content-viewer (Haxe → Svelte)._
_All paths absolute. Facts verified against real files/PRs on 2026-07-14 unless labeled "planned/inferred"._

---

## Headline

The "ported content viewer application" is **`coach-web`'s in-app module player** — the
`lib/features/cns/viewer/*` renderers plus the `/units/[unitName]/[moduleId]` route — which
replaces the retired legacy **Haxe `ContentViewer`** web app (the `rtp/qt` task engine + `vscroll`
shell). coach-web is a client-only SvelteKit SPA (`adapter-static`, `ssr=false`) that boots by
reading identity **direct from iam-api** (`auth.whoami`), then loads a single **CNS ContentInstance**
for the user from coach-api GraphQL. To SEE the viewer work, a developer needs three services up
(coach-web + coach-api + iam-api) **and** seeded data: an iam session for the seeded tutor
`demo-tutor-1`, and a coach Postgres seed that gives that tutor a ContentInstance + a published
content release. A `flows.json` for coach-web already exists (used by the `e2e` topic) but coach-web
is **NOT yet registered** in the ss CLI's `spa-registry.ts`. **Scenarios 4 (admin dashboard) and 5
(playlisting) have no corresponding app or route in the coach repo today** — only `coach-web` exists.

---

## 1. What IS the "ported content viewer application"?

### Origin (what it replaced)
- The legacy app is the **Haxe `ContentViewer`** web app in the saga-ed org. Confirmed via
  `gh search code --owner saga-ed ContentViewer`: `saga-ed/coach:claude/projects/sub-domain/sources/prompt-1.md`
  describes _"a legacy web app ContentViewer that needs to seamlessly interoperate with the coach
  web-app"_. Not cloned locally.
- The port re-implements the Haxe task engine. Code comments name the exact legacy sources:
  - `taskTypes.ts` — _"matching the legacy `rtp/qt/Types.hx` convention"_ (versioned typeids like
    `multi_choice_1`, strip trailing `_N` to base type).
  - `pollPlayer.svelte.ts` — _"Ports legacy `PollDataStateManager.hx` (pdsm)'s throttle/queue/
    flush-on-unload"_; replaces the legacy `POST .../pdsm/s` REST save with GraphQL `saveModuleAnswer`.
  - The `/units/[unitName]/[moduleId]/+page.svelte` header — _"Renders every question in a vertical
    scroll (the legacy 'vscroll' shell)"_; ports `VScrollTaskPane.append_vertical`.
  - `taskTypes.ts` `taskRequiresAnswerToContinue` cites legacy `IFrameTask.hx` behavior.

### Where it lives in `coach-web/src`
Root: `/home/skelly/dev/coach/apps/web/coach-web/src`

- **Route (the player):** `routes/units/[unitName]/[moduleId]/+page.svelte` — in-app module playback.
  Vertical-scroll "vscroll" shell: reveals one question at a time (`{#if index <= currentIndex}`),
  gated behind a Continue/Check-answer button; fires module completion on the last Continue.
- **Route (unit list / launch):** `routes/units/+page.svelte`, `routes/units/[unitName]/+page.svelte`.
- **Dashboard launch surface:** `routes/+page.svelte` (home) → `handleModuleClick` gates launch on
  `areAllQuestionTypesPorted`.
- **Viewer feature dir (the ported renderers):** `lib/features/cns/viewer/`
  - `TaskRenderer.svelte` — dispatches a question to its per-type renderer.
  - `taskTypes.ts` — the **ported-type gate**. `PORTED_BASE_TYPES` (12 types): `multi_choice`,
    `short_answer`, `video_task`, `showdown_task`, `fill_in_the_blank`, `open_task`, `essay_task`,
    `true_false`, `tap_image`, `iframe_task`, `left_right_task`, `likert_task`. Two legacy classes
    deliberately NOT ported (zero real usage): `canvas_1`, `checkable_iframe_task_1`.
  - Per-type renderers: `MultipleChoiceRenderer`, `ShortAnswerRenderer`, `VideoRenderer`,
    `ShowdownTaskRenderer`, `FillInTheBlankRenderer`, `EssayTaskRenderer`, `TapImageRenderer`,
    `IframeTaskRenderer`, `LeftRightTaskRenderer`, `LikertTaskRenderer`, `DragDropRenderer`,
    `FlipCardRenderer`, plus `TaskContinueButton.svelte`, `openTaskMarkup.ts`, `taskContinueState.ts`.
  - `lib/features/cns/UnitNav.svelte`, `ModuleActions.svelte` — nav + launch affordances.
- **Playback stores:** `lib/stores/pollPlayer.svelte.ts` (per-question answer state + throttled
  save queue, `THROTTLE_MS=15_000`, flush-on-unload), `lib/stores/modulePlayer.svelte.ts`
  (module-level state transitions / completion).
- **API layer:** `lib/api/curriculum.ts` (`fetchPollContent(contentId)` → the questions to render),
  `lib/api/cns.ts` (`fetchCnsInstances`, `fetchModuleAnswers`, save/transition).

### Key PRs (evidence)
- **PR #203** `coach-module-vscroll-shell-pr14` (merged, commit `dfe8192`): _"Ports legacy vscroll
  shell UX into the in-app module player: one question revealed at a time … gated behind a
  Continue/Check-answer button"_; adds `TaskContinueButton` with grading color-flash animation and
  per-type `requiresAnswer` gating; wires fire-once completion → `goto('/units/{unitName}')`. Manual
  walkthrough was against real `curriculum-coach`/`unit_1`/`sc_u1_m1` content.
- **#448 / #463 Phase 2a** (commit `273eb53` `feat(coach-api): materialize ContentInstances at
  section grain`, plus `7609d9f` cross-track completion read overlay) — backend materializes
  ContentInstances at **section grain**. This is a coach-api change; coach-web consumes the resulting
  `CNS_CoachContentInstance` shape.

### What it renders
A **module** = a "poll" of ordered questions. `fetchPollContent(contentId)` returns
`{ contentId, title, tagList, questions[] }` where each question is `{ typeid, data }` (data is an
opaque per-typeid JSON blob, `JSON.parse`d). `TaskRenderer` dispatches by base typeid. A module only
opens in-app if **every** question type is ported (`areAllQuestionTypesPorted`) — mixed modules can't
be half-in-app/half-legacy, and the legacy `saga_api` player fallback is **retired**, so a
non-ported module surfaces an in-app `ModuleLaunchError` instead.

---

## 2. How to run coach-web locally

App dir: `/home/skelly/dev/coach/apps/web/coach-web`

### Dev server
- `pnpm dev` → **`vite dev`**. **Port = 8800** (hard-set in `vite.config.ts` `server.port: 8800`).
  ⚠️ The README says `http://localhost:5173` — that is **stale/wrong**; the checked-in vite config
  and the e2e lane (`e2e/fixtures/lane.ts`, playwright `COACH_URL`) both use **:8800**.
- Framework: SvelteKit 2 + Svelte 5 (runes), `adapter-static` with `fallback: 'index.html'`.
  `ssr = false`, `prerender = false` (client-only SPA — see `routes/+layout.ts`).
- `vite.config.ts` also allows host `.wootmath.com` (a proxy-dev helper, not needed locally).

### Required env (`.env`, checked in — no secrets in a static frontend)
File: `/home/skelly/dev/coach/apps/web/coach-web/.env`
- `PUBLIC_COACH_API_URL=http://localhost:6105` — coach-api GraphQL backend. The client hits
  `${PUBLIC_COACH_API_URL}/coach/v1/graphql` (`lib/api/graphql.ts`).
- `PUBLIC_IAM_API_URL=https://iam.wootdev.com` — **iam-api base; load-bearing boot dependency**.
  The frontend reads identity direct from iam (`auth.whoami`). For a **local mesh** this must be
  overridden to `http://localhost:3010` (the `.env` comment says so explicitly).
- `PUBLIC_LOGIN_URL=https://login.wootdev.com`, `PUBLIC_DASHBOARD_URL=https://dash.wootdev.com` —
  external hosts for logout/nav. Logout → `${PUBLIC_LOGIN_URL}/logout`.
- Override locally with **`.env.local`** (gitignored). Frontend vars MUST be `PUBLIC_*`.

### GraphQL codegen
- `codegen.ts`: schema source = `node_modules/@saga-ed/coach-gql-schema/schemas/**/*.{gql,graphql}`
  (the coach-api schema, a workspace package). Operations = `src/**/*.{graphql,gql}`.
- Generates `src/lib/api/generated/graphql.ts` (`getSdk(client)` style). **Auto-generated — do not
  edit.** `pnpm codegen`, and it runs automatically via `prebuild` before `pnpm build`.
- CNS operations live in `src/lib/api/graphql/cns.graphql` (queries `GetCnsContentInstancesByUserId`,
  `GetCnsContentInstanceById`, `GetModuleAnswers`; mutations `SaveModuleAnswer`,
  `TransitionModuleState`), plus `curriculum.graphql`, `reports.graphql`.

### Backend it talks to
- **coach-api** on `:6105` (`/coach/v1/graphql`), Apollo Sandbox at the same URL in-browser.
  Requires Postgres (Docker, port **5433** for the standalone container; the ss mesh uses **5432**).
  Bring up: `pnpm run dev:up` (Postgres + API hot reload) from `apps/node/coach-api`.
- **iam-api** on `:3010` locally (mesh) — required for identity. There is **no dev auth bypass**
  (the e2e authoring README states auth is always required; sessions are minted via `auth.devLogin`).

### Auth / login expectations
Root layout `routes/+layout.ts` boot sequence:
1. `auth.fetchSession()` → `lib/api/session.ts::fetchSessionContext()` → GET
   `${PUBLIC_IAM_API_URL}/trpc/auth.whoami` with `credentials: 'include'`.
   - `200` → `{ userId, username, screenName, verifyOnly }`.
   - `401` with a followable SagaAuth challenge → **redirects to login**, rewriting `next=` to
     `window.location.origin` (the SPA root, not iam's API URL). The layout then hangs pending the
     redirect. (`rewriteNextToOrigin` is the hand-rolled fix — the shared `janusFetch`/janus-client
     follows the challenge `login=` verbatim and would send the user to an iam JSON endpoint.)
   - `401` with no challenge, or 5xx/network → throws → **503 error page** (never a silent hang).
2. On success, `fetchCnsInstances(userId)` loads the user's ContentInstances; `instances[0]` becomes
   `data.instance`, shared with every child route via `depends('app:modules')`.

Auth model context (repo is mid-migration `saga_api → iam-api + Janus`, coach#91):
- Identity is read **direct from iam** — the old coach-api `session.context` tRPC aggregate was
  abandoned. Branch on **permissions, never role/org** (permission-driven UX). Today the app only
  needs identity (userId + display name); no permissions are fetched (zero consumers yet).
- GraphQL client routes through `janusFetch` (`lib/api/fetch.ts`) so 401-janus challenges on
  coach-domain calls redirect to login (coach#100).
- **`AuthLoginHostOverride`** (commit `d085bed`, `feat(coach-api): AuthLoginHostOverride for
  alternate-apex login redirects`) is a **coach-api** feature for training-apex deploys
  (`coach.saga-training.org`), not a coach-web knob. Relevant if the concierge targets an alternate
  apex; for the default local mesh it is not needed. (packages: `@saga-ed/iam-auth`,
  `@saga-ed/janus-client` are coach-web deps.)

---

## 3. What a developer needs present to SEE the content viewer working

The dashboard/units render from **CNS ContentInstances**, and the player renders from a **published
content release** (the poll questions). Both must be seeded, keyed to the seeded tutor:

1. **A seeded iam identity + session** for the tutor. Canonical tutor is **`demo-tutor-1`**
   (`iam-seed-ids`), userId **`1c939568-1464-5f9a-b5a4-0bc73a0454cb`**, email `demo-tutor-1@saga.org`,
   member of "Demo District", bound to `personaTutorDemo` carrying `coach:access_coach_app`. This is
   THE coach tutor the fixtures key to. (`e2e/data/seed-users.ts`.) The session cookie (`iam_session`)
   is minted via iam-api `auth.devLogin` — no interactive login.
2. **A coach Postgres ContentInstance** for that user. Seed fixture:
   `/home/skelly/dev/coach/packages/node/coach-db/src/seed/fixtures/content-instances.json` — one
   instance for `1c939568-…`, `contentName: "spring-pilot"`, v1.0.0, with units
   (`unit_1` "Pre-Service Training" 23 modules `sc_u1_m1..23`, `unit_2` "Core Concepts" 9, `unit_3`
   "Microlearnings", …). The `flows.json`/seed-users docs say the seed assigns **27 modules** that
   render on the dashboard.
3. **A published content release** (the actual poll questions the player renders). Fixture:
   `packages/node/coach-db/src/seed/fixtures/content-release.json`. Locally, `coach-db db:seed`
   loads this offline release fixture **instead of** a real publish. The API reads content via
   `ContentReadStore`/`PostgresContentReadStore`, joining through the `active_content_release`
   singleton pointer.
4. **A track/persona assignment** so the instance is derivable. Assignments are a separate seam
   (`AssignmentStore`, derived from `persona_assignment ⋈ group_track_map`). The
   **`group_track_map`** is baked into the local seed (commit `1b54e46`
   `feat(coach-db): bake group_track_map into the local seed`, PR #235).

**The one fully-ported, immediately-playable module** for demos/smoke: **`sc_u1_m1`** at
`/units/unit_1/sc_u1_m1` — the `module-playback` e2e flow navigates straight there and asserts all
12 ported base question types render. Content is a synthetic acceptance fixture in the coach-db
Postgres seed. Commit `a5e3c3d` seeded `demo-tutor-1` with a "legacy spring-pilot parity instance".

### Seed / bring-up commands (backend)
From `/home/skelly/dev/coach/apps/node/coach-api` (see its `CLAUDE.md` + `docs/quickstart.md`):
```bash
pnpm run dev:up                                   # Postgres (:5433) + coach-api (:6105) hot reload
# or: docker compose up -d --wait postgres && pnpm run dev:local
pnpm --filter @saga-ed/coach-db db:deploy         # run migrations
pnpm run db:seed:run                              # seed: progress/answer/assignment + content release
```
`coach-db`'s own seed entry: `db:seed` → `node dist/seed/local-snapshot.js`
(`packages/node/coach-db/package.json`). To load REAL archive curriculum instead of the fixture:
`coach-content publish --archive <checkout> --ref <sha> --approve` then `coach-content materialize
--user demo-tutor-1 --replace` (needs a `saga-ed/content-archive` checkout; see §4).

Frontend:
```bash
cd /home/skelly/dev/coach/apps/web/coach-web
pnpm codegen           # if generated/graphql.ts stale (prebuild runs it anyway)
pnpm dev               # vite dev on :8800
```
(For a fully-local stack, set `PUBLIC_IAM_API_URL=http://localhost:3010` in `.env.local`.)

---

## 4. README / docs / CLAUDE / AMPLIFY + the e2e "authoring" project

- **`apps/web/coach-web/README.md`** — dev/env/test guide. **Port claim (5173) is stale; real port
  is 8800.** Documents the three `PUBLIC_*` vars, `.env.local` overrides, Playwright test setup, and
  an ENOSPC/inotify workaround. `PUBLIC_IAM_API_URL` is NOT in the README's env table (it is in
  `.env` and `CLAUDE.md`).
- **`apps/web/coach-web/CLAUDE.md`** — Svelte 5 runes, structure, `pnpm codegen` rule
  (`generated/graphql.ts` auto-generated), CSS tokens, `docs/QUERY_PARAMS.md`, env `PUBLIC_*` rule.
- **`apps/web/coach-web/AMPLIFY_SETUP.md`** — a **redirect stub**: Amplify hosting moved to
  `infra/coach-web/OPS.md` during the iam/Janus migration. SSM scheme
  `/coach/amplify/coach-web/{app-id,domain,deploy-role-arn,api-base-url}`. Deploy via
  `saga-deploy-amplify`. **Not relevant to local dev / the concierge** — it's prod hosting ops.
- **`apps/web/coach-web/docs/`**: `CSS_TOKENS.md`, `ENV_FILES.md`, `getting-started.md`,
  `QUERY_PARAMS.md`, `THEME.md`. (coach-api docs: `apps/node/coach-api/docs/quickstart.md` is the
  full local-setup guide.)

### The e2e "authoring" project — is authoring the content-viewer's authoring counterpart?
**Partly, but it drives the FROZEN LEGACY stack, not a Svelte authoring app.** Details in
`apps/web/coach-web/e2e/authoring/README.md` + `playwright.config.ts`:
- The `authoring` Playwright project is gated behind **`E2E_AUTHORING=1`** (`pnpm test:e2e:authoring`)
  and kept out of the default sweep because it drives **AWS / dev-ECS** and needs credentials.
- It is the **content-authoring → publish → render pipeline**: author a poll on the **frozen legacy
  Haxe stack** (dev ECS, teacher **75949**) → `export-authored-polls.sh` (ECS Exec) →
  `records-pusher` Lambda → `saga-ed/content-archive` → `coach-content publish` → `coach-content
  materialize --user demo-tutor-1` → the title renders on the Coach dashboard.
- So: **authoring = the upstream content-production side** that feeds the ported viewer. It is the
  legacy authoring tool (no ported Svelte authoring UI exists in coach-web). The viewer (this
  research area) is the **consumer/render** side. They meet at the **content archive → coach-db
  publish/materialize** seam.
- Related non-authoring flow: **`module-playback-real-content`** (`e2e/module-playback-real-content/`)
  publishes an EXISTING archive curriculum (`base-coach`) — no AWS legs — gated by
  `PUBLISH_REAL_CONTENT=1`, needs `ARCHIVE_DIR` (a content-archive checkout). Useful precedent for a
  "real content" develop variant.

---

## 5. ss CLI concierge pattern to mirror + gaps for scenarios 4/5

- The concierge to mirror is **`ss e2e connect`**:
  `/home/skelly/dev/soa/.claude/worktrees/gh305-ss-develop/packages/node/saga-stack-cli/src/commands/e2e/connect.ts`.
  Pattern: resolve a flow from a repo's `flows.json` (`resolveFlow`), recurse a `journey`
  prerequisite (headless build owning reset+seed), then open a **headed foreground** Playwright
  project (stdio inherited so it owns the TTY). Flags of interest to mirror: `--reuse` (skip
  prerequisite rebuild + reset, run against current stack state), `--fake-media`,
  `--refresh-snapshot` (rebake prerequisite checkpoints). A develop-coach concierge is analogous but
  the "foreground hold" is **the running `vite dev` server**, not a Playwright `page.pause()`.
- **coach-web already ships a `flows.json`**:
  `/home/skelly/dev/coach/apps/web/coach-web/e2e/flows.json` — spa id `coach-web`, `repoEnvVar:
  COACH`, `appDir: apps/web/coach-web`, three flows (`dashboard`, `module-playback`,
  `module-playback-real-content`), each `seed: { profile: "full", reset: true }`, requiredSystems
  `["coach-web","coach-api","iam-api"]`. This is the seed/system contract a develop concierge reuses.
- **GAP:** coach-web is **NOT registered** in
  `packages/node/saga-stack-cli/src/core/flow/spa-registry.ts` (only `saga-dash` and `connectv3`
  are, lines 25/47). The flows.json comment claims onboarding = "this file + one row in
  spa-registry.ts", but the row does not exist yet. A develop-coach concierge that resolves the
  coach-web flows.json likely needs that registry row added first (or its own discovery path).
- **GAP (scenarios 4 & 5):** the coach repo has **only `coach-web`** under `apps/web/` (verified:
  `ls apps/web/` = `CLAUDE.md`, `coach-web`). There is **no admin-dashboard app/route** and **no
  playlisting interface** in the repo today — no matching routes in `coach-web/src/routes`, no
  branches (only `fix/coach-dashboard-no-track-empty-state`), no open issues found for "playlist"/
  "admin dashboard". The `PlaylistData` type in `lib/types/coach.ts` is just a curriculum-content
  shape, not a playlisting UI. **These scenarios appear to be forward-looking / not-yet-built** — a
  key open question for the develop-coach plan.

---

## Open questions / risks for the builder

1. **spa-registry gap:** does the develop topic reuse `spa-registry.ts` + coach-web `flows.json`, and
   if so does onboarding require adding the missing `coach-web` registry row? (Confirm with the
   soa#305 area owner / the ss develop-topic scaffolding research.)
2. **Scenarios 4 (admin dashboard) & 5 (playlisting) do not exist in the coach repo.** Are they
   planned/in-flight elsewhere, or does the concierge only need to stand up the routes when they
   land? Prompt-2 says they "currently ship with the coach repo" — that is **not true today**.
3. **iam-api local availability:** the concierge must guarantee iam-api on `:3010` (or wootdev) and
   an `.env.local` override of `PUBLIC_IAM_API_URL`, else coach-web 503s on boot. How does the ss
   mesh currently expose iam-api, and does it mint `demo-tutor-1`'s `iam_session` via `auth.devLogin`
   for a non-Playwright (browser) developer session? (The e2e flows mint it inside Playwright
   globalSetup — a develop concierge needs the cookie in the developer's own browser.)
4. **Postgres port mismatch:** coach-api docs use `:5433` (standalone container); the ss mesh /
   real-content lane use `:5432`. Confirm which the develop stack uses and that `DATABASE_URL` /
   `db:seed` target the mesh DB.
5. **Login redirect UX for a developer:** on a genuinely-local stack, does `auth.whoami` 401 produce
   a followable challenge that lands the developer back on `:8800`? If iam is remote (wootdev), the
   `next` rewrite sends them to the SPA origin — verify that round-trips for a local `:8800` origin.
6. **README port bug (5173 vs 8800):** worth fixing so the concierge's "open this URL" message is
   correct; the authoritative port is 8800.

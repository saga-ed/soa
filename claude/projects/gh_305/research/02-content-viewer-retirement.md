# 02 — Content-Viewer Retirement (legacy haxe ContentViewer → SvelteKit module player)

Research for the `ss develop coach` concierge (saga-ed/soa#305). Area: Seth Paul's
effort to retire the legacy haxe ContentViewer in favor of the in-app port. History,
status, and what "run new coach with the ported content viewer" requires today.

> Scope note: `#448`/`#463` referenced in the task are **saga-dash** issues (the
> cross-track / section-grain progress requirements). The coach-side work that
> implements them lands as coach PRs `#230`/`#232`/`#237`. All PR/issue numbers below
> are `saga-ed/coach` unless prefixed `soa#` or `saga-dash#`.

---

## Headline

The legacy "ContentViewer" is a **Haxe** app (`saga-ed/wmap-port`, the `vscroll_task`
lib) that Woot Math / Saga used to play "modules" (real-time-poll question sequences)
to students. Seth's port reimplements it natively **inside coach-web** as a SvelteKit
"module player" (`apps/web/coach-web/src/routes/units/[unitName]/[moduleId]/`) driving
**13 per-type renderers** for the 12 ported task types. The port is functionally landed
on `main` (renderer PRs #182–#203, capped by the gated-reveal/animation/completion
shell PR #203 and the e2e coverage PR #200). What remains is **content-parity / data**,
not viewer code: local playback still serves the synthetic `curriculum-coach` fixture
(27 polls), the real `spring-pilot` legacy-parity release is not yet published for
playback, the Mongo→Postgres content cutover is undeployed (#181), and cross-track /
section-grain / tag-filter progress (#230/#232/#237) is still in flight. For the
concierge, the load-bearing rough edge is **soa#300**: this repo's ss manifest still has
stale coach-web↔iam browser-auth wiring, so a local coach-web 503s at sign-in out of the
box.

---

## 1. What the legacy ContentViewer was

- **Repo:** `saga-ed/wmap-port` ("Woot Math Adaptive Practice — AS3 to Haxe port",
  private). The ContentViewer lives in the Haxe lib
  `archive/woot_hxlib/lib/vscroll_task/src/vscroll/` — key sources:
  `VScrollTaskPane.hx`, `VscrollViewerApp.hx`, `VscrollViewerContentScreen.hx`,
  `AVQueue.hx`, `AudioWidget.hx`, `state/PollDataStateManager.hx`, `ItemNav.hx`.
- **What it did:** rendered a "module" = an ordered sequence of poll questions
  ("tasks"), one revealed at a time (vertical-scroll / "vscroll" incremental append),
  gated behind a Continue / Check-answer button with a grading color-flash animation,
  optional feedback markdown and blocking audio/video, then fired completion. Data came
  from `/woot_roster/v1.1/poll-inst/${instance_id}` (`PollDataStateManager.hx`).
- **Where it was embedded / what depended on it:** it was a **separate legacy web app**
  the coach web-app had to interoperate with. Per
  `coach/claude/projects/sub-domain/` (Feb 2026 cross-domain architecture research),
  legacy ContentViewer was served under `my.sagaeducation.org/auth/content-viewer/`
  while new coach ran on Amplify — the original hard problem was "seamless navigation
  between Coach and legacy ContentViewer" sharing auth across domains. The port
  **removes that cross-domain problem entirely** by bringing playback in-app.
- Host-specific hooks in the legacy source (Skye/Spark): `window.__spark_close()`,
  `'/spark-pages#/'`, `window.__set_content_completed` (quest-award). These were
  **explicitly dropped**, replaced by a coach-native `goto()` back to the unit page
  (see `claude/module-viewer/pr14-pr15-vscroll-shell-scoping.md`, item 5).

---

## 2. The port — what exists today (landed on `main`)

**The ported viewer lives in coach-web:**
- Renderers (13 `.svelte` files):
  `apps/web/coach-web/src/lib/features/cns/viewer/` — `TaskRenderer.svelte`
  (dispatcher) + 12 per-type renderers: `MultipleChoiceRenderer`, `ShortAnswerRenderer`,
  `VideoRenderer`, `ShowdownTaskRenderer` (markdown), `FillInTheBlankRenderer`,
  `FlipCardRenderer` (open_task flip), `DragDropRenderer` (open_task categorize/match),
  `EssayTaskRenderer`, `TapImageRenderer`, `IframeTaskRenderer`, `LeftRightTaskRenderer`,
  `LikertTaskRenderer`. Each has a `__tests__/*.spec.test.ts`.
- Player shell / state:
  `apps/web/coach-web/src/routes/units/[unitName]/[moduleId]/+page.svelte`,
  `apps/web/coach-web/src/lib/stores/pollPlayer.svelte.ts`,
  `apps/web/coach-web/src/lib/stores/modulePlayer.svelte.ts`.

**PR timeline (the port series, all merged to `main`):**
| PR | What | State |
|---|---|---|
| #182 | PR1 — answer-persistence backend for the port | MERGED |
| #184 | poll-content read for the viewer | MERGED |
| #186–#197 | PR3–PR13 — port each renderer type (showdown, fitb, flip/open, catmatch drag-drop, essay, true_false, tap_image, iframe, left_right, likert, MC/short-answer/video) | mix MERGED/CLOSED-superseded |
| #203 | PR14 — gated reveal + grading color-flash animation + fire-once completion wiring ("vscroll shell") | **MERGED** |
| #200 | e2e `module-playback` flow covering all 12 ported renderer types | **MERGED** |

- **Backend content read is already Postgres-bound.** `apps/node/coach-api` DI binds
  `ContentReadStore → PostgresContentReadStore` unconditionally
  (`inversify.config.ts:80-83`). #207 (Phase 1/4) flipped the default off Mongo. So the
  ported viewer serves module content out of the active Postgres `content_release`, not
  from legacy Mongo. (Mongo curriculum is still seeded/read for the *structure* /
  dual-store path — see `coach-api` manifest `mesh: ['connect-mongo']`.)
- **PR14/PR15 fidelity scope** (`claude/module-viewer/pr14-pr15-vscroll-shell-scoping.md`):
  ported verbatim from legacy — gated reveal, 2.5s color-flash keyframes, feedback
  markdown, blocking audio/outro-audio (AVQueue model). **Deliberately dropped:**
  `task_timer`/`CC_TIMER_BLOCKED` (3/112 modules), splash screen, standalone progress
  bar, Skye host hooks. **Deferred (unread in scoping):** `CC_INTERACTIONS_BLOCKED` /
  `are_required_interactions_complete()`.

---

## 3. The two-store / content pipeline this rides on (Seth's parallel effort)

The port depends on a Mongo→Postgres re-architecture (`claude/coach-content-two-store-plan.md`,
Jun 2026). Relevant facts for the concierge:
- **Read content = git archive, not Mongo.** `saga-ed/content-archive` (private, data-only
  repo) is the system of record for authored polls + the **8 `content_coach` curriculum
  structure docs** (`base-coach`, `original-coach`, `partners-coach`, `qtf-coach`,
  `preservice-coach`, `curriculum-coach`, `spring-pilot`, `new-mexico-coach`), together
  referencing **112 distinct module content_ids**, all `REAL_TIME_POLLS`.
- **Publish CLI:** `@saga-ed/coach-content-publish` (`packages/node/coach-content-publish`,
  the `coach-content publish` command) reads the archive + structure docs and cuts a
  Postgres **content_release** (snapshot + `active` pointer). PR #180 shipped the full
  pipeline; #234 fixed a full-archive (643-poll) publish that failed over the SSM tunnel
  by lifting the Prisma `$transaction` timeout to 120s.
- **Progress = Postgres** (`@saga-ed/coach-db`, `coach_api` DB). Per-user `content_instance`
  (nav graph + progress), `progress_store`, plus the three iam→coach projection tables
  (`persona_definition`, `persona_assignment`, `group_track_map`).

---

## 4. Cross-track / section-grain progress (in-flight, #448/#463 series)

Implements saga-dash#448 (cross-track completion) + saga-dash#463 (section-grain).
4-PR plan:
- **#230 (MERGED)** Phase 1 — read-time overlay: a module completed on one track reads
  COMPLETE when the same `content_id` resurfaces on another track. Read-only overlay
  (`getContentInstanceById`), does not write `completed_modules` or cascade holds.
- **#232 (MERGED)** Phase 2a — materialize `content_instance` at **section** grain, not
  just district (`MATERIALIZED_GROUP_KINDS = [district, section]`).
- **#237 (DRAFT)** Phase 2b — content **tag-filter** narrowing + grain-rank resolution
  (section's `tagFilter` wins over district on the same content_name).
- **Phase 3 (planned, not started)** — a **standalone admin app** (referenced in #230's
  body as "subsequent PRs: … standalone admin app"). This is relevant to prompt-2
  **scenario 4** (coach + admin dashboard) but is NOT the content-viewer.

---

## 5. Timeline (compressed)

- **Feb 2026** — cross-domain architecture research; legacy ContentViewer is a separate
  app at `my.sagaeducation.org/auth/content-viewer/` requiring cross-domain auth.
- **Jun 17 2026** — two-store split plan drafted; premise "archive is the richer source"
  vindicated against prod replica (`saga_blank`).
- **Jun 30 – Jul 2** — Postgres progress store (#147/#155), content-release store (#172),
  ContentReadStore seam (#173), publish CLI (#174), PostgresContentReadStore (#175),
  authoring e2e (#176/#180).
- **Jul 7–9** — the renderer port series (#182–#197), gated-reveal shell #203, e2e #200,
  content-backend default flipped to Postgres #207.
- **Jul 11–13** — persona seed onto `iam-seed-ids` demo-* users (#223/#05ba3ae),
  session.context S2S abandoned; **coach-web reads identity direct from iam (#226)** —
  the change that made soa#300 necessary.
- **Jul 13** — legacy spring-pilot **dashboard/progress parity** seed (#228, commit
  a5e3c3d), full-archive publish timeout fix (#234), `group_track_map` baked into local
  seed (#235).
- **Jul 14 (today)** — #237 Phase 2b DRAFT; #236 dashboard empty-state DRAFT.

---

## 6. DONE vs REMAINING ledger

**DONE (on `main`):**
- All 12 task-type renderers + dispatcher, in coach-web.
- Gated reveal / grading animation / fire-once completion shell (#203).
- e2e module-playback smoke covering all 12 types (#200).
- Postgres content-read + publish pipeline; content default = Postgres (#207).
- Local `db:seed` publishes a playable synthetic `curriculum-coach` release (27 polls).
- Legacy `spring-pilot` **dashboard + progress** parity for `demo-tutor-1` (#228, 59
  modules, 13 complete).
- `group_track_map` seeded so `reconcile` + assignment-read resolve (#235).

**REMAINING / IN-FLIGHT / gaps:**
- **Playback content ≠ dashboard content (the headline parity gap).** #228 seeded the
  59-module `spring-pilot` `content_instance` for the **dashboard/My-Progress** surface,
  but **Explore / in-app playback still renders the synthetic `curriculum-coach`**
  fixture — publishing the real `spring-pilot` content *release* for playback is an
  explicit **deferred follow-up** (#228 "Scope"/"Verification" notes). So a dev running
  local coach sees legacy-parity numbers on the dashboard but synthetic questions when
  they open a module.
- **Mongo→Postgres cutover undeployed (#181, OPEN).** No deployed env (dev/qa/prod) has
  `CONTENT_STORE_BACKEND=postgres` or a real published release; `content_assignments`
  stays on Mongo (ownership TBD). Local is Postgres-bound; deployed is not.
- **Cross-track progress incomplete:** #237 (Phase 2b tag-filter) DRAFT; Phase 3
  standalone admin app not started.
- **Deferred viewer features:** `task_timer`, `CC_INTERACTIONS_BLOCKED` (see §2).
- **Legacy paths still present:** legacy ContentViewer haxe still lives in
  `saga-ed/wmap-port`; coach-api retains the dual-store Mongo read path (curriculum
  structure) — not fully retired.

---

## 7. CRUCIAL for the concierge — run "new coach + ported content viewer" locally

**Services required (end-to-end):**
1. `iam-api` (identity; coach-web calls its `auth.whoami` **from the browser** post-#226)
   + iam Postgres + iam seed (`demo-*` users from `@saga-ed/iam-seed-ids`).
2. `coach-api` (port 6105, `EXPRESS_SERVER_PORT`) — needs `coach_api` Postgres **and**
   the mesh Mongo (`connect-mongo`) for curriculum structure. Env in ss manifest
   `packages/node/saga-stack-cli/src/core/manifest/services.ts:475-513`.
3. `coach-web` (port 8800, SvelteKit SPA) — manifest lines 515-538.
4. mesh Mongo + Postgres containers.

**Seed steps (ss `full` profile — `src/core/seed/profiles.ts:45`):**
- `coach-pg` — runs coach-db `db:seed` (`packages/node/coach-db`, `node dist/seed/local-snapshot.js`)
  against `coach_api` PG. Writes `content_instance` (spring-pilot, 59 modules for
  demo-tutor-1), progress, persona projections (`persona_definition`,
  `persona_assignment`, `group_track_map`), **and publishes the `curriculum-coach`
  content_release + `active` pointer** (27 polls) so `PostgresContentReadStore` has
  something to serve (else it throws "no active content release").
  Source: `packages/node/coach-db/src/seed/local-snapshot.ts` (+ `fixtures/`).
- `coach-mongo` — `mongoimport --upsert` of `apps/node/coach-api/scripts/data/content_coach.json`
  → `saga_local.content_coach` and `content.json` → `wmlms_local.content` (curriculum
  structure for the dual-store read path). `profiles.ts:427-467`. Best-effort (`warn`).

**Login / persona:** seeded tutor is `demo-tutor-1` (`1c939568-…`, from iam-seed-ids), the
one with the spring-pilot instance. The one fully content-populated playback module in the
fixtures is `content-sc_u1_m1` at route `/units/unit_1/sc_u1_m1` (the e2e #200 target;
seeded tutor there is `alex` with an `iam_session` cookie).

**KNOWN ROUGH EDGE — soa#300 (OPEN, blocks browser-testing local coach-web):**
This worktree's manifest is still the STALE pre-#226 wiring. Verify:
- `coach-web` `launch.env` sets **only** `PUBLIC_COACH_API_URL: '${COACH_API_URL}'`
  (services.ts:531-533) with the stale comment "Reaches iam server-side THROUGH
  coach-api" (line 524). Post-#226 coach-web calls `${PUBLIC_IAM_API_URL}/trpc/auth.whoami`
  **from the browser**; with no override it falls back to its checked-in `.env`
  `PUBLIC_IAM_API_URL=https://iam.wootdev.com` (remote) → local cookie invalid → **503 at
  sign-in**.
- `iam-api` `CORS_ORIGIN` is `${DASH_URL},${CONNECT_WEB_URL}` — **no coach-web origin** →
  the direct browser `whoami` is CORS-blocked.
- **Fix (per soa#300, not yet applied here):** add
  `PUBLIC_IAM_API_URL: '${IAM_URL}'` to `coach-web` `launch.env`; add a `COACH_WEB_URL`
  token and append it to `iam-api` `CORS_ORIGIN`. The develop-coach concierge should
  either depend on soa#300 landing or set these itself. Prior manual workaround (#228):
  run coach-web from a worktree with `PUBLIC_IAM_API_URL=http://localhost:3010` and a
  `--disable-web-security` chromium — data layer (coach-api GraphQL) was fine; only the
  browser↔iam auth wiring was broken.

**Concrete commands:**
```bash
# ss stack (from soa) — bring coach up with its deps + full seed
ss up --with coach            # (or the closure that includes iam-api + coach-api + coach-web)
ss seed --seed full           # includes coach-pg (db:seed) + coach-mongo
# coach-web then at http://localhost:8800 ; coach-api at :6105 ; iam at ${IAM_URL}

# manual coach seed (from ~/dev/coach) if driving coach-db directly:
pnpm --filter @saga-ed/coach-db build
DATABASE_URL=<coach_api pg url> pnpm --filter @saga-ed/coach-db db:seed
#   → "N content_release (active: fixture, 27 polls)" + spring-pilot instance

# publish the REAL archive release for playback (closes the §6 parity gap; needs content-archive checkout):
#   coach-content publish --archive <content-archive path> --ref <sha> --app coach
#   (see packages/node/coach-content-publish; #234 fixed the full 643-poll publish)

# e2e that exercises the ported viewer (proves all 12 renderers):
ss e2e run coach-web/module-playback --coach=<worktree>
```

---

## 8. Key files & pointers (absolute)

- Ported renderers: `/home/skelly/dev/coach/apps/web/coach-web/src/lib/features/cns/viewer/*.svelte`
- Player shell: `/home/skelly/dev/coach/apps/web/coach-web/src/routes/units/[unitName]/[moduleId]/+page.svelte`
- Player state: `/home/skelly/dev/coach/apps/web/coach-web/src/lib/stores/pollPlayer.svelte.ts`, `.../modulePlayer.svelte.ts`
- Content read binding: `/home/skelly/dev/coach/apps/node/coach-api/src/inversify.config.ts:80-83`
- Postgres read store: `/home/skelly/dev/coach/apps/node/coach-api/src/services/content-store/postgres-content-read-store.ts`
- Local seed (publishes release + instance): `/home/skelly/dev/coach/packages/node/coach-db/src/seed/local-snapshot.ts` (+ `fixtures/content-release.json`, `fixtures/content-instances.json`)
- Publish CLI: `/home/skelly/dev/coach/packages/node/coach-content-publish/`
- Two-store plan: `/home/skelly/dev/coach/claude/coach-content-two-store-plan.md`
- Port scoping: `/home/skelly/dev/coach/claude/module-viewer/pr14-pr15-vscroll-shell-scoping.md`
- Cross-domain / legacy-ContentViewer research: `/home/skelly/dev/coach/claude/projects/sub-domain/research/coach-cross-domain-architecture.md`
- ss coach manifest (STALE — soa#300): `/home/skelly/dev/soa/.claude/worktrees/gh305-ss-develop/packages/node/saga-stack-cli/src/core/manifest/services.ts:475-538`
- ss seed profiles (coach-pg / coach-mongo): `/home/skelly/dev/soa/.claude/worktrees/gh305-ss-develop/packages/node/saga-stack-cli/src/core/seed/profiles.ts:410-467`
- Legacy haxe ContentViewer: `saga-ed/wmap-port` → `archive/woot_hxlib/lib/vscroll_task/src/vscroll/` (GitHub only, not cloned)
- Content data repo: `saga-ed/content-archive` (GitHub only)

---

## 9. Open questions for the develop-coach plan

1. **Which content should `ss develop coach` playback show?** Ship-with-synthetic
   `curriculum-coach` (works today, `db:seed` only) OR publish the real `spring-pilot`
   release for true legacy parity (needs a content-archive checkout + `coach-content
   publish` as a concierge step)? The dashboard already shows spring-pilot; playback does
   not — a dev will notice the mismatch.
2. **Does the concierge fix soa#300 itself, or block on it?** Without the manifest fix,
   local coach-web 503s at sign-in — the concierge cannot "hand off a logged-in browser".
3. **Login mechanism:** mint an `iam_session` cookie for `demo-tutor-1` (dashboard/parity
   persona) or `alex` (the e2e-seeded persona with the one fully-populated playback
   module `sc_u1_m1`)? They differ in which content is populated.
4. **Scenarios 4 & 5 (admin dashboard / playlisting)** — the "standalone admin app" is
   Phase 3 of the #448/#463 plan and **not yet built**; playlisting has no located
   artifact yet. Confirm these are separate research areas, not part of content-viewer.
5. **Mongo dependency:** coach-api still needs mesh Mongo for curriculum structure even
   though content reads are Postgres — confirm the concierge closure includes
   `connect-mongo` and runs `coach-mongo` seed (both are in the `full` profile).

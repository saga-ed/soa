# gh_305 — `ss develop` concierge topic, coach-first: plan

_Evidence for every claim here lives in `../research/01`–`06` + the gap-critic verdict. File:line
pointers below were spot-verified against real files during research._

## Bottom line

`develop coach` is **~90% orchestration over primitives that already exist** and **~10% new code
concentrated in three spots**. The heavy lifting (coach in the ss manifest, a `--with coach`
bundle, coach-pg/coach-mongo seed steps, `resolveFlow`/`executeResolvedFlow`, coach's own authored
`e2e/flows.json`, tunnel overlay, slot>0 support for coach-web) is **already built**. So this
effort is not a from-scratch build — it's: land one prerequisite fix, make three small
generalizations, migrate `connect`, and wire the `develop` topic.

Three research findings reframe the work:

1. **soa#300 is the single load-bearing prerequisite** gating *all three* coach browser scenarios
   (coach-web ↔ iam auth). It's a fully-specified ~2-line manifest fix. **Step 1, regardless of who
   "owns" the PR.**
2. **prompt-2 is factually wrong on 2 of its 5 scenarios.** The admin "dashboard" (scenario 4) is a
   **mock-backed** Reports route *inside* coach-web (`reportsStore.fetchReport → getMockReport`), not
   a separate app. **Playlisting (scenario 5) has no coach-web UI at all** — it's a saga-dash/
   rostering surface plus coach's `group_track_map`/`content_name` track model. So "fully build the
   admin dashboard and playlisting" as written is **not buildable without a product/scope decision**
   (see "Open decisions").
3. **The content viewer (scenario 3) is real, landed, and mostly a data + login story.** It's
   coach-web's in-app SvelteKit **module player** (`lib/features/cns/viewer/*` +
   `/units/[unitName]/[moduleId]/+page.svelte`) that reimplements the legacy Haxe ContentViewer
   (`saga-ed/wmap-port`, `PollDataStateManager.hx` → `pollPlayer.svelte.ts`). It renders in-app only
   when every question type is ported (12 base types today); the legacy `saga_api` fallback player
   is retired.

## What we're building (and the order)

**Primary deliverable this cycle: a first-class `ss develop coach` that drops a developer into a
running, logged-in coach with the ported content viewer showing real assigned content.** That is
scenario 3, done properly. Scenarios 4/5 are gated on a scope decision below. The `develop` topic is
built to extend to saga-dash/ads/sis later, but their substance is explicitly out of scope here.

---

## Architecture: the `develop` topic + the concierge contract

`e2e connect` is a **thin command over a pure `resolveFlow` + generic `executeResolvedFlow`**
(`research/05`). The concierge machinery is already SPA-generic. Onboarding a new app is "one command
file + one `spa-registry` row + an authored `flows.json`." The genuinely-new code:

### The 3 new code pieces (the entire "new" surface)

1. **Parameterize the login persona.** `holdEpilogue` (`src/commands/e2e/run.ts:416`) hardcodes
   `const email = DEFAULT_LOGIN_USER;` (`dev@saga.org`). A coach hand-off with `dev@saga.org` mints an
   **empty** dashboard. → Thread an `email`/persona param through `holdEpilogue → mintNativeLoginJar`,
   default `dev@saga.org`, override `demo-tutor-1@saga.org` for coach (and `demo-dadmin@saga.org` for
   the admin scenario if in scope).
2. **Generalize the browser opener.** `openVendoredBrowser` resolves `SAGA_DASH` via
   `resolveRepoRoot('SAGA_DASH')` and **warn-and-skips the whole browser step if saga-dash isn't
   cloned** (`base-command.ts:977-1001`). A coach-only dev gets no browser even with a valid coach
   jar. → Parameterize on `{repoEnvVar, appDir, port}` from the `spa-registry` row; drive the
   clone-gate off the SPA's repo, not saga-dash. **This is the single largest new piece.**
3. **Register coach-web + the topic.** Add the `coach-web` row to
   `src/core/flow/spa-registry.ts` (today only `saga-dash` + `connectv3`), register the `develop`
   oclif topic (`package.json` `oclif.topics` + `src/commands/develop/`), and add the thin command
   file(s).

Everything else is **data + a decision.**

### Command shape (recommended)

One `ss develop coach` command with a `--scenario` selector (`content-viewer` [default] `| admin |
playlist`), because scenarios differ only by a `COACH_FLOW` constant + persona fed to `resolveFlow`.
`--reuse`, `--tunnel`, and `-- <passthrough>` mirror connect. (Alternative: separate subcommands —
more discoverable, more files. Selector is less code and matches how the flows differ.)

---

## Deliverable 2 — migrate `e2e connect` → `develop connect` (+ deprecating alias)

- Move `src/commands/e2e/connect.ts` → `src/commands/develop/connect.ts` (its AV-specific flags
  `--fake-media`/`--refresh-snapshot` come along verbatim; migration is near-mechanical).
- Leave a **deprecating alias** at `e2e connect`. Recommended: on the migrated command,
  `static aliases = ['e2e:connect']` + `static deprecateAliases = true` (@oclif/core ^4).
  **Caveat (verify at build):** there is *zero* existing `aliases`/`deprecateAliases` usage in this
  CLI, so the exact runtime warning is untested here. **Prototype early:** run `ss e2e connect
  --help` and `ss e2e connect` once; if the warning/dispatch don't behave, fall back to a thin
  `e2e/connect.ts` warn-and-delegate shim.
- Update docs to split **test-running** (`e2e list`/`run`/`traces`) from **dev setup** (`develop`).

## Deliverable 1 — the coach development experience

### Prerequisite (Step 0, blocks everything): land the soa#300 manifest fix

coach-web reads identity **directly from iam-api** at boot (`+layout.ts` → `auth.whoami`,
`credentials:include`); a 401 challenge redirects to login. The base manifest sets **no**
`PUBLIC_IAM_API_URL` override (defaults to remote `iam.wootdev.com`) and iam's `CORS_ORIGIN` omits
coach-web, so **local coach-web 503s / can't sign in**. Fix (verified ~2 lines):
- Add `PUBLIC_IAM_API_URL: '${IAM_URL}'` to coach-web's launch `env` in the manifest.
- Append a `COACH_WEB_URL` token to iam-api's `CORS_ORIGIN`.
This works precisely because the manifest launches coach-web via `pnpm dev` (SvelteKit inlines
`$env/static/public` at dev-server start). **gh_305 lands this fix itself** (recommended — it's tiny
and unblocks the entire effort) rather than depending on a separate PR.

### Scenario 3 — ported content viewer (PRIMARY, fully in scope)

Target state: `ss develop coach` (default `--scenario content-viewer`) brings up the coach closure
(coach-api pg + coach-web + iam-api + curriculum mongo), seeds via coach's `flows.json` (`seed:
full`, which already resets+seeds coach correctly — **no new bundle seed-add-on required**), mints
an **iam_session for `demo-tutor-1`**, and opens a headed browser at coach-web (`:8800`) already
logged in, on the dashboard, with the fully-ported module `sc_u1_m1` at `/units/unit_1/sc_u1_m1`
playable.

Two content-source sub-decisions (see Open decisions): **(a)** synthetic `curriculum-coach` that
works today via `db:seed` alone [recommended v1], vs **(b)** publish the real `spring-pilot` release
for legacy parity (needs a `content-archive` checkout + `coach-content` publish as a concierge step).
Pin `CONTENT_STORE_BACKEND` explicitly in the coach-api launch env rather than relying on the
disputed default (docs 02 vs 06 conflict on what the unset default serves).

### Scenario 4 — admin dashboard (SCOPE DECISION REQUIRED)

Reality: the admin surface is the **mock-backed Coach Reports route** in coach-web
(`reportsStore.fetchReport → getMockReport`); no live org table, and the seed materializes only **one**
tutor on one track, so a live report would be a single row. Options in "Open decisions."

### Scenario 5 — playlisting (SCOPE DECISION REQUIRED)

Reality: **no coach-web playlisting UI exists.** Playlist selection is a saga-dash/rostering surface
(`user_policy.playlist_name`/`available_playlists`); coach's side is the `group_track_map`/
`content_name` track model, and only one track (`spring-pilot`) is seeded. Options in "Open decisions."

## Deliverable 3 — extensibility (topic scaffolding only)

The `e2e→develop` split is clean and the topic is genuinely extensible: adding an app is "one command
file + one `spa-registry` row + an authored `flows.json`." We build the topic so `develop saga-dash`
/ `develop ads` / `develop sis` (prompt-1 scenarios 2/6/7) slot in later. **Their substance is out of
scope here and each needs its own research pass** (ads/sis weren't researched; whether they're even
SPAs with flows.json is unknown).

---

## Phased implementation (for ultracode)

- **M0 — Prereq:** land the soa#300 manifest fix; verify local coach-web signs in against local iam.
- **M1 — Topic + connect migration:** create `develop` topic; move `connect.ts`; wire the
  deprecating alias; **prototype-verify the alias runtime behavior**; docs split. Full suite green.
- **M2 — Concierge generalizations:** (1) persona-email param through `holdEpilogue`; (2) generalize
  `openVendoredBrowser` to `{repoEnvVar, appDir, port}`; (3) add coach-web `spa-registry` row. Unit
  tests for each; no behavior change for existing saga-dash/connect paths.
- **M3 — `develop coach` (content-viewer):** thin command; `--scenario` selector; drive coach flow +
  `demo-tutor-1` mint + headed coach-web hand-off; pin `CONTENT_STORE_BACKEND`. **Live-verify on ss
  slot 1**: logged-in dashboard + `sc_u1_m1` plays.
- **M4 — scenarios 4/5** per the scope decision (descope-and-document, or funded coach-repo work).
- **M5 — docs + PR polish:** `docs/develop.md`, README/e2e pointers, deprecation notes.

Each milestone: `pnpm typecheck` + full vitest suite + a real-binary/live check on slot 1 where a
runtime surface exists (per repo `/verify` convention).

## Open decisions (need your call before/at ultracode)

1. **Scenarios 4 & 5 scope.** (a) *Descope to concierge-only* for v1: bring up + seed + hand off +
   **document** the current mock-admin / no-playlist-UI reality [recommended — keeps this a pure-ss
   effort]; or (b) *fund coach-repo product work*: rewire `reportsStore.fetchReport →
   fetchCoachReport` + seed `demo-tutor-2`/`demo-dadmin` multi-row fixtures for a live admin, and
   define playlisting = a ≥2-track `group_track_map` switch demo (needs a 2nd published track).
2. **Content-viewer content source.** (a) synthetic `curriculum-coach` (works today, zero extra work)
   [recommended v1]; or (b) publish real `spring-pilot` via `coach-content` for legacy parity (needs
   a `content-archive` checkout + an `ARCHIVE_DIR`/publish concierge step).
3. **Command shape.** One `develop coach --scenario …` [recommended] vs separate subcommands.

Recommended defaults let ultracode proceed immediately on M0–M3 (the real coach experience) while
M4's shape waits on decision #1.

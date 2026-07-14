# gh_305 — build report (ultracode, 2026-07-14)

## Shipped (both branches pushed; PRs open as drafts)

| Repo | Branch | PR | Commits |
|---|---|---|---|
| soa | `worktree-gh305-ss-develop` | **#306** | soa#300 fix, develop topic+connect+alias, M2 generalizations, `develop coach`, playlist fix |
| coach | `feat/coach-content-playlist-assign` | **#239** (issue #238) | `playlist` verb, 2nd seed track |

### soa (`develop coach`)
- **soa#300 prereq** (`2626d5a`): coach-web `PUBLIC_IAM_API_URL` + iam CORS `COACH_WEB_URL` → local browser can sign in.
- **develop topic + connect** (`b082a40`): `e2e connect` → `develop connect`; deprecating alias verified at runtime (`ss e2e connect` warns + dispatches). Docs split test-running vs dev-setup.
- **Concierge generalizations** (`30c0dae`): persona-email through `holdEpilogue`; `openVendoredBrowser` → `{repoEnvVar,appDir,port}`; `coach-web` registered. Existing saga-dash/connect callers byte-identical.
- **`develop coach`** (`b275463`): `--scenario content-viewer|admin|playlist`; `CONTENT_STORE_BACKEND=postgres` pinned; headed coach-web hand-off as `demo-tutor-1`.
- **playlist fix** (`51b0448`): switch demo-tutor-1 onto the real 2nd track `curriculum-coach-b` using the `deriveUserId('demo-tutor-1')` UUID; fail-fast precheck; de-masked test.

### coach (`playlist` verb)
- **verb** (`90b304b`): `coach-content playlist assign|list|unassign`, writes only `group_id→content_name`, no `user_policy` reads, additive to #237.
- **2nd seed track** (`58ce8f9`): materializable `curriculum-coach-b` twin in the offline seed release (additive).

## Verification done (unattended-appropriate)
- soa: `check-types` clean; **1177 tests pass**. coach: build+typecheck green; coach-content 42 pass (15 DB-gated skipped).
- Runtime smokes: `ss e2e connect --help` (deprecation notice + dispatch), `ss develop coach --help`.
- Adversarial review → found 1 real bug (playlist non-functional) → fixed → independent re-review verdict **fixed-correctly, no regressions**.

## Owed: live verification (the human's to run on slot 1)
Not run by the build — it resets+seeds the stack (would clobber active slot-1 work) and opens a **headed, TTY-holding** browser (interactive by design). Run when ready:

```bash
# content-viewer (primary): logged-in coach-web on the ported module player
ss develop coach --slot 1                          # --scenario content-viewer is default
# confirm: coach-web signs in (soa#300), lands on demo-tutor-1's dashboard,
#          /units/unit_1/sc_u1_m1 plays.

# playlist (needs coach#239 verb + curriculum-coach-b seed on the coach checkout):
ss develop coach --slot 1 --scenario playlist
# confirm: demo-tutor-1 visibly switches spring-pilot -> curriculum-coach-b.

# admin (descoped v1): opens the mock-backed Reports route
ss develop coach --slot 1 --scenario admin
```

Un-proven until then: the actual stack bring-up + coach-web browser sign-in, and the playlist DB
materialize/switch against a live `coach_api` Postgres. PRs kept as **drafts** pending this check.

## Deferred (tracked, not in this cycle)
- Option B playlisting: legacy `saga_api` `user_policy` selection cutover + iam-policy→`group_track_map` projector for prod parity.
- `develop saga-dash` / `ads` / `sis` (prompt-2 scenarios 2/6/7) — topic is built to extend; each needs its own research pass.
- Cosmetic: stale `contentHash` in the coach seed fixture (nothing validates it).

## Live test on slot 2 (2026-07-14) — 3 fixes made + verified; one residual (coach-web / #300)

Ran `ss develop coach --slot 2` live. It surfaced and I fixed **three real bugs** (all committed +
pushed + verified live):

1. **`bf089c5` slot-aware** — `develop coach` hard-errored at `--slot > 0` (missing `slotAware()`).
   (Also learned: the dev binary needs `dist` rebuilt — gitignored — for changes to take effect.)
2. **`8544166` reset ordering (soa#253 recurrence)** — `api.reset()` truncated the iam permission
   catalog then re-seeded only `iam-dev-user`, so the dev-admin grant failed on session perms
   053/054/055. Now `iam-registry` runs first. **Verified live: the seed error is GONE.**
3. **`c8f96e4` slot-profile threading** — `develop coach` passed `undefined` profile to
   `buildStackContext` (+ lacked `applyInstanceEnv`/prep seams/stateDir), so `--slot N` silently ran
   at slot 0. Now threads the profile like `e2e run`. **Verified live: DBs at `:7432`, services at
   slot-2 offset ports (iam 5010 / coach-api 8105 / coach-web 10800), all healthy (200).**

**Verified working at slot 2:** stack up, seed (clean), tutor session minted, iam whoami reachable,
CORS + preflight + 401-login-challenge all correct (curl-confirmed against the coach-web origin).

**Residual blocker (coach-web-side — the core of soa#300, NOT ss develop plumbing):** coach-web's
*browser* boot renders `503 "Unable to reach the sign-in service"` — its client-side whoami fetch
(`session.ts:82` → `+layout.ts:36`) fails as a "real error" even though the host reaches iam fine
(curl 401-with-challenge + OPTIONS 204 both succeed, identical to saga-dash). So the failure is in
coach-web's client-side auth flow at slot > 0, not reproducible from the host — needs Playwright
trace analysis + coach-web internals (Seth). This is the unresolved core of soa#300 ("coach-web
local iam wiring stale, blocks local browser-testing"); M0 fixed only the manifest CORS/env half.

**Next step for a green live run:** resolve the coach-web browser-boot whoami failure (coach repo /
#300) — inspect the preserved Playwright trace under
`coach/apps/web/coach-web/test-results/dashboard-*/trace.zip`. The ss `develop coach` command itself
is confirmed correct end-to-end up to that coach-web-side boot.

## Chasing soa#300 (2026-07-14, coach-web now owned by us) — CORE fixed + remaining mapped

Opened the Playwright trace and root-caused #300 across its layers:

1. **CORE (FIXED, `719d342`): coach-web's browser booted against REMOTE hosts.** The trace showed it
   fetched `https://iam.wootdev.com/trpc/auth.whoami` (+ `dash`/`login.wootdev.com`) — the checked-in
   `.env` remote defaults — because coach-web reads `PUBLIC_*` via `$env/static/public` (inlines
   `.env` at vite-dev start) and there was no `.env.local`; the injected process env is ignored.
   **Fix:** a per-slot `.env.local` prelaunch write (`runtime/coach-web-env.ts`, mirrors the saga-dash
   `config.local.json` seam), gated on coach-web launchable, mapping each `PUBLIC_*` var to the local
   mesh OFFSET url. **Verified live: the browser now fetches `http://localhost:5010` (slot-2 iam).**
   This is the substantive #300 unblock — a real `ss develop coach` hand-off now reaches the local iam.

2. **REMAINING (smoke-only, ss-flow ↔ coach-web-e2e env contract):** the headless Playwright smoke
   still 503s because coach-web's e2e `globalSetup` mints the session against the BASE iam
   (`localhost:3010`) instead of the slot iam (`localhost:5010`). `e2e/fixtures/lane.ts`:
   `IAM_URL = process.env.PLAYWRIGHT_IAM_URL ?? 'http://localhost:3010'`. The flow HAS a
   `PLAYWRIGHT_SERVICE_URL_ENV` map (`e2e-orchestrate.ts:397`: `PLAYWRIGHT_IAM_URL→iam-api`,
   `PLAYWRIGHT_BASE_URL→saga-dash`) but (a) it isn't reaching coach-web's spawn (lane.ts fell back to
   `:3010`), and (b) `PLAYWRIGHT_BASE_URL` is hardwired to `saga-dash`, wrong for a coach-web flow.
   The `:3010` iam happens to be a **leftover tunnel process** with `AUTH_SESSIONCOOKIEDOMAIN=
   .sk.vms.wootdev.com`, so the minted cookie is scoped to a remote domain the localhost browser never
   sends back → `cookies:[]` → 503.
   - **Note:** the SLOT iam (`:5010`) has `AUTH_SESSIONCOOKIEDOMAIN` UNSET → issues a HOST-ONLY
     (localhost) cookie (iam's `sessionCookieDomain` is `z.string().optional()`), which IS correct.
     So no manifest cookie-domain fix is needed — the fix is purely to make globalSetup mint against
     the slot iam.
   - **Fix direction:** make the coach-web flow export `PLAYWRIGHT_IAM_URL` (slot iam offset) AND
     `PLAYWRIGHT_BASE_URL` (coach-web offset, not saga-dash) to coach-web's Playwright spawn — an
     ss-flow env-contract change. This affects the automated SMOKE; a real interactive hand-off uses
     ss `mintNativeLoginJar` (targets the slot iam directly), so it is likely already unblocked by #1.
   - **Environment note:** a leftover slot-0 tunnel iam (`:3010`, `.sk.vms.wootdev.com` cookie/CORS)
     is running — likely from other tunnel work; left untouched (slot 0 may be in use).

**Status:** #300 core FIXED + verified (coach-web boots against local mesh). The remaining smoke-only
env-contract fix (`PLAYWRIGHT_IAM_URL`/`PLAYWRIGHT_BASE_URL` for coach-web flows) is scoped and ready
to implement next. Slot 2 torn down; a stale coach-web watch orphan was killed.

# Research 02 — saga-dash e2e orchestration inventory

> Evidence-based inventory of `~/dev/saga-dash/apps/web/dash/e2e` + the Playwright config that governs it. This is the second body of scripting to migrate to OCLIF.

## Three orchestration scripts (not two)

The brief names two flows; there are actually **three** shell scripts:

1. **`check-e2e.sh`** (159 lines) — the user-facing "8 phases" concierge. Parses `-p/--phase <name|number>`, validates against a PHASES table, then delegates to `run-stack-e2e.sh --project <stage>`. **Foreground/headed by default** (`INSPECT=1` opens a logged-in browser post-run); `--headless` for CI.
2. **`connect-session.sh`** (56 lines) — the interactive Connect harness. Builds journey end-state (`check-e2e.sh --phase 5 --headless`) then runs the `interactive-connect` Playwright project headed. Drives a live tutoring session (1 tutor + 2 students, real mic/cam, all muted) and holds 3 browser windows open via `page.pause()`. **Foreground required** because of real AV + manual observation. Not in the gated pipeline (no Playwright `dependencies`; excluded via `@interactive` tag).
3. **`run-stack-e2e.sh`** — the **actual orchestrator** both above delegate to. Does: `up.sh --reset --seed roster` → `verify.sh` (tolerates one red = dash branch posture) → `playwright test --config=playwright.stack.config.ts [--project …] --grep-invert @interactive`. Handles `--sandbox` lane, `SKIP_RESET`, `INSPECT`, `PAUSE_AT_END`.

## The 8 phases (check-e2e.sh, source of truth)

| # | name | Playwright project | what it covers | key services |
|---|---|---|---|---|
| 1 | roster | stage-1-roster | CSV upload → view (Empty Org wizard) | sis-api, programs-api |
| 2 | program | stage-2-program-creation | program creation | programs-api |
| 3 | enrollment | stage-3-enrollment-periods | enrollment + tutor periods | programs-api |
| 4 | pods | stage-4-pods | pod builder | programs-api |
| 5 | schedule | stage-5-schedule | schedule (SAME_EVERY_WEEK + term dates) | scheduling-api, programs-api |
| 6 | sessions | stage-6-sessions | materialize + lifecycle | sessions-api, programs-api |
| 7 | attendance | stage-7-attendance | ADS/ADM roster + iam names | ads-adm-api, sessions-api, iam-api |
| 8 | attendance-personas | stage-8-attendance-personas | per-tutor SESSION/PERIOD personas | + iam-api persona reads |

Stages form a **progressive stateful chain** — each mutates the same Empty Org district. Playwright `dependencies` run 1..N in order; stage-N failure skips N+1. `STAGE_ONLY=1` strips inter-stage deps for iteration.

## Playwright config

- **`playwright.config.ts`** — default config, currently **parked** (`testIgnore: ['**/*']`, auth broken by #55/#72).
- **`playwright.stack.config.ts`** — the live stack-lane config (opt-in, used by run-stack-e2e.sh): `testDir: ./e2e`, `globalSetup: ./e2e/fixtures/global-setup.ts`, `workers: 1` serial (stages share Empty Org), timeout 120s stack / 420s sandbox. Projects: `sandbox-preview-headers`, `stage-1`…`stage-8` (each `depends` on prior), `interactive-connect` (no deps, `@interactive`).

## Directory structure (key parts)

```
e2e/
├── .auth/                  storageState (dev.json, empty.json, …)
├── check-e2e.sh, connect-session.sh, run-stack-e2e.sh
├── fixtures/  base-test.ts (useUser), global-setup.ts (mint cookies),
│              lane.ts (stack vs sandbox env), durability.ts, network.ts
├── data/      seed-users.ts, roster-reset.ts, fixtures/*.csv
├── journey/   stage 2-8 specs
├── roster/    stage 1 spec
├── interactive/ connect-session.e2e.test.ts
├── sandbox/   preview-header-propagation smoke
└── shell|dashboard|sessions|programs/  (parked smoke/regression)
```

## Seed-data coupling (tight)

- **Seed users** (`data/seed-users.ts`) — deterministic from rostering IAM seed; journey uses `empty@saga.org` (Empty Org admin). globalSetup mints sessions for `['dev','empty']`.
- **Empty Org roster** — hardcoded CSV fixtures (`example-roster.csv`: 2 tutors + 8 students, namespaced ids `E2E-LPHS`, `E2E-MATH101` to avoid demo-seed collision). `example-roster.updated.csv` adds S-108.
- **Hardcoded ids** — Empty Org district `52a00136-285b-522c-bc70-0887cf46463a` (env `PLAYWRIGHT_EMPTY_ORG_ID`), dev user `f0000004-…-beef`.
- **Date logic** — schedule uses term dates from `mondayOfCurrentWeek()` (+6 weeks); stages 6/7 target OCCURRENCE_DATE = Monday-of-week. Schedule is `FREQ=WEEKLY;BYDAY=MO..FR`.

### Known: Monday flake
Stages 5-7 use `mondayOfCurrentWeek()` **without weekday clamp** → on Sat/Sun runs the target Monday is in the past (no live occurrence) → empty sessions → flake. Only `connect-session.e2e.test.ts` clamps via `todayOrNextWeekday()` (Sun/Sat → next Mon). (Matches the prior memory note about Monday flake / OCCURRENCE_DATE.)

## Stack assumptions & partial-stack feasibility

- **All stages assume the FULL stack.** No per-test/per-flow service selection — monolithic all-or-nothing. The progressive chain means every API used in an earlier stage is needed downstream.
- BUT the per-stage service needs ARE knowable (table above) — e.g. stages 1-4 don't need sessions-api/ads-adm-api/scheduling-api. This is the hook for **N-of-M**: a flow that stops at stage 4 only needs iam+sis+programs(+mesh). The brief's "scheduling-api + session-api only" scenario is a *different, non-dash* flow.
- **Lane awareness** (`lane.ts`): stack (localhost ports) vs sandbox (wootdev.com + preview-pin headers + janus_session). All service URLs already parameterized via `PLAYWRIGHT_*_URL` env vars — clean injection points for a CLI.

## Auth flow
globalSetup → `mintSessionSetCookies(email)` per alias (stack: `auth.devLogin`; sandbox: `auth.login`) → writes `.auth/<alias>.json` storageState → browsers load it. Rate-limit aware (iam-api 100 req/min/IP; retries with backoff).

## Durability gate
`assertRosterViewDurable()` issues N independent reads (default 4, 3s apart; env-tunable) to catch ack'd-but-not-durable flips (program-hub gh-186). `waitForRosterView()` polls 5s (rate-limit aware), 90s timeout.

## Invocation summary
No e2e scripts in `package.json` (e2e is opt-in via the stack config + shell wrappers). Env-driven throughout: `PLAYWRIGHT_BASE_URL`, `PLAYWRIGHT_{IAM,SIS,PROGRAMS,SESSIONS,SCHEDULING,ADS_ADM,CONNECT}_URL`, `PLAYWRIGHT_EMPTY_ORG_ID`, `PLAYWRIGHT_LANE`, `PLAYWRIGHT_PREVIEW_PINS`, `STAGE_ONLY`, `SKIP_RESET`, `INSPECT`, `PAUSE_AT_END`, `CI`.

## Migration takeaways
1. The e2e orchestration is **already mostly env-var driven** — a CLI mainly needs to own (a) flow definition (which stages/projects), (b) lane selection, (c) reset/seed/verify sequencing, (d) Playwright invocation. The per-test logic stays in Playwright.
2. **Flows are the unit of abstraction.** Currently 2 hardcoded flows (8-phase journey, connect-session). The brief wants named flows with per-flow service subset + per-flow seed. The 8 phases + their service-needs table is the data to make declarative.
3. **e2e data lives in the SPA repo** (saga-dash) — fixtures, seed-user aliases, hardcoded ids. The brief's "externalize repo-specific e2e data, keep the e2e CL in soa" means: the CLI (in soa) drives orchestration; each SPA repo contributes its own specs + fixtures + flow manifest.
4. **Cross-repo dependency**: the e2e CLI must invoke synthetic-dev (up/reset/seed/verify) — so the stack CLI and e2e CLI share a contract (or the e2e CLI calls the stack CLI).

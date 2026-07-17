# Plan — `ss develop session-adm` (Connect session-based ADM demo as a develop target)

**Goal:** promote the 3-student staggered self-report Connect→ADM demo from a repo-local
shell script into the `ss develop` concierge family (today: `coach`, `connect`), so
"show me live SESSION attendance" is one durable command.

## What exists today (located 2026-07-17)

| Piece | Where |
|---|---|
| Demo spec (the showpiece) | `saga-dash/apps/web/dash/e2e/interactive/connect-session-demo.e2e.test.ts` — tutor (alex) + pod-A trio (ann, cara, gina) join a real Connect room staggered ~15s; each runs the real connectv3 `SessionHeartbeat`; ads-adm accrues TELEMETRY dosage; closing one student's window freezes only their counter |
| Flow registration | `saga-dash/apps/web/dash/e2e/flows.json` → `connect-session-demo` (@interactive, av; prereq: journey@attendance) |
| Concierge script | `saga-dash/apps/web/dash/e2e/telemetry-demo-multi.sh` — `ss stack down` → held flow w/ demo env → wait for dosage → admin browser |
| Runbook | `saga-dash/claude/projects/e2e-testing/telemetry-demo.md` ("3 students, staggered self-report" variant) |
| Single-student sibling | `connect-session-dosage.e2e.test.ts` + `telemetry-demo.sh` |
| CI-safe half | `e2e/telemetry/ping-dosage-harness.mjs` (direct HTTP pings, no AV) |

Demo env the script injects: `VITE_DASH_LIVE_SESSIONS`, `VITE_DEMO_LIVE_ATTENDANCE`,
`VITE_CONNECTV3_HEARTBEAT_INTERVAL_MS=3000`, `DEMO_HOLD=1`, plus (today)
`ADS_ADM_MOCK_SESSION_DATA_ENABLED=true` + `ADS_ADM_SESSION_DATA_PROVIDER=sessions-api`.

## M0 — land soa#346 first ✅ (merged 2026-07-17 18:02, `3051f6b`; primary soa checkout on main, CLI rebuilt)

soa#346 bakes both `ADS_ADM_*` gates into the launcher manifest with adoption guards.
Once merged, the demo's ads-adm env needs **zero** hand-injection and survives every
relaunch — the shell script's biggest fragility (and the cause of today's
"SESSION view regressed" hunt) disappears. The develop target should *assume* #346
and not re-inject those two vars.

## M1 — the command (`packages/node/saga-stack-cli/src/commands/develop/session-adm.ts`)

Mirror `develop/connect.ts` (BaseCommand → `resolveFlow('saga-dash/connect-session-demo')`
→ in-process orchestration; the resolver already recurses the journey@attendance
prerequisite with reset+seed).

Concierge sequence (folding `telemetry-demo-multi.sh` in):
1. `stack down` (unless `--reuse`) so saga-dash boots with the demo VITE env —
   the three `VITE_*` flags must be present at dash dev-server launch. Inject them
   through the launch context as a per-invocation env overlay on the `saga-dash`
   service (investigate the cleanest seam: `ScriptPlan` / flag-map / manifest env
   merge — task M1.1).
2. Bring-up window: journey@attendance prerequisite (checkpoint restore when baked) +
   up/verify of the demo closure, WITHOUT spawning the demo spec (stages-empty
   `executeResolvedFlow` — splitting here is what lets step 3 run before the held
   spawn owns the TTY).
3. Open the admin view **before** the held run (skip with `--no-admin`): reuse the
   vendored `browser-login.mjs` path (`stack login empty@saga.org --browser`
   equivalent) at `/dashboard/attendance?mode=session`. _Reconciled 2026-07-17 (was:
   poll ads-adm for dosage, then open the browser — see Decision 4 below)._
4. Run the held flow headed (`DEMO_HOLD=1` equivalent) — foreground, stdio inherited,
   same AV constraints as `develop connect` (slot-0 LiveKit, `DISPLAY`; media is always
   Chromium-synthetic — the connect-session-demo project hardcodes it). No CLI-side
   dosage polling: the spec itself polls ads-adm and prints `[DEMO] Dosage landed`.

Flags (family-consistent):
- `--reuse` — skip down/rebuild, run against current stack (documents the caveat:
  VITE demo flags require the dash server to have been launched with them; the
  known vite stale-serve trap means "touch vite.config.ts" is NOT enough for env)
- `--fake-media` — accepted for family muscle-memory but a DOCUMENTED NO-OP here: the
  connect-session-demo Playwright project hardcodes synthetic cam/mic in its
  launchOptions and never reads `FAKE_MEDIA` (unlike `develop connect`, where it is
  load-bearing)
- `--no-admin` — skip the admin browser (script's `--no-admin` parity)
- `--stagger-ms <n>` — passthrough to `DEMO_STAGGER_MS` (default 15000)
- `--no-hold` — CI/headless mode (no `page.pause`)
- `--refresh-snapshot` — rebake journey prerequisite checkpoints (mirrors connect)
- `-- <argv>` — passthrough to Playwright

## M2 — tests + guardrails

- Unit tests in `commands/develop/__tests__/` for flag→plan mapping (mirror connect's).
- No CI AV run: the @interactive tag already excludes it; the CI-safe telemetry story
  stays with the existing `telemetry-dosage` flow.
- Pod-drift guard: the spec hard-asserts pod-A membership (loud failure on roster
  drift) — keep; the command should surface that failure with a "re-run journey"
  remedy hint.

## M3 — docs + retirement

- `ss` skill reference (claude-plugins repo): add `develop session-adm` to the
  develop-target table + one worked recipe.
- saga-dash runbook (`telemetry-demo.md`): point the 3-student section at the new
  command; keep manual steps as the troubleshooting appendix.
- Fix the known doc inconsistency: runbook/banner say `erin.smith`, spec uses
  `gina.park` (erin is in Morgan's pod — spec is authoritative).
- Convert `telemetry-demo-multi.sh` into a 3-line deprecation shim that execs
  `ss develop session-adm` (same pattern as `e2e connect` → `develop connect`
  deprecating alias), one release of overlap, then delete.

## Decisions (skelly, 2026-07-17)

1. Name: **`ss develop session-adm`**.
2. **Multi-only v1** — no `--single`; the single-student sibling stays reachable via
   `ss e2e run saga-dash/connect-session-dosage`.
3. **Admin browser auto-opens** (`--no-admin` to opt out) — script parity.
4. **Admin browser opens BEFORE the held run; no CLI-side dosage gating** (reconciled
   2026-07-17, build session). The shell script grepped its flow log for
   `[DEMO] Dosage landed` before opening the dash; in-process the Runner has no output
   capture, and the spec's 20s DEMO_HOLD pre-join pause exists precisely so an
   already-open dash watches the counters climb from zero — better choreography, zero
   new machinery. Accepted tradeoff: a room that never accrues dosage briefly shows a
   zero dash (the script's sentinel gate prevented that); mitigations shipped — the
   failure surfaces loud in the Playwright terminal with the pod-drift remedy warn,
   and the command now CLOSES the admin browser on every failure path rather than
   leaving a dead zero dash + orphaned Chromium behind.

## Testing posture (skelly, 2026-07-17): slot 1

Development testing targets **slot 1** (`--slot 1` / a worktree set) for everything
non-AV: the journey@attendance prerequisite, stack lifecycle + adoption guards, the
VITE env-overlay seam, dosage polling, and the admin-browser plumbing. The **held AV
demo run itself validates on slot 0** — `ss` pins Connect/AV (LiveKit/coturn) to
slot 0 by design ("sets are backend+dash contexts at slot>0 — connect stays on
slot 0"). If lifting that constraint is wanted, it's a separate ss effort, not part
of this one. Slot 1 was the gh_275 effort's test slot; that effort shipped
2026-07-16 — reclaim includes clearing its leftover test data.

## Effort & sequencing

M0 ✅ merged. M1+M2 ≈ one focused session in the soa repo (`saga-stack-cli`),
M3 spans claude-plugins + saga-dash docs.

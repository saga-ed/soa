# M5 follow-up — AV stack in the manifest + hardware/CI guard (#214)

> Folds two gaps (surfaced while reproducing `connect-session.sh` as a flow) into
> the M5 scope. Both are needed for `av`/`foreground` flows (the live Connect
> tutoring session) to work through saga-stack-cli. Approved 2026-06-30.

## Why: connect-session is foreground for real reasons

`connect-session.sh` drives a LIVE Connect room (1 tutor + 2 students) with **real
OS mic/cam** (`grantPermissions`, no fake-device flags), **headed** browsers, and
ends in **`page.pause()`** holding the windows open for **manual observation** —
there is no automated pass/fail. It also needs the **LiveKit/coturn AV side-stack**
up (`connect-web :6210` + AV). It is `@interactive`-tagged with NO Playwright
`dependencies` so the pipeline never auto-runs it. So the flow is *headed +
real-hardware + human-blocking + not-CI-safe* by nature.

The M5 flow model already captures the orchestration (a `foreground:true`,
`av:true` FlowDef with a `prerequisite` of journey-through-schedule, `@interactive`
terminal, `requiredSystems` → closure). These two gaps remain:

## Gap 1 — model the AV side-stack (LiveKit + coturn) in the manifest  ✅ APPROVED

Today up.sh brings AV up via `connect_av_up` (best-effort `docker compose -f
$QBOARD/docker-compose.yml up -d livekit coturn`), separate from the mesh; the
service manifest doesn't know about it. So an `av:true` flow would launch
connect-web but not the AV stack it needs.

**Design (preferred, approved):** model `livekit` + `coturn` as **optional infra
units** — an `av` group alongside the mesh — so the closure/`status`/`verify` see
them and the launcher brings them up.

- Add to the manifest (e.g. `core/manifest/mesh.ts` or a new `av.ts`): units with
  `{ id, container, port (livekit 7880, coturn ...), compose: { repo: QBOARD, file:
  'docker-compose.yml', services: ['livekit','coturn'] }, optional: true,
  bestEffort: true }`. `bestEffort` mirrors up.sh's non-fatal AV bring-up (AV
  failure warns, doesn't abort — you can still observe video-less).
- **Closure:** the AV units are pulled in when a flow is `av: true` **or** when
  `connect-web` is in the closure (connect-web is the AV consumer). Keep them out
  of every other closure (they're optional/best-effort), so non-AV runs are unaffected.
- **Runtime:** a small `runtime/av.ts` (`avUp(ctx)`), a `connect_av_up` transcription
  — `docker compose -f <qboard>/docker-compose.yml up -d livekit coturn`, best-effort,
  logged; `StackApi.up` calls it after mesh when the closure includes AV. Injectable
  (fake in tests), like the other runtime seams.
- **status/verify:** AV units report but a down AV unit is a WARN, not a gate fail
  (best-effort) — consistent with up.sh.

## Gap 2 — hardware/CI precondition guard for `av`/`foreground` flows  ✅ APPROVED

`av:true`/`foreground:true` flows cannot run headless, in CI, or without a display +
mic/cam. Without a guard you get a confusing Playwright permission error mid-run.

**Design:** a precondition check in `e2e run`/`e2e connect` BEFORE any bring-up:
- If `flow.foreground || flow.av` AND (`--headless` requested, OR `CI` is set, OR no
  `DISPLAY`/`WAYLAND_DISPLAY`): **fail fast** with an actionable message, e.g.
  *"connect-session is a live, headed, real-mic/cam flow — it can't run --headless
  or in CI. Run it at your desk with a display + camera."* Exit non-zero, launch nothing.
- The `foreground` runner must **not** impose a timeout (so `page.pause()` can block
  indefinitely) and must `stdio: 'inherit'`. Confirm the M5 `connect`/`run` foreground
  path already does both; add a regression test.
- Communicate the no-assertion nature: for a `foreground` flow the command's exit
  code reflects *launch success*, not a test pass (there is no gate) — say so in output.

## Tests (offline, fakes)
- manifest: the `av` units exist with the right containers/ports; `optional`+`bestEffort`.
- closure: an `av:true` flow (or any connect-web closure) pulls the AV units in; a
  non-AV flow (journey through pods) does NOT.
- guard: `e2e run <av/foreground flow> --headless` (or with `CI=1`, or no DISPLAY)
  rejects fast, launches nothing; a headed run at a desk proceeds.
- foreground runner: no timeout, stdio inherit (fake runner asserts the spawn opts).

## Sequencing
Rides the M5 native `e2e` path; land with the saga-dash `connect-session` flow
authoring (cross-repo) so it's exercised end-to-end. The AV runtime port is small
and additive; the guard is a pure precondition + one runtime check.

## Cross-references
- `02-handoff-and-status.md`, `03-soak-plan.md`, `04-m7-multi-instance.md`
- `connect-session.sh` + `interactive/connect-session.e2e.test.ts` (saga-dash) — the
  behavior being reproduced; the Playwright spec stays there, unchanged.

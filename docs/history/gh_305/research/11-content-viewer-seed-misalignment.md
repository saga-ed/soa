# 11 — "Couldn't Load Module": content-viewer seed misalignment (#305 / coach #228)

**Date:** 2026-07-14. Live-verified against the slot-2 `coach_api` Postgres after
`ss develop coach --scenario content-viewer` seeded it (coach-db `db:seed` offline fixtures).

## Symptom
coach-web authenticates (tutor "Demo Tutor One" logged in) but the module player at
`/units/unit_1/sc_u1_m1` renders `heading "Couldn't Load Module"`. Loader
(`coach-web/src/routes/units/[unitName]/[moduleId]/+page.svelte`): `module = unit.modules.find(id
=== 'sc_u1_m1')`, `contentId = module.pollId`, then `fetchPollContent(contentId)` — any null → error.

## Root cause (live DB evidence, coach_api @ slot-2 :7432)
- **Exactly one content instance:** `user_id=1c939568…` (demo-tutor-1), `content_name=spring-pilot`,
  **59 modules**. No `curriculum-coach` persona/instance exists to fall back to.
- **Active release curriculum = `curriculum-coach`**, but its `doc` has **no top-level `nav`**
  (`(doc::jsonb->'nav') IS NULL`). Its **27 polls** carry short content-ids (`1rzefuyfyd9pia5u`, …);
  **zero** poll_id matches `sc_u1_*`.
- **`sc_u1_m1`** exists in the instance (`content_instance_module`, `state=COMPLETE`,
  `poll_instance_id=798ada76-…`) but that poll_instance **does not resolve to any active-release
  poll** (join count = 0).

So the synthetic offline seed lands the tutor on **spring-pilot** while the release is a **nav-less
`curriculum-coach`** whose polls don't cover `sc_u1_m1`. The ported viewer therefore can't load any
module for the seeded tutor. This is the coach #228 Dashboard(spring-pilot)/Explore(curriculum-coach)
mismatch, which coach explicitly DEFERRED.

## Why this isn't a quick config fix
- The real content viewer is designed to run off **published archive content**
  (`coach-web/e2e/module-playback-real-content.e2e.test.ts`, `PUBLISH_REAL_CONTENT=1` + `ARCHIVE_DIR`
  → `coach-content publish`), NOT the synthetic `db:seed` fixture. The synthetic `module-playback`
  smoke uses the misaligned fixtures above.
- The offline fixtures (`coach-db/src/seed/fixtures/content-instances.json` = spring-pilot 59-mod;
  `content-release.json` = curriculum-coach, nav-less) are internally inconsistent for playback.

## Fix options (coach-repo; needs a content-model decision)
1. **Publish real archive content** for the develop-coach content-viewer scenario: check out
   `saga-ed/content-archive`, `coach-content publish` a real curriculum, materialize demo-tutor-1 on
   it. Highest fidelity; needs an archive checkout + an `ss develop coach --real-content` flag/step.
   Ties back to the original content-source decision (synthetic vs real archive).
2. **Fix the synthetic seed** so the offline fixture is self-consistent: materialize demo-tutor-1
   from the *active release's* curriculum (so every module's poll is in the release, with a
   nav-carrying doc). A coach-db fixture reconstruction — this is the #228 reconciliation, deferred
   for reasons that need confirming (why the tutor is on spring-pilot while the release is
   curriculum-coach).
3. **Point the content-viewer scenario at whatever coach's own `module-playback` smoke uses in CI** —
   if that suite is green on coach main, replicate its seed exactly (the ss flow may be seeding a
   different/partial path than coach CI). NEEDS: confirm whether coach's `module-playback.e2e.smoke`
   is green on main; if it's red/skipped there too, the synthetic path is a known gap.

## RESOLVED via option 1 — `ss develop coach --real-content` (2026-07-14)

Implemented + live-verified on slot 2. `--real-content` drives coach-web's AUTHORED
`module-playback-real-content` flow (publish archive `base-coach` → materialize demo-tutor-1 →
render the same `/units/unit_1/sc_u1_m1` route). Two ss-side pieces were needed:
1. Resolve + precheck the content-archive checkout (`--archive-dir` / `$ARCHIVE_DIR` /
   `<dev>/content-archive`) and export **`ARCHIVE_DIR`** — the flow's flows.json `env` block supplies
   `PUBLISH_REAL_CONTENT=1`; the Runner spawns Playwright with `{...process.env}`, exactly the
   contract the flow documents.
2. Export **`DATABASE_URL`** = the slot's `COACH_DB_URL`. `real-content-lane.ts` gates on ARCHIVE_DIR
   **and** DATABASE_URL and SELF-SKIPS otherwise — the flow's doc claims saga-stack-cli supplies it,
   but nothing did, so the spec silently skipped. This is why the first live run looked "green-ish"
   while doing nothing.

**LIVE RESULT — the content issue is FIXED.** With a FULL archive clone (the flow pins
`DEFAULT_ARCHIVE_REF=215a7152…`; a `--depth 1` clone fails `rev-parse`), the run now:
publish ✓ → materialize ✓ → **module RENDERS** (`.not-found` count 0 — "Couldn't Load Module" is
GONE; `.mc-task`, short_answer et al. all pass). The ported content viewer plays REAL archive
curriculum.

## NEW finding (distinct, coach-repo): showdown tasks don't survive publish→render

The real-content spec's last assertion still fails: `.showdown-content` expected **2**, received
**0**. This is NOT a stale test — sc_u1_m1's poll in the archive at the pinned ref genuinely carries
**2 `showdown_task_`** entries (`exports/75958/polls/607075e88264ee04ae000003/poll.json`; base-coach
maps `sc_u1_m1 → content_id brvhsb6uxsutr4pn`). So real showdown content exists but renders zero
elements — a **publish-fidelity or renderer gap** (cf. coach #202 "carry poll questions/tag_list
through publish to Postgres"). Next step for whoever picks it up: check whether `coach-content
publish` carries `showdown_task` payloads into `content_release_poll`, and whether coach-web's
`TaskRenderer` dispatches the `showdown_task` base type.

## Status
Original root cause (synthetic seed misalignment) identified, and RESOLVED for develop-coach via
`--real-content` (real archive curriculum now plays). Remaining: the showdown publish/render gap
above (coach-repo), plus the unauthenticated shell/nav e2e specs (coach-web e2e test wiring).

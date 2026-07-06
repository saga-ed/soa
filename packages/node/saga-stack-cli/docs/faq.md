# FAQ — How do I …?

Real questions from real sessions, answered with the actual commands and output.
(Companion to [`e2e-flows.md`](./e2e-flows.md), the first-time-user runbook.)

## How do I see what flows exist and whether their checkpoints are fresh?

`ss e2e list` — every SPA, flow, and stage, with checkpoint freshness annotations.

<details><summary>Example output</summary>

```
saga-dash  [saga-dash]  /home/skelly/dev/saga-dash/apps/web/dash/e2e/flows.json
  • journey  (stack/sandbox; progressive, foreground)
      1. roster  (stage-1-roster)  [checkpoint: re-bake]
      2. program  (stage-2-program-creation)  [checkpoint: re-bake]
      3. enrollment  (stage-3-enrollment-periods)
      ...
  • ads-adm-attendance  (stack; single)
      prerequisite: journey through 'schedule'
      — persistence  (ads-adm-persistence)
  • scheduling-topology  (stack; single)
      1. topology  (scheduling-topology)
```

`[checkpoint]` = valid and restorable via `--from`; `[checkpoint: re-bake]` = exists
but stale; no tag = never baked.

</details>

## How do I run the journey flow?

```bash
ss e2e run saga-dash/journey --headless                    # full 8 stages
ss e2e run saga-dash/journey --through pods --headless     # stages 1..4 only
ss e2e run saga-dash/journey --snapshot-stages --headless  # full run + bake checkpoints
```

<details><summary>Example output (per-stage)</summary>

```
==> playwright: journey — pnpm exec playwright test --config=playwright.stack.config.ts --project stage-1-roster --grep-invert @interactive
  7 passed (21.0s)
==> checkpoint: baked flow-saga-dash-journey-s1-roster
==> playwright: journey — ... --project stage-2-program-creation --no-deps ...
  3 passed (1.4s)
==> checkpoint: baked flow-saga-dash-journey-s2-program
```

</details>

## Why are stages flagged `[checkpoint: re-bake]`?

A checkpoint is a DB snapshot of "what stages 1..K produced", stamped with a
hash of those stages' definitions. If the flow definition changes (or the
checkpoint ages past 7 days), restoring it could hand a differently-specified
stage a mismatched world — so the CLI demands a re-bake instead of restoring
silently. Fix: re-run with `--snapshot-stages`.

<details><summary>Real example</summary>

When `flows.json` moved from ad-hoc validation files into the saga-dash repo
(2026-07-05), stage 1-2 checkpoints had been baked against the older definition
(roster's `requiredSystems` differed). Three different prefix hashes existed for
"journey stages 1..1" — the baked one, the old tmp file's, and the repo's — so
the listing correctly flagged `re-bake`. One `--snapshot-stages` run refreshed
all 8.

</details>

## How do I iterate on ONE stage quickly instead of replaying the whole flow?

Bake once, then restore-and-run just your stage:

```bash
ss e2e run saga-dash/journey --snapshot-stages --headless             # once (~1 min)
ss e2e run saga-dash/journey --from schedule --through schedule --headless   # each iteration (~5-10s)
```

<details><summary>What the restore looks like</summary>

```
==> restore: flow-saga-dash-journey-s5-schedule (baked 2026-07-06T00:57:13.383Z, occurrence 2026-07-06)
==> prerequisite: journey@schedule restored from checkpoint (replay skipped)
==> playwright: ... --project stage-5-schedule ...
```

Live measurement: full replay 44.9s → `--from` 5.8s.

</details>

## How do I pause a flow for manual testing — is there a "leave the browser open" flag?

`--hold` mints a logged-in dev session and opens a browser when the run stops;
`--to <stage>` stops BEFORE a stage (its entry state is built, the stage hasn't
run). The instant version, once checkpoints are baked:

```bash
ss e2e run saga-dash/journey --from schedule --to schedule --hold   # ~6s to a live browser
ss e2e run saga-dash/journey --through pods --hold                  # pause AFTER pods
ss e2e run saga-dash/journey --from schedule --through schedule -- --debug   # Playwright inspector
```

<details><summary>The held-state banner</summary>

```
✓ held for manual testing — saga-dash/journey at entry of 'program'
  slot 1 · services up (2): iam-api, saga-dash
  logged-in as dev@saga.org · cookie jar → /tmp/sds-synthetic-s1/cookies.txt
  opening a logged-in browser at http://localhost:9900 (best-effort; a headless host warns)…
  teardown when done: ss stack down --slot 1
```

There's no single-command "pause at EVERY stage" — loop `--from $s --to $s --hold`
per stage instead (seconds each). `foreground` in flows.json is different: it's a
per-flow authoring choice (connect's AV hold via `page.pause()`).

</details>

## How do I pull the latest main into slot 0 and the worktree slots?

```bash
ss stack up --pull              # slot 0: ff-only sync of clean, on-branch siblings
ss stack up --set topo --pull   # slot 1: same, against the set's worktrees
```

**But note:** `--pull` syncs each checkout's OWN branch from its own upstream. It
deliberately does NOT merge `origin/main` into a feature worktree — that's a
history-changing decision `up` won't make for you. See the next question.

## My worktree still shows "behind origin/main" after `--pull` — why, and how do I merge up?

Because `--pull` ≠ merge-up (above). `ss set show <name>` tells you the mainline
currency and prints the exact command when action is needed:

```bash
git -C ~/dev/worktrees/saga-dash-topo merge origin/main
```

<details><summary>Example output</summary>

```
ads — slot 2  (ADS/ADM period-based persistence flow initiative (slot 2))
  ✓ saga-dash    @ flow/ads-adm-persistence  (clean)  [⚠ behind origin/main by 22]
      /home/skelly/dev/worktrees/saga-dash-ads   created from flow/ads-adm-persistence
      merge up: git -C /home/skelly/dev/worktrees/saga-dash-ads merge origin/main
```

Currency is as-of your last fetch; `ss set show ads --fetch` refreshes first.
After merging up, `pnpm install` in the worktree — the prep pass's fresh-skip
can't detect stale installs (yet).

</details>

## How do I see the source posture of a slot / worktree?

Two commands for two worlds:

```bash
ss stack verify --full     # slot 0: P1-P4 posture of the DEFAULT checkouts vs origin/main (warn-only)
ss set show topo           # a worktree set: branch, clean/dirty, provenance, mainline currency
ss set check topo          # verdicts: prebuilt vs BUILDABLE, drift, collisions, ACTIVE-slot safety
```

`verify --full` is slot-0-only by design: it asserts "defaults on clean main",
which is meaningless for set worktrees (they're SUPPOSED to be on feature
branches) — `set show`/`set check` ask the right questions for those.

## Why does my PR show `skipping` entries in CI — is something failing?

No. "Version and Publish Packages" and "Create Release Summary" only run on the
release path (merges to main); on PR events they report `skipping`, which some
views render with a neutral icon that reads like a failure at a glance. Check
`gh pr checks <n>` — if nothing says `fail`, you're green.

## A service fails bring-up with `ERR_MODULE_NOT_FOUND` — what happened?

Its sibling repo was pulled but not rebuilt: the prep pass's fresh-skip treats
`node_modules` + `dist` PRESENCE as fresh, so it won't rebuild after a pull
changed dependencies. Fix: `pnpm install && pnpm build` in that repo.

<details><summary>Real example</summary>

```
Error: native bring-up failed at ads-adm-api
# /tmp/sds-synthetic/ads-adm-api.log:
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@saga-ed/soa-postgres'
  imported from .../ads-adm-api/dist/chunk-2XELNIO7.js
```

student-data-system had been fast-forwarded that morning; its `dist` predated
the dependency change. A lockfile-hash-aware freshness check is on the backlog.

</details>

## Why is journey stage 8 (attendance-personas) skipped?

Deliberately, pending saga-dash#280: the SESSION measured-time overlay has no
data source in a seeded journey (no real tutoring → no dosage telemetry), so
its UI assertions can't pass yet. The persona/policy half is being revived as a
partial unskip (live tests green, a tightly-scoped `test.skip` citing #280
around only the measured-time assertions).

## Where does everything live?

- CLI: `~/dev/soa/packages/node/saga-stack-cli` (`ss` on PATH)
- Flows: `~/dev/saga-dash/apps/web/dash/e2e/flows.json` (repo-authored, per-SPA)
- Checkpoints/snapshots: `~/.saga-mesh/snapshots` (`snapshots-s<N>` per slot)
- Worktree sets: `~/.saga-stack/worktree-sets.json` (`$SAGA_STACK_SETS` overrides)
- Docs: `docs/e2e.md`, `docs/e2e-flows.md` (runbook), `docs/slots.md`,
  `docs/worktree-sets.md`, `docs/snapshots.md`

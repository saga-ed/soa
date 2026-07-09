# E2E exploratory review — capture, preserved traces, `e2e traces`

Proposal + shipped-v1 doc in one (house style). Companion to
[e2e-flows.md](e2e-flows.md), which covers running flows; this covers
**reviewing what a run actually did**.

## Motivation

> "I want to confirm the flow tests what it claims — run it headed, or walk
> me through it step by step with something I can look at." — the review ask
> that motivated this (Nathan, saga-dash#426 review, 2026-07-09).

Two beliefs, from the exploratory-testing practice the flows grew out of:

1. **Flows set worlds up; traces explain them.** An e2e flow's job is to
   build a real world and pin contracts. A REVIEWER's job is different: they
   need to see the world being built — which button was clicked, what the
   page showed, which API call fired. Playwright traces already carry exactly
   that (per-action film strip, DOM snapshots, network log); the tooling gap
   was that nothing turned "review this flow" into "here are the traces".
2. **The artifacts must survive the next run.** Playwright wipes
   `test-results/` at run start. The observed footgun: a reviewer runs the
   flow themselves and thereby deletes the very traces they meant to open.
   Preservation must be automatic, not an instruction in a doc.

Capture has costs (slower runs, disk), so it is profiled:

- **light (default)** — trace only on a retried failure (Playwright's
  `on-first-retry`), no preservation on green. Byte-identical to before.
- **heavy on demand (`--capture`)** — `PLAYWRIGHT_CAPTURE=all`: per-action
  trace + video for EVERY test, preserved after every spawn. The review mode.
- **milestones (deferred)** — named `test.step()` blocks make the film strip
  read as narrative ("create period from Schedule step → enroll people →
  assert converged world") without heavyweight capture. The SPA side adopts
  `test.step` freely today (saga-dash's periods-ordering flow is the first);
  a CLI-side "steps only" profile waits until step density across flows makes
  it worth a knob.

Failure messages follow the observation-first rule (state what was OBSERVED,
then the hypotheses) — a guard that asserts one confident cause misdiagnoses.
That convention lives in the SPA repos' support kits; the CLI's own review
output sticks to facts (paths, counts, exit codes).

## What shipped (v1)

### `ss e2e run <flow> --capture`

Injects `PLAYWRIGHT_CAPTURE=all` into the Playwright child — the knob the
SPA's stack config already honours (saga-dash `playwright.stack.config.ts`:
trace `on` + video `on` for every test). The prerequisite build never
inherits it (a prerequisite is a build step, not the thing under review);
a RED prerequisite spawn is still preserved (below).

### Artifact preservation

After EVERY Playwright spawn that warrants it — every spawn of a `--capture`
run, and any FAILED spawn regardless — the run copies artifact files
(`trace.zip`, videos, failure screenshots, `error-context.md`) out of the
SPA's `test-results/` into:

```
<stateDir>/e2e-runs/<runId>/<spaId>/<flowName>/<stageId>/<original-dir-name>/
```

- `runId` is the run's single wall-clock read, filesystem-safe and lexically
  chronological (`2026-07-09_14-05-03`).
- `stageId` is attributed from the Playwright result-dir name's `-<project>`
  suffix (longest project first; `-retryN` stripped); projects that are not
  flow stages (dependency gates like `stage-0-coherence`) land in `_other`.
- Preservation runs per SPAWN because the per-stage ladder (`--snapshot-stages`
  / `--from`) and a prerequisite's replay each wipe the previous spawn's
  `test-results/`.
- `<stateDir>` is slot-aware (`/tmp/sds-synthetic` at slot 0), so slotted runs
  preserve into their own tree. It is scratch space — durable across runs,
  not across host cleanup; copy a run elsewhere to archive it.

### The end-of-run review block

A run that preserved anything prints, win or lose (including a red
prerequisite):

```
── review this run ─ saga-dash/periods-ordering
   preserved: /tmp/sds-synthetic/e2e-runs/2026-07-09_14-05-03/saga-dash/periods-ordering
   stage ordering — 7 trace(s):
     cd ~/dev/saga-dash/apps/web/dash && pnpm exec playwright show-trace /tmp/…/ordering/…/trace.zip
     …
   list preserved runs any time: ss e2e traces
```

Every line is paste-ready; the `cd` prefix matters because `show-trace` must
run where Playwright is installed (the SPA's app dir).

### The whole-run HTML report

A `--capture` run also emits Playwright's HTML reporter locally (the SPA
stack config adds `html` + `json` under `PLAYWRIGHT_CAPTURE=all`, `open:
'never'`), giving ONE browsable page for the entire run — every scenario,
its named `test.step` phases, and embedded trace links. The report dir is
preserved beside the stage dirs:

```
<runsRoot>/<runId>/<spa>/<flow>/playwright-report[-N]/
```

One report per SPAWN (the default path = one report for the whole run; the
per-stage ladder yields one per stage spawn, numerically suffixed). The
review block leads with its paste-ready line:

```
cd <spa app dir> && pnpm exec playwright show-report <preserved dir>
```

The machine-readable `results.json` sibling lands in the SPA app dir (not
preserved yet — read it right after a run for pass/fail counts).

### `ss e2e traces [--flow <spa>/<flow>] [--open]`

Lists preserved runs newest-first — whole-run reports first, then per-stage
show-trace commands. `--open` PREFERS the newest preserved HTML report
(`show-report`) and falls back to the newest trace (`show-trace`);
best-effort either way (a headless host warns, never errors). Slot-aware
like the run command.

## Deferred (explicitly)

- **Milestone capture profile** — a middle profile between light and heavy
  keyed on `test.step()` density; waits until more flows adopt steps.
- **Preserving `results.json`** — the json summary stays in the SPA app dir
  for now; preserve it alongside the report if a consumer appears.
- **Retention/pruning** — `e2e-runs/` grows by ~10-40 MB per captured run;
  manual cleanup for now (`rm -rf <stateDir>/e2e-runs/<runId>`), a `--prune`
  knob when it hurts.
- **Video reliability** — `PLAYWRIGHT_CAPTURE=all` requests video, but green
  runs have been observed producing traces only; the trace film strip covers
  the same ground, so v1 does not chase it.

## Pointers

- Run mechanics + flow anatomy: [e2e-flows.md](e2e-flows.md)
- SPA-side conventions (test.step naming, observation-first guard messages,
  locator ladder): the SPA repo's `.claude/rules/testing.md` +
  `e2e/support/README.md` (saga-dash).

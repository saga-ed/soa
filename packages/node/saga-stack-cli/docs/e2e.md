# E2e — flows as data

← [Getting started](./getting-started.md)

E2e scenarios are **data** (`flows.json`), not hardcoded bash. `ss e2e run <spa>/<flow>`
discovers the flow, computes just the stack it needs, seeds it, and runs Playwright.

## Discover flows

```bash
ss e2e list
```

<details><summary>Discoverable SPAs, their flows, stages, and prerequisites</summary>

```
saga-dash  [saga-dash]  …/flows.json
  • journey  (stack/sandbox; progressive, foreground)
      1. roster        (stage-1-roster)
      2. program       (stage-2-program-creation)
      3. enrollment    (stage-3-enrollment-periods)
      4. pods          (stage-4-pods)
      5. schedule      (stage-5-schedule)
      6. sessions      (stage-6-sessions)
      7. attendance    (stage-7-attendance)
      8. attendance-personas  (stage-8-attendance-personas)
  • connect-session  (stack; single, foreground, av)
      prerequisite: journey through 'schedule'
```

A flow is a `flows.json` entry: progressive multi-stage journeys, per-stage
`requiredSystems`, prerequisites, and foreground/AV markers. Onboarding a new scenario is a
registry row + a `flows.json` entry — **zero new orchestration code**.
</details>

## Run a flow

```bash
ss e2e run saga-dash/journey --through sessions --headless
```

<details><summary>✓ 20/20 — brings up the 6-service closure, resets + seeds, runs Playwright through stage 6</summary>

```
==> up: 6 service(s) [iam-api, sis-api, programs-api, scheduling-api, sessions-api, saga-dash]
==> reset (native) + native seed
==> playwright: journey — stage-6-sessions
  ✓  18 [stage-6-sessions] › Sessions appear for a scheduled day (411ms)
  ✓  19 [stage-6-sessions] › A session can be started and ended (admin, via grant) (412ms)
  ✓  20 [stage-6-sessions] › The sessions page loads live session data for the program (578ms)
  20 passed (33.7s)
```

- `--through <stage>` runs a **prefix** of a progressive flow (name, number, or stage id).
- `--headless` for a CI-style run; omit for a headed browser.
- `--slot N` runs an isolated e2e on its own stack (see [slots](./slots.md)).
- A clamped occurrence-date is injected so weekend runs don't flake.
</details>

## Stage checkpoints — skip the replay (M14)

Working on stage 6 shouldn't cost a UI replay of stages 1–5 every iteration.
**Bake** a DB checkpoint after each green stage, then **start mid-flow**:

```bash
ss e2e run saga-dash/journey --snapshot-stages --headless   # bake: ckpt after each stage
ss e2e run saga-dash/journey --from sessions                # restore ckpt(schedule), run 6..N
ss e2e run saga-dash/journey --from 6 --through 7           # windows compose with --through
```

Measured live: `--from` turned a 45s bake-path run into **5.8s** (restore + one stage).

- Checkpoints are ordinary snapshots named `flow-<spa>-<flow>-s<N>-<stage>` in the
  slot's snapshot root (so `--set`/`--slot` contexts keep separate checkpoints);
  re-bakes overwrite. `ss stack snapshot list` shows their flow provenance;
  `ss e2e list` marks baked stages with `[checkpoint]` (or `[checkpoint: re-bake]`).
- A `--from` restore is **validated hard**: the producing stage definitions must be
  unchanged (prefixHash), the checkpoint must cover the window's databases, sit AT
  the local migration head (both directions), match the seed profile, and be ≤ 7 days
  old by both bake time and its embedded occurrence date (`--from-stale-ok` overrides
  the age cliff). The run **reuses the checkpoint's baked dates** so restored data and
  specs agree; SPA-checkout drift since the bake is a warning.
- **Prerequisites restore too**: a flow with `prerequisite` (connect-session ⇐
  journey@schedule) restores the prerequisite's terminal checkpoint instead of the
  full headless replay whenever a valid one is baked — falling back to the replay
  otherwise. `--no-prereq-from-snapshot` forces the replay. (One delta vs the replay:
  the restore flushes redis; caches rebuild from the restored DBs.)

## Manual testing at a stage boundary — `--to` + `--hold`

Sometimes you don't want to *run* a stage — you want the stack left **right before**
it, with a live logged-in browser, so you can drive that step by hand.

- `--to <stage>` runs the flow **up to but NOT including** `<stage>` (an exclusive
  window end — the mirror of `--through`, which is inclusive). It leaves the stack at
  `<stage>`'s entry state. Same grammar as `--through`/`--from` (name, number, or
  Playwright project); progressive flows only; mutually exclusive with `--through`.
  `--to <first stage>` resets+seeds the baseline and runs zero Playwright.
- `--hold` — after the window goes green, mint the dev-persona cookie jar (the same
  native login `ss stack login` writes) and best-effort open a **logged-in** browser
  at the SPA's slot-offset URL, print a held-state summary, and exit 0. Nothing holds
  the TTY: the stack stays up after every run, and the browser is detached. On a
  headless host the jar is still minted and the browser open degrades to a warning.

```bash
# run roster+program+enrollment, stop before pods, hand off a logged-in browser
ss e2e run saga-dash/journey --to pods --hold --headless
```

The two flags are orthogonal — `--hold` works after any run (`--to`, `--through`, or a
full run). Composed with checkpoints, the payoff is a state-restore in seconds:

```bash
# bake once, then: restore the pods-state checkpoint, run nothing, open a logged-in
# browser at the schedule stage's doorstep in seconds.
ss e2e run saga-dash/journey --from schedule --to schedule --hold --set topo
```

`--from K --to K` is a valid **empty window**: it restores K's predecessor checkpoint
and runs nothing (pair it with `--hold`, or it does nothing observable). Teardown when
done with `ss stack down [--set <name> | --slot N]`.

## Live interactive Connect session — moved to `develop`

Setting up a stack to *use* by hand (vs. running a test flow) now lives under the
[`develop`](./develop.md) topic. `ss e2e connect` moved to **`ss develop connect`**; the old
id still works for one cycle with a deprecation warning. → [develop.md](./develop.md)

## Share the session — `--tunnel`

`ss e2e run` and `ss develop connect` take `--tunnel`, which points the Playwright browser at the
`https://<svc>.<moniker>.vms.wootdev.com` tunnel hosts so a **remote** person can reach your
slot-0 stack (e.g. invite a coworker to a Connect room). `run --tunnel` WAN-hairpins and is slow —
for seeding launchable sessions prefer the localhost-build → snapshot → restore-under-tunnel bridge.
Both are slot-0-only. → [tunnel.md](./tunnel.md)

## Point at a specific flows.json

`--spa-path <file-or-dir>` overrides discovery (handy for a bundled example or a WIP flow):

```bash
ss e2e run saga-dash/journey --through schedule --spa-path ./my-flows.json
```

← [snapshots](./snapshots.md) · [integration →](./integration.md)

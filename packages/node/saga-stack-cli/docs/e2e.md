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

## Live interactive Connect session

```bash
ss e2e connect
```

<details><summary>Opens a live 1-tutor + 2-student Connect session against the running stack</summary>

Brings up the Connect closure (iam / sessions / content / connect-api / connect-web / rtsm)
and opens a real interactive session — for hands-on Connect development, not an assertion run.
</details>

## Point at a specific flows.json

`--spa-path <file-or-dir>` overrides discovery (handy for a bundled example or a WIP flow):

```bash
ss e2e run saga-dash/journey --through schedule --spa-path ./my-flows.json
```

← [snapshots](./snapshots.md) · [integration →](./integration.md)

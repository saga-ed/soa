# `flows.json` authoring template

`saga-dash.flows.json` in this directory is the **canonical example + authoring
template** for the per-SPA `flows.json` contract (plan §5, saga-ed/soa#214). It
is validated against the zod `flowManifestSchema` in `../types.ts` and is used by
the CLI's unit/integration tests as the fixture for flow resolution, closure
union, prerequisite recursion, and the centralized weekday clamp.

## What it is / is not

- It is a **bundled example** that lives inside `@saga-ed/saga-stack-cli`. It is
  NOT the live contract — the real authoring is a **follow-up PR in the saga-dash
  repo** that copies this template to `apps/web/dash/e2e/flows.json` and keeps it
  in sync with `playwright.stack.config.ts`. Nothing in this PR writes into
  saga-dash.
- It encodes the **two existing saga-dash flows** (plan §5.2): the progressive
  8-stage `journey` (roster → program → enrollment → pods → schedule → sessions →
  attendance → attendance-personas) and the non-progressive, AV `connect-session`
  (one `@interactive` stage, prerequisite `journey` through `schedule`).

## How SPA repos adopt it

1. Copy `saga-dash.flows.json` to `<repo>/<e2eDir>/flows.json`.
2. Edit the `spa` descriptor (`id`, `system`, `repoEnvVar`, `defaultRepoSubpath`,
   `appDir`, `e2eDir`, `playwrightConfig`) for the new SPA.
3. Author one `FlowDef` per Playwright flow; each `StageDef.project` must match a
   project name in the SPA's Playwright config, and `requiredSystems` lists the
   manifest services that stage needs up (the CLI unions these into the closure).
4. Register the SPA in the CLI's `spa-registry.json` (one row). No CLI code and
   no orchestration code is added to the SPA repo (plan §5.3).

## Field reference (see `../types.ts` for the schema of record)

- `schemaVersion`: literal `1`.
- `spa`: `{ id, system, repoEnvVar, defaultRepoSubpath, appDir, e2eDir, playwrightConfig }`.
- `flows[]`: `{ name, description, lanes[], progressive, stages[], prerequisite?, foreground?, av?, seed?, env? }`.
- `stages[]`: `{ id, phase?, project, spec, requiredSystems[], seed?, tags? }`.

### Notes the example deliberately demonstrates

- **`requiredSystems` is the closure seed, not the whole closure.** The effective
  closure = union of the selected stages' `requiredSystems` ∪ `{spa.system,
  iam-api, mesh}`, fed to `computeClosure`. So `connect-session` lists
  `connect-web, connect-api, rtsm-api, sessions-api`; the closure additionally
  pulls `content-api` transitively (connect-api → content-api, §2.3) without it
  being authored here. Likewise `content-api` is in NO journey stage, so the
  journey never launches it (a real N-of-M saving).
- **Seeding is authored at the flow level**, not per stage: `journey` carries
  `{reset:true, profile:'roster'}`. `connect-session` has no `seed` of its own —
  it inherits the journey end-state via its `prerequisite` (built through
  `schedule`, then run with reset skipped), mirroring `connect-session.sh`.
- **No date/env clamp is authored here.** The Monday-flake fix is CLI-authoritative
  (plan §5.5): `computeEnv()` injects `PLAYWRIGHT_OCCURRENCE_DATE` /
  `PLAYWRIGHT_TERM_START` at runtime for every flow. `FlowDef.env` is reserved for
  genuinely static per-flow env and is intentionally unused in this example.
- **`@interactive`** on the connect stage's `tags` is what keeps it out of pipeline
  runs (`--grep-invert @interactive`); `progressive:false` + `prerequisite` is what
  makes `--through` inapplicable to it.

# `flows.json` authoring templates

These are **example** `flows.json` documents bundled with `@saga-ed/saga-stack-cli`
(plan §5, saga-ed/soa#214). They are the **single source of truth for the shape**
a SPA repo authors, and they double as fixtures for the CLI's flow-resolver tests.

> ⚠️ The **real** `flows.json` lives in each SPA repo (e.g.
> `saga-dash/apps/web/dash/e2e/flows.json`), authored as a follow-up PR. These
> copies are illustrative — do not point the CLI at them in production.

## Files

- **`saga-dash.flows.json`** — the two existing saga-dash flows:
  - `journey` — progressive, foreground, 8 stages (`roster` → … → `attendance-personas`).
    Playwright stages are projects chained via `dependencies`, so `--through pods`
    runs stages 1–4. Closure for "through pods" is `iam, sis, programs, saga-dash, mesh`
    — `content-api` is in no journey stage, so it is never launched (a real N-of-M saving).
  - `connect-session` — non-progressive, foreground, `av:true`. Declares a
    `prerequisite` (`journey` through `schedule`) that the resolver recurses: the
    prerequisite builds the end-state headless + owns the reset, and the
    `connect-session` run itself skips the reset.

- **`connectv3.flows.json`** — the M6 **second-SPA externalization proof** (plan §5.3).
  Demonstrates that onboarding a brand-new SPA is **a registry row + a `flows.json`,
  with zero new CLI logic**. The `spa` block is `connect-web` (the connectv3 frontend
  service) in the **qboard** repo (`apps/web/connectv3`). One template flow:
  - `connect-smoke` — non-progressive, headless, self-seeding (`roster`, reset). Its
    single stage requires `connect-web, connect-api, rtsm-api, sessions-api`. Resolved
    through the **same** `resolveFlow` → `computeClosure` engine as the saga-dash flows,
    the closure is `connect-web, connect-api, rtsm-api, sessions-api, content-api, iam-api,
    programs-api, scheduling-api` + mesh `connect-mongo` (and the `connectv3` + `content`
    DBs). It **excludes** the saga-dash-only backends `sis-api` + `ads-adm-api` and the
    `saga-dash` frontend itself — the N-of-M payoff for a Connect run. (`programs-api` +
    `scheduling-api` ride along because `sessions-api` projects from them on `event`
    edges; only `browser` edges are suppressed for flow closures.)
  > The flow/stage/project/spec names are **plausible placeholders** — there is no real
  > connectv3 e2e suite yet. The **real** `connectv3.flows.json` lands in the qboard repo
  > at `apps/web/connectv3/e2e/flows.json` as a follow-up.

## Validation

Every `flows.json` is validated at load against the zod `flowManifestSchema`
(`src/core/flow/types.ts`), exported as the package's flow schema. A file that
exists but fails the schema is a hard error; a *missing* file is tolerated
(discovery returns "author it").

## Onboarding a new SPA (the M6 recipe)

Onboarding a SPA is **two data additions and nothing else** — no new resolver,
command, or `core/**` logic. `connectv3` is the worked example (M6):

1. Add **one row** to the built-in SPA registry (`src/core/flow/spa-registry.ts`)
   pointing at the SPA's frontend `system`, its `repoEnvVar`/`defaultRepoSubpath`,
   and its `appDir`/`e2eDir`/`playwrightConfig` (confirm against
   `src/core/manifest/services.ts`).
2. Author the SPA's `flows.json` (copy one of these examples, edit the `spa` block
   + flows). In production it lives at `<repo>/<e2eDir>/flows.json`.

That's it. Discovery, the flow resolver, the N-of-M closure, and the in-process
orchestration are all **generic over the registry row + the `flows.json`** — they
needed no change to add a second SPA.

> Optional, for built-in SPAs only: ship a bundled example here and add a
> **data row** to `BUNDLED_EXAMPLE` in `src/e2e-orchestrate.ts` (keyed by SPA id),
> so `e2e list` / discovery fall back to the template until the repo authors its
> own `flows.json`. This is what both `saga-dash` and `connectv3` do — still data,
> not logic.

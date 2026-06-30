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

## Validation

Every `flows.json` is validated at load against the zod `flowManifestSchema`
(`src/core/flow/types.ts`), exported as the package's flow schema. A file that
exists but fails the schema is a hard error; a *missing* file is tolerated
(discovery returns "author it").

## Onboarding a new SPA

1. Add one row to the built-in SPA registry (`src/core/flow/spa-registry.ts`).
2. Copy `saga-dash.flows.json` into `<repo>/<e2eDir>/flows.json` and edit the
   `spa` block + flows.

No CLI code and no orchestration code in the SPA repo.

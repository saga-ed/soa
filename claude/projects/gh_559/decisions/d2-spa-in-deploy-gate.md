# d2 — Should the deploy gate test the SPA as well as the API?

**RESOLVED 2026-11-02: Option B** (skelly). `pnpm-filter: '@saga-ed/vishnu*...'`. Confirm with a `--dry-run` during I#560; fall back to C if the glob doesn't match both packages.

## Context

`deploy-ecs-api.yml` runs check-types, lint and test before it deploys, using a single `pnpm-filter` value (WF@v2.51:1444-1456). The image contains the API and the SPA, but `@saga-ed/vishnu` isn't a dependency of `@saga-ed/vishnu-api`, so the usual `@saga-ed/vishnu-api...` filter leaves the SPA out.

The SPA isn't untested today: `package-ci.yml` runs its check-types, test, test:int and build on PRs that touch it. A broken SPA build also fails the image build. What's missing is the SPA's typecheck and unit tests on deploys with no PR behind them, such as a dispatch from a branch or a sandbox.

## Options

**A. API only, rely on package-ci.** `pnpm-filter: '@saga-ed/vishnu-api...'`.
- Cost: nothing.
- Limit: a dispatch or sandbox from a branch with no PR can ship SPA code whose types and tests never ran, and the gate's green result covers only half the image.

**B. Name-glob filter.** `pnpm-filter: '@saga-ed/vishnu*...'`, which should match both packages and their dependencies.
- Cost: one line, plus some test time duplicated with package-ci on PRs.
- Limit: not yet run; confirm with `turbo run test --filter='@saga-ed/vishnu*...' --dry-run` before relying on it.

**C. Declare the SPA as a dev dependency of the API.** The standard `@saga-ed/vishnu-api...` filter then includes it, and the graph states that the image needs the SPA.
- Cost: a package change that also affects build ordering everywhere that filter is used.
- Limit: more change than the problem needs.

## Recommendation

**B.** With d1 adding sandbox deploys from branches, deploys with no PR behind them become routine, and the image's gate should cover the whole image. Fall back to C if the glob doesn't work.

## Related artifacts

- I#560
- `research/01-ci-contract-gap.md`, "Gaps"

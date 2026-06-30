# @saga-ed/saga-stack-cli

`saga-stack` — the unified CLI for bringing up, seeding, verifying, resetting,
and end-to-end testing the **synthetic saga dev stack** across every repo
(soa, rostering, program-hub, saga-dash, sds, qboard, rtsm, fleek).

It is **one OCLIF v4 package, two topics** (`stack`, `e2e`) over a shared,
pure, unit-tested core. The binary uses a space topic separator:

```
saga-stack stack up --only scheduling-api --dry-run
saga-stack stack status
saga-stack e2e run connect-session
```

This package **supersedes `@saga-ed/mesh-fixture-cli`**: it folds the
fixture/snapshot lifecycle into a manifest-driven stack manager and replaces
the ~600+ lines of `up.sh`/`verify.sh`/seed bash with one frozen TS service
manifest plus a handful of generic, unit-tested consumers (`computeClosure`,
launch order, seed-plan composition, health probes).

## Status — M0 (scaffold + pure core)

This milestone ships the **pure core only**: the TS service manifest, the
dependency-closure engine, the seed-plan composer, the `BaseCommand`/`emit()`
triple-output (human / `--output-json` / `--porcelain`), the global flag set,
unit tests, and `stack up --only … --dry-run` (prints the computed closure
with **no docker**). There is **no** docker / pnpm / curl / git execution yet —
that lands in M1+ (`runtime/**`).

Architecture invariant: `src/core/**` is pure (zero IO). Everything that
touches the world lives in `src/runtime/**`. The boundary is enforced by an
ESLint `no-restricted-imports` rule (see `eslint.config.js`).

## Invocation modes

- **built + global-link:** `pnpm build` then `saga-stack …`
- **dev, no build:** `./bin/dev.js …` (tsx loader runs straight from `src/`)
- **monorepo filter:** `pnpm --filter @saga-ed/saga-stack-cli saga-stack -- …`

## Plan

Authoritative design + manifest data + decisions:
`soa/claude/projects/gh_214/plans/01-saga-stack-cli-plan.md` (saga-ed/soa#214).

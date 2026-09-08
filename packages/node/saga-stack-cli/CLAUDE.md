# @saga-ed/saga-stack-cli

**Parent Context:** Part of [packages/node](../CLAUDE.md).

`saga-stack` (alias **`ss`**) — the unified CLI for bringing up, seeding,
verifying, resetting, snapshotting, and end-to-end testing the synthetic
saga dev stack across every repo (soa, rostering, program-hub, saga-dash,
sds, qboard, rtsm, coach, fleek). One OCLIF v4 package, two topics
(`stack`, `e2e`), driven by a single frozen TypeScript service manifest —
see the `saga-iac:ss` skill for the interactive workflow.

## Vendored-pair convention

`vendor/` holds adapted copies of scripts that also live under
`tools/synthetic-dev/*` (`tunnel.sh`, `browser-login.mjs`,
`refresh-suite.sh`) — the bash-driven synthetic-dev workflow this CLI wraps
stays in place, `ss` is additive, not a forced migration. Copies are **not
always byte-identical**: `vendor/refresh-suite.sh` diverges with an inline
comment explaining why (env-var overlay resolution). Check a vendor copy's
own header before assuming it matches its `tools/synthetic-dev/` original.

## Reference surface

This package's own [`docs/`](./docs/) (18 files) is the reference —
start at [`docs/getting-started.md`](./docs/getting-started.md). Don't
duplicate that ground here.

## Commands

`pnpm build` (tsc + oclif manifest), `pnpm test` (vitest), `pnpm lint`
(eslint), `pnpm check-types` (tsc --noEmit). Run the CLI itself via `ss`
or `pnpm saga-stack -- <args>`.

## Rules that apply here

- `testing-node.md`

---

*Last updated: 2026-09-08*

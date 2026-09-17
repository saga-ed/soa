# @saga-ed/saga-stack-cli

**Parent Context:** Part of [packages/node](../CLAUDE.md).

`saga-stack` (alias **`ss`**) — the unified CLI for bringing up, seeding,
verifying, resetting, snapshotting, and e2e-testing the synthetic saga dev
stack across every repo (soa, rostering, program-hub, saga-dash, sds,
qboard, rtsm, coach, fleek). One OCLIF v4 package, two topics (`stack`,
`e2e`) — see the `saga-iac:ss` skill for the interactive workflow.

## Vendored-pair convention

`vendor/` holds adapted copies of scripts/fixtures also under
`tools/synthetic-dev/*` (`tunnel.sh`, `browser-login.mjs`,
`refresh-suite.sh`, `seed-demo-polls.mjs`, `rtsm-fleet-local.json`) — the
bash-driven workflow this CLI wraps stays in place, `ss` is additive, not
a forced migration. Only `tunnel.sh`/`rtsm-fleet-local.json` are
byte-identical; the rest diverge, each with its own comment
(`refresh-suite.sh`: `OVERLAY_FILE` override, soa#214; `browser-login.mjs`: `CHROMIUM_EXTRA_ARGS`, soa#363;
`seed-demo-polls.mjs`: `IAM_SESSION` required, program-hub#570). Check a vendor copy's header first.

## Reference surface

This package's own [`docs/`](./docs/) (18 files) is the reference — start
at [`docs/getting-started.md`](./docs/getting-started.md); don't
duplicate that ground here.

## Commands

`pnpm build` (tsc + oclif manifest), `pnpm test` (vitest), `pnpm lint`
(eslint), `pnpm check-types` (tsc --noEmit). Run via `ss` or
`pnpm saga-stack -- <args>`.

## Rules that apply here

- `testing-node.md`

---

*Last updated: 2026-09-08*

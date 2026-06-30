# gh_214 — OCLIF CLI for synthetic-dev

Workspace for designing and building an [OCLIF](https://oclif.io/)-based CLI
that wraps and replaces the shell-script entrypoints for the local
`synthetic-dev` stack (`~/dev/soa/tools/synthetic-dev`).

- **Issue:** [saga-ed/soa#214](https://github.com/saga-ed/soa/issues/214)
- **Branch:** `gh_214`

## The problem

synthetic-dev is currently driven by a collection of shell scripts
(`up.sh`, `verify.sh`, `bootstrap.sh`, `refresh-integration.sh`,
`refresh-suite.sh`, …). They work, but the surface is hard to discover,
flags are inconsistent, argument handling is ad hoc, and the command logic
is difficult to test.

## What this initiative is

Build a structured OCLIF CLI that becomes the single, documented entrypoint
for the developer-facing synthetic-dev workflows (set / reset / verify /
seed / …). Goals:

1. Inventory the existing synthetic-dev script surface and the workflows
   each script supports.
2. Design the OCLIF command/topic structure that maps onto those workflows.
3. Plan and execute the migration from shell scripts to the CLI, keeping
   today's behavior intact during the transition.

## Layout

- `source/` — CLI implementation (OCLIF project / scaffolding) + the brief (`prompt-1.md`).
- `research/` — inventory of the current script surface, OCLIF patterns,
  and design notes (`01`–`05`).
- `plans/` — plan-of-record (`01-saga-stack-cli-plan.md`).

## Locked decisions

- One OCLIF package **`saga-stack-cli`** in `soa/packages/node/`, pure core lib +
  two topics (`stack`, `e2e`). Binary `saga-stack`. **Supersedes `mesh-fixture-cli`.**
- Seeding = orchestrate the offline per-service `pnpm db:seed` (no HTTP seeding);
  carry forward only mesh-fixture-cli's snapshot fast-path (rebuilt for 9 DBs) and
  its `emit()` output conventions. Drop its `iam:/pgm:/ads:` HTTP create commands.
- The service **manifest** (TS module) is the linchpin: ports/repos/health/DBs/
  `dependsOn`/seed/lane derive from it, enabling N-of-M partial-stack closure.
- Migration: incremental wrap-then-port (M0 pure core → M1 wrap → … → native).

## Key upstream files (what this wraps)

- `~/dev/soa/tools/synthetic-dev/up.sh` — stack bring-up.
- `~/dev/soa/tools/synthetic-dev/verify.sh` — verification.
- `~/dev/soa/tools/synthetic-dev/bootstrap.sh` — bootstrap/setup.
- `~/dev/soa/tools/synthetic-dev/refresh-integration.sh`,
  `refresh-suite.sh` — refresh flows.
- `~/dev/soa/tools/synthetic-dev/README.md` — drift log + service map.

## Cross-references

- `../multi-synthetic-dev/` — concurrent/namespaced instances track; shares
  the same `up.sh` surface this CLI would wrap.
- `../synthetic-dev-align/` — seed-ids convergence track.

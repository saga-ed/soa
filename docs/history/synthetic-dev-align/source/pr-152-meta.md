# saga-dash PR #152 — metadata snapshot

- **Repo:** saga-ed/saga-dash
- **PR:** [#152](https://github.com/saga-ed/saga-dash/pull/152)
- **Title:** docs: seed-ids onboarding, local mesh runbook & synthetic-dev convergence
- **Author:** Seth Paul (`SethPaul`)
- **Head → base:** `docs/seed-ids-onboarding` → `main`
- **State (at capture):** OPEN
- **Size:** +660 / −0, docs-only (3 files)
- **Captured:** 2026-06-04 via `gh pr view 152`

## Files

| Path | +/− |
|---|---|
| `docs/seed-ids-onboarding.md` | +258 |
| `docs/seed-ids-local-mesh-runbook.md` | +310 |
| `docs/seed-ids-synthetic-dev-convergence.md` | +92 |

## What (verbatim)

Three companion docs under `docs/` for the canonical `@saga-ed/*-seed-ids` packages:

- **`seed-ids-onboarding.md`** — reference: why they exist, the three packages + APIs, the source-verified ID inventory, usage patterns, and the seed-profile/db-host plumbing.
- **`seed-ids-local-mesh-runbook.md`** — hands-on: stand up the mesh locally, seed each service from the catalogs, and prove cross-service ID correlation offline. Defers to `soa/tools/synthetic-dev` as the canonical one-command bring-up.
- **`seed-ids-synthetic-dev-convergence.md`** — a draft proposal to seed synthetic-dev's canonical **base** from the deterministic seed-ids `db:seed` (matching preview/CI) while keeping the scenario runner as the **journey** layer on top.

## Why (verbatim)

The three seed-ids packages are published to CodeArtifact at `0.1.0-dev.0`, but there was no single place explaining how to consume them, how to run the integrated mesh locally, or how the new `synthetic-dev` tooling relates. saga-dash is the browser consumer, so it hosts the references.

## Notes (verbatim)

- The runbook's bring-up was reconciled against `soa/tools/synthetic-dev` and the live code: programs/scheduling require `IAM_API_URL` + `RABBITMQ_URL` at startup; iam runs on `:3010`; local login via `/demo#auth` or `./up.sh --login`.
- Correlation proof (offline `deriveGroupId('seed')` == iam group == programs `organizationId`) is the runbook's centerpiece.
- The convergence doc is a **draft for discussion**, not a decision.

Docs-only.

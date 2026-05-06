# Session B — rostering contract-check + Prisma sanity

> **Audience:** a fresh Claude Code session opened in the `saga-ed/rostering` repo.
> **Source of truth:** `saga-ed/soa@soa_75:claude/projects/soa_75/tasks/lateral-propagation.md`.
> **Created:** 2026-05-06.

## Identity

- **Repo:** `saga-ed/rostering`
- **Base branch:** `feat/iam-events-adoption` (the open branch behind PR #138)
- **Working branch:** `feat/iam-events-adoption-contract-check` (or layer
  commits directly onto `feat/iam-events-adoption` if Seth prefers — ask
  first; the PR is open and currently MERGEABLE).
- **Worktree:** create under `.claude/worktrees/<name>/` per global CLAUDE.md.
- **Target:** PR (or commits onto the existing one) that wires
  `@saga-ed/soa-contract-check` into iam-api's CI gate, plus a small
  Prisma packaging note.

## Why this exists

The `@saga-ed/soa-contract-check` package lives on `soa@main` at
`packages/node/contract-check/` (current version `0.1.0-dev.1`; commit
`5cd5993` on `soa_75` marks Layers 1+2 *documented* as implemented).
PR #138 (`feat/iam-events-adoption`)
defines events with `.eventType` / `.eventVersion` constants but has **not**
committed frozen schema snapshots and has **no CI gate** running
`soa-contract-check check`. This is the single highest-payoff lateral
propagation item — Seth wants it landed soon. This session does the
rostering side.

A parallel session (Session C) handles program-hub. A parallel session
(Session A1) is bumping shared `@saga-ed/*` packages — **do NOT bump
`@saga-ed/soa-event-*` dev tags during this session**; consume whatever
PR #138 already pins. Stay laser-focused on contract-check.

## Owned items (from `lateral-propagation.md`)

### 2.1 — `@saga-ed/soa-contract-check` CI wiring (rostering side) · P1

Adopters already define events via Zod schemas with `.eventType` /
`.eventVersion` constants (good). What's missing: frozen byte-for-byte
JSON snapshots committed to the repo + a CI step that fails on any
schema change without a `--bump` flag.

- **Acceptance:**
  - `contract-check.config.ts` at repo root pointing at the events
    package (likely `@saga-ed/iam-events` or
    `packages/core/iam-events/`).
  - `published/iam-api/v1.json` (or whatever path the contract-check
    package conventions dictate — check its README first).
  - CI job in `.github/workflows/` that runs `soa-contract-check check`
    on every PR and fails on schema byte-diff without `--bump`.
  - Commit a deliberately-broken change locally, run the gate locally,
    confirm it fails. Revert.
- Reference: `saga-ed/soa@main:packages/node/contract-check/` has
  the package + README (note the directory is `contract-check`, not
  `soa-contract-check` — the `soa-` prefix is only in the npm package
  name). `saga-ed/soa@soa_75:claude/projects/soa_75/decisions/d-contract-testing.md`
  has the rationale.

### 2.4 — Prisma CLI runtime-deps parity audit (rostering side) · P1

This is mostly **document the pattern**, not fix anything. PR #138
already moved `prisma` from devDeps → deps so preview-deploy migrate ECS
tasks can run `pnpm exec prisma migrate deploy` on a `--prod` install.
The rostering-side cost is just adding a one-paragraph note to the
project's `claude/` notes (or `apps/node/iam-api/CLAUDE.md`)
documenting the pattern so future event-driven services in the
rostering repo don't relearn it.

- **Acceptance:** new section in `apps/node/iam-api/CLAUDE.md` (or
  equivalent) titled "Prisma packaging in event-driven services" with
  the gotcha + the chosen fix. ~10 lines. Reference:
  memory `project_pr_preview_event_driven_pilot.md` § "Prisma packaging
  in Dockerfile (iam-api gotchas)".

## Out of scope

- Anything touching `@saga-ed/soa-event-test-harness`,
  `@saga-ed/soa-event-consumer`, `@saga-ed/soa-rabbitmq` versions —
  Session A1 owns those. Don't bump them.
- Deleting the in-tree `id()` UUID helper at
  `apps/node/iam-api/src/__tests__/helpers/uuid.ts` — Session D does
  that after A1 merges and ships the helper in `soa-event-test-harness`.
- Program-hub work (that's Session C).
- Anything in the broader event-outbox / consumer / observability
  packages.

## Verification

1. Locally: `pnpm exec soa-contract-check check` from repo root passes
   on the unmodified branch.
2. Make a deliberate breaking change to an event schema (e.g., add a
   required field to `IamUserCreatedV1` payload), re-run the gate,
   confirm it fails with a useful diff. Revert.
3. CI: run the workflow on the PR; gate passes.
4. `pnpm --filter @saga-ed/iam-api check-types && pnpm --filter @saga-ed/iam-api build` still pass.

## On finish

- If layered onto the existing PR #138 branch: push and notify Seth
  (PR description likely needs a paragraph addition).
- If a separate PR: open into `feat/iam-events-adoption` (so it merges
  *before* #138 hits main, keeping the gate in place from day one).
- Tick item 2.1 (rostering portion) and 2.4 (rostering portion) in
  `saga-ed/soa@soa_75:claude/projects/soa_75/tasks/lateral-propagation.md`
  once merged. (You'll need to push that tick from a soa worktree, not
  the rostering one.)

## References

- Source-of-truth list: `saga-ed/soa@soa_75:claude/projects/soa_75/tasks/lateral-propagation.md`
- Decision: `saga-ed/soa@soa_75:claude/projects/soa_75/decisions/d-contract-testing.md`
- Package + README:
  `gh api repos/saga-ed/soa/contents/packages/node/contract-check?ref=main`
  (npm name is `@saga-ed/soa-contract-check`; directory is
  `packages/node/contract-check/` on `main`).
- Existing PR: `gh pr view 138 --repo saga-ed/rostering`
- Memory: `project_pr_preview_event_driven_pilot.md` — Prisma
  packaging gotchas if you need them

# Session C — program-hub contract-check + Prisma audit + roleName

> **Audience:** a fresh Claude Code session opened in the `saga-ed/program-hub` repo.
> **Source of truth:** `saga-ed/soa@soa_75:claude/projects/soa_75/tasks/lateral-propagation.md`.
> **Created:** 2026-05-06.

## Identity

- **Repo:** `saga-ed/program-hub`
- **Base branch:** `saga-ed/event-driven-adoption` (the open branch behind PR #60).
- **Working branch:** `saga-ed/event-driven-adoption-contract-check` (or
  layer onto `saga-ed/event-driven-adoption` directly — ask Seth first).
- **Worktree:** create under `.claude/worktrees/<name>/` per global CLAUDE.md.
- **Stacking note:** PR #62 (`saga-ed/event-driven-read-path`) is **stacked
  on** PR #60 and currently CONFLICTING. Land contract-check work on
  `saga-ed/event-driven-adoption` so #62 inherits it on rebase.
- **Target:** PR (or commits onto the existing one) that wires contract-check
  into both programs-api and scheduling-api, plus a Prisma audit and one
  small bug fix.

## Why this exists

Same motivation as Session B (rostering) but scaled to two services:
program-hub#60 lands programs-api + scheduling-api as event-driven
adopters but neither has frozen schema snapshots or a contract-check
CI gate. Seth wants this landed soon. This session does the program-hub
side. Sessions B (rostering) and A1 (soa packages) are running in
parallel.

**Coordination boundary:** do **NOT** bump `@saga-ed/soa-event-*` dev
tags during this session — Session A1 owns those bumps. Consume whatever
versions PR #60 already pins. Stay focused on contract-check + the
two small follow-ups below.

## Owned items (from `lateral-propagation.md`)

### 2.1 — `@saga-ed/soa-contract-check` CI wiring (program-hub side) · P1

Both programs-api and scheduling-api need the wiring. The events
packages are likely `@saga-ed/programs-events` and
`@saga-ed/scheduling-events` (verify in PR #60).

- **Acceptance:**
  - `contract-check.config.ts` at repo root covering both events
    packages.
  - `published/programs-api/v1.json` and `published/scheduling-api/v1.json`
    (path conventions per soa-contract-check README).
  - CI job in `.github/workflows/` that runs `soa-contract-check check`
    on every PR for both services and fails on byte-diff without `--bump`.
  - Local + CI verification per Session B's pattern.
- Reference: `saga-ed/soa@main:packages/node/contract-check/` has
  the package + README (note the directory is `contract-check`, not
  `soa-contract-check` — the `soa-` prefix is only in the npm package
  name `@saga-ed/soa-contract-check`).

### 2.4 — Prisma CLI runtime-deps parity audit (program-hub side) · P1

**This is the latent-bug check.** rostering#138 explicitly moved `prisma`
from devDeps → deps so preview-deploy migrate ECS tasks could run
`pnpm exec prisma migrate deploy` on a `--prod` install. PR #60 didn't
do this. Two paths:

1. **If program-hub's preview migrates work today**, document why
   (different Dockerfile pattern? `--prod` not used? separate migrate
   image?) and add a note to `apps/node/programs-api/CLAUDE.md` (and
   `scheduling-api/CLAUDE.md`).
2. **If they don't work** (or are silently broken), fix in this session:
   move `prisma` to deps, add the `pnpm rebuild prisma` Dockerfile
   step if `--ignore-scripts` is used, and copy `prisma.config.ts` +
   migrations from builder to runner stage.

- **Acceptance:** explicit verification recorded — try a clean preview
  deploy of programs-api against a fresh PR-schema and confirm migrate
  succeeds. Either no code change (path 1) or a small Dockerfile/package.json
  change (path 2).
- Reference: memory `project_pr_preview_event_driven_pilot.md`
  § "Prisma packaging in Dockerfile (iam-api gotchas)".

### 4.1 — `participantType` / `roleName` denormalization · P2

PR #62 review noted that `participantType` defaults to `'staff'` because
`roleName` isn't denormalized onto the group-membership event payload.
Producer needs to include it; consumer simplifies once present.

- **Acceptance:**
  - `programs.group.membership.*` event v2 includes `roleName`
    (define in `@saga-ed/programs-events` per d-event-versioning's
    integer-frozen-forever rule — bump version, keep v1 alive).
  - Producer (group/membership mutation paths in programs-api) emits v2.
  - Group-projection consumer (program-hub#62) handles both v1 and v2;
    `participantType` defaults removed once consumers are confirmed
    on v2 across the fleet.
  - Frozen-snapshot diff captured in the contract-check gate (item 2.1
    above) — a useful integration smoke test of both items.
- Reference: PR #62 review thread; `decisions/d-event-versioning.md`.

## Out of scope

- Anything touching `@saga-ed/soa-event-test-harness`,
  `@saga-ed/soa-event-consumer`, `@saga-ed/soa-rabbitmq` versions —
  Session A1 owns those. Don't bump them.
- Deleting in-tree `id()` UUID helpers at
  `apps/node/programs-api/src/__tests__/helpers/uuid.ts` and
  `apps/node/scheduling-api/src/__tests__/helpers/uuid.ts` — Session D
  does that after A1 merges.
- Rostering work (Session B).
- 1.5 consumer-queue isolation rule (decision doc, A2 in soa).

## Verification

1. Locally: `pnpm exec soa-contract-check check` passes on unmodified
   branch.
2. Add `roleName` to `programs.group.membership.*` v2 → contract-check
   gate fails without `--bump` (proves the gate works), pass with
   `--bump` and a v2 frozen snapshot.
3. Preview deploy of programs-api against a fresh PR-schema completes
   migrate successfully (proves 2.4).
4. `pnpm --filter @saga-ed/programs-api --filter @saga-ed/scheduling-api check-types && build && test` clean.
5. Group-projection consumer integration test asserts a v2 event lands
   with `roleName` propagated; v1 still handled.

## On finish

- Push to `saga-ed/event-driven-adoption-contract-check` (or onto
  `saga-ed/event-driven-adoption` directly per Seth's preference).
- PR #62 will need a rebase to inherit; flag this on the PR.
- Tick items 2.1 (program-hub portion), 2.4 (program-hub portion), and
  4.1 in `saga-ed/soa@soa_75:.../lateral-propagation.md` once merged
  (push from a soa worktree).

## References

- Source-of-truth list: `saga-ed/soa@soa_75:claude/projects/soa_75/tasks/lateral-propagation.md`
- Decisions:
  `saga-ed/soa@soa_75:claude/projects/soa_75/decisions/d-contract-testing.md`,
  `d-event-versioning.md`, `d-publisher-migration.md`
- Package: `gh api repos/saga-ed/soa/contents/packages/node/contract-check?ref=main`
- Existing PRs: `gh pr view 60 --repo saga-ed/program-hub`,
  `gh pr view 62 --repo saga-ed/program-hub`
- Memory: `project_pr_preview_event_driven_pilot.md` — Prisma packaging,
  IAM tier ceilings

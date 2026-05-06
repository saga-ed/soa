# Session A1 — soa package bump

> **Audience:** a fresh Claude Code session opened in the `saga-ed/soa` repo.
> **Source of truth:** [`../lateral-propagation.md`](../lateral-propagation.md) on branch `soa_75`.
> **Created:** 2026-05-06.

## Identity

- **Repo:** `saga-ed/soa`
- **Base branch:** `soa_75`
- **Working branch:** `soa_75/lift-helpers-and-options` (or similar; pick when starting)
- **Worktree:** create under `.claude/worktrees/<name>/` per global CLAUDE.md convention.
- **Target:** one PR into `soa_75` that bundles a coordinated dev-tag bump across 3–4 packages.

## Why this exists

The event-driven pilot has shipped patterns inside three adopter services
(iam-api in `rostering#138`, programs-api + scheduling-api in
`program-hub#60` and `#62`) that ought to live in shared `@saga-ed/*` packages
instead. This session lifts those patterns up. After this lands, **Session D**
(adopter cleanup, scheduled later) will swap adopters from in-tree copies to
the shared helpers.

**Crucial coordination boundary:** sessions B and C are running in parallel
in the adopter repos and have been told **not to bump to new soa dev tags
until this session merges and announces a version**. Don't break the
existing dev tags consumed by `feat/iam-events-adoption` (rostering#138)
and `saga-ed/event-driven-adoption` (program-hub#60). Bump the
`0.1.0-dev.N` suffix forward, don't reuse a tag.

## Owned items (from `lateral-propagation.md`)

### 1.1 — `id()` UUID test helper graduation · P1

Three event-driven services ship an identical `id(seed)` helper that
returns a deterministic UUID-v4-shaped string from a seed. Used because
event payload schemas validate `string().uuid()` strictly, so `'prog-1'`
test IDs fail.

- Canonical impl: `apps/node/iam-api/src/__tests__/helpers/uuid.ts` in
  the rostering repo (PR #138). Same file in program-hub at
  `apps/node/programs-api/src/__tests__/helpers/uuid.ts` and
  `apps/node/scheduling-api/src/__tests__/helpers/uuid.ts`.
- **Acceptance:** helper exported from `@saga-ed/soa-event-test-harness`
  (`import { id } from '@saga-ed/soa-event-test-harness'`). Adopters
  delete their in-tree copies in Session D, not here.

### 1.6 — UPSERT-handler pattern + helper · P2

Out-of-order delivery is default in RabbitMQ; consumer projection
handlers must UPSERT on event timestamp/version, not blind INSERT.
Both adopters built this inline; no shared helper.

- **Acceptance:** `@saga-ed/soa-event-consumer` exports an
  `upsertProjection(tx, table, key, payload, eventTs)` helper or a
  documented pattern at minimum. Worked example test in
  `soa-event-test-harness`.
- Reference: `decisions/d-consumer-resilience.md` (RESOLVED 2026-05-05).

### 1.8 — Non-fatal-broker-startup behavior codified · P2

In dev/test, broker unavailable should log + continue; in prod, fail
loud. Each adopter wires this manually today.

- **Acceptance:** `ConnectionManager` in `@saga-ed/soa-rabbitmq`
  accepts a `failureMode: 'fatal' | 'log-and-continue'` option;
  default keys off `NODE_ENV` (`'log-and-continue'` for non-prod,
  `'fatal'` for prod) with explicit override per service. Document
  the matrix in the package README.

### 2.3 — `@saga-ed/soa-event-test-harness` adoption + docs · P2

Package exists at `0.1.0-dev.1` but has no usage docs / example test
suite. Adopters' integration tests are bespoke.

- **Acceptance:** `packages/node/soa-event-test-harness/README.md`
  with a worked example mirroring iam-api's `outbox-roundtrip.int.test.ts`;
  covers (a) Postgres + RabbitMQ container spin-up, (b) `id()` helper
  (1.1 above), (c) "tick relay → assert message received on bound queue".
  No need to refactor adopter tests in this session — that's Session D.

### 1.2 (lint-rule part only) — OTel `initTracing()` import-order check · P1

The README banner part of 1.2 should land separately as a doc-only PR
(see Session A2 below). What lands here is the **lint rule**.

- **Acceptance:** ESLint rule (or comment-based lint, or a small
  `eslint-plugin-saga-soa` if the repo already has one) that fails when
  any import in a `main.ts` file precedes a call to `initTracing()`.
  Wire into the soa lint preset; verify it fires on a deliberately-broken
  fixture.

## Out of scope for this session

- Adopter-repo work (Sessions B and C handle rostering / program-hub).
- Decision-doc edits — A2 (the docs/decisions session) handles those.
- Bumping adopter consumers to the new dev tags (Session D, later).
- 1.7 soft-/hard-delete projection guidance (decision doc, A2).
- 1.4 bulk-mutation strategy (decision, blocked on Seth).

## Verification

1. `pnpm -r --filter '@saga-ed/soa-event-test-harness' --filter '@saga-ed/soa-event-consumer' --filter '@saga-ed/soa-rabbitmq' build` clean.
2. `pnpm -r --filter '@saga-ed/soa-event-test-harness' --filter '@saga-ed/soa-event-consumer' --filter '@saga-ed/soa-rabbitmq' test` clean.
3. Smoke: in a scratch directory, `npm view @saga-ed/soa-event-test-harness@<new-dev-tag>` resolves once the publish workflow runs (don't manually publish — let CI do it post-merge).
4. ESLint rule (1.2): write a fixture file that imports `reflect-metadata` *before* `initTracing()`; rule must report.

## On finish

- Open the PR into `soa_75` titled
  `feat(soa_75): lift id()/UPSERT/failureMode helpers + harness docs + OTel lint rule`.
- In the PR body, name the new dev tag set explicitly (e.g.,
  `@saga-ed/soa-event-test-harness@0.1.0-dev.3`,
  `@saga-ed/soa-event-consumer@0.1.0-dev.3`,
  `@saga-ed/soa-rabbitmq@1.2.0-dev.1`).
- Tick items 1.1, 1.6, 1.8, 2.3 and the lint-rule portion of 1.2 in
  `claude/projects/soa_75/tasks/lateral-propagation.md` once merged.
- Notify Seth so Session D can start.

## References

- Task list: `claude/projects/soa_75/tasks/lateral-propagation.md`
- Decisions: `claude/projects/soa_75/decisions/d-consumer-resilience.md`,
  `d-observability.md`, `d-soa-pubsub-divorce.md`
- Adopter canonical impls (read-only — reach via `gh api`):
  - `gh api repos/saga-ed/rostering/contents/apps/node/iam-api/src/__tests__/helpers/uuid.ts`
- Memory: `project_pr_preview_event_driven_pilot.md` covers Dockerfile/Prisma
  context if you touch packaging.

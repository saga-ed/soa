# Session A1 — soa package bump

> **Audience:** a fresh Claude Code session opened in the `saga-ed/soa` repo.
> **Source of truth:** [`../lateral-propagation.md`](../lateral-propagation.md) on branch `soa_75`.
> **Created:** 2026-05-06.

## Identity

- **Repo:** `saga-ed/soa`
- **Base branch:** `main` ⚠️ **NOT `soa_75`** — the `@saga-ed/soa-*`
  event-driven packages (`observability`, `event-outbox`,
  `event-consumer`, `event-test-harness`, `contract-check`,
  `event-envelope`) all live on `main`, not on `soa_75`. soa_75 is the
  planning/decisions branch and carries no package source. (Earlier
  draft of this handoff said `soa_75` — that was wrong; corrected
  2026-05-06.)
- **Package directory naming:** `packages/node/observability/` (not
  `soa-observability/`), `packages/node/event-outbox/`, etc. The
  package.json `name` field is `@saga-ed/soa-*` but the directory
  shortens that prefix.
- **Current dev-tag versions on `main` (your baseline; bump forward):**
  - `@saga-ed/soa-observability@0.1.0-dev.1`
  - `@saga-ed/soa-event-envelope@0.1.0-dev.3`
  - `@saga-ed/soa-event-outbox@0.1.0-dev.4`
  - `@saga-ed/soa-event-consumer@0.1.0-dev.3`
  - `@saga-ed/soa-event-test-harness@0.1.0-dev.1`
  - `@saga-ed/soa-contract-check@0.1.0-dev.1`
- **Working branch:** `feat/lift-helpers-and-options` (pick when
  starting; cut from `main`).
- **Worktree:** create under `.claude/worktrees/<name>/` per global
  CLAUDE.md convention.
- **Target:** one PR into `main` that bundles a coordinated dev-tag
  bump across `observability`, `event-consumer`, `event-test-harness`,
  and `rabbitmq` (whichever subset the work below touches).

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
  `event-test-harness`.
- Reference: `claude/projects/soa_75/decisions/d-consumer-resilience.md`
  (RESOLVED 2026-05-05) — read on `soa_75`, not `main`.

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

- **Acceptance:** `packages/node/event-test-harness/README.md`
  with a worked example mirroring iam-api's `outbox-roundtrip.int.test.ts`;
  covers (a) Postgres + RabbitMQ container spin-up, (b) `id()` helper
  (1.1 above), (c) "tick relay → assert message received on bound queue".
  No need to refactor adopter tests in this session — that's Session D.

### 1.2 — OTel `initTracing()` import-order check (lint rule + README banner) · P1

Both adopters silently lost spans when a tracer-using import preceded
`initTracing()` in `main.ts`. Two complementary protections:

- **Acceptance (lint rule):** ESLint rule (or comment-based lint, or a
  small `eslint-plugin-saga-soa` if the repo already has one) that
  fails when any import in a `main.ts` file precedes a call to
  `initTracing()`. Wire into the soa lint preset; verify it fires on a
  deliberately-broken fixture.
- **Acceptance (README banner):** loud banner at the top of
  `packages/node/observability/README.md` documenting the rule with a
  worked correct/incorrect example.

### 1.3 — Outbox-pool sizing default (docstring) · P2

`createOutboxPool` accepts `max` but adopters set it differently —
rostering leaves default; program-hub sets `max: 4` to avoid starving
the HTTP request pool. No canonical guidance.

- **Acceptance:** `createOutboxPool` (in `packages/node/event-outbox/`)
  defaults to `max: 4` and the docstring explains why ("avoid starving
  the HTTP request pool; outbox traffic is bursty and short-lived"). If
  Seth specifies a different number before you start, use that;
  otherwise `4` is the fallback because that's what one shipped adopter
  uses already.

### 1.5 — Consumer-queue isolation rule (README addition) · P2

program-hub#62 splits `GroupProjectionConsumer` from
`IamProjectionConsumer` to prevent poison-message backpressure. Earlier
adopters didn't split. No documented rule.

- **Acceptance:** one-paragraph "queue topology" section in
  `packages/node/event-consumer/README.md` stating the rule:
  *"Bind one consumer per event family. If a service consumes more than
  one event family (e.g., `iam.*` and `programs.*`), instantiate a
  separate `EventConsumer` per family bound to a distinct queue, so a
  poison message in one family doesn't block the other."* Reference
  program-hub#62 as the canonical example. The corresponding decision
  doc update lives on `soa_75` (Session A2 handles).

## Out of scope for this session

- Adopter-repo work (Sessions B and C handle rostering / program-hub).
- Decision-doc edits on `soa_75` — Session A2 handles those (1.4
  bulk-mutation options doc, 1.5 decision-side rule, 1.7 projection
  deletion guidance, 1.3 sizing rationale doc).
- Bumping adopter consumers to the new dev tags (Session D, later).
- Picking the bulk-mutation strategy (1.4) — blocked on Seth.

## Verification

1. `pnpm -r --filter '@saga-ed/soa-event-test-harness' --filter '@saga-ed/soa-event-consumer' --filter '@saga-ed/soa-rabbitmq' build` clean.
2. `pnpm -r --filter '@saga-ed/soa-event-test-harness' --filter '@saga-ed/soa-event-consumer' --filter '@saga-ed/soa-rabbitmq' test` clean.
3. Smoke: in a scratch directory, `npm view @saga-ed/soa-event-test-harness@<new-dev-tag>` resolves once the publish workflow runs (don't manually publish — let CI do it post-merge).
4. ESLint rule (1.2): write a fixture file that imports `reflect-metadata` *before* `initTracing()`; rule must report.

## On finish

- Open the PR into `main` titled
  `feat: lift id()/UPSERT/failureMode helpers + harness docs + OTel lint rule + sizing/topology docs`.
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

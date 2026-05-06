# soa_75 — lateral-propagation task list

> **Status:** active · **Created:** 2026-05-06 · **Owner:** soa_75 POC
>
> Durable, source-of-truth task list for **lateral propagation** between
> the four adopter repos of the SOA event-driven pilot:
>
> - `saga-ed/soa` — shared infra + decision docs (this branch: `soa_75`)
> - `saga-ed/rostering` — iam-api (PR #138)
> - `saga-ed/program-hub` — programs-api + scheduling-api (PRs #60, #62)
> - `saga-ed/student-data-system` — ads-adm-api (consumer, future adopter); ledger-api (publisher reference)
> - `saga-ed/soa_event_driven_example` — reference impl
>
> Items here are things one adopter shipped that another adopter (or a
> shared package) should pick up. **Vertical** items inside soa_75 itself
> live in `decisions/` — see those for follow-ups internal to a single
> decision doc.
>
> ### How to update this file
>
> - Tick `[x]` when the work has shipped in **all** in-scope repos for that item.
> - Add a one-line note + PR link under the item when partially landed.
> - When opening a new task, copy the template at the bottom.
> - Re-run `/lateral-review` (or the equivalent) to re-survey adopters
>   when a new adopter joins (e.g., student-data-system soa_75 branch).

---

## Severity legend

- **P1** — blocker for the *next* adopter; absence will cause real bugs or rediscovery cost
- **P2** — should-do; mature pattern, low risk, just needs scheduling
- **P3** — nice-to-have; documentation, ergonomics, or speculative

## Repo tags

`[soa]` `[rostering]` `[program-hub]` `[sds]` `[example]`

---

## 1. Code & pattern propagation

### 1.1 — `id()` UUID test helper graduation · **P1**

`[soa]` `[rostering]` `[program-hub]`

All three event-driven services (iam-api, programs-api, scheduling-api)
ship an identical `id(seed)` helper that returns a deterministic
UUID-v4-shaped string from a seed string. Used because event payload
schemas validate `string().uuid()` strictly, so `'prog-1'` test IDs fail.

- Canonical impl: `apps/node/iam-api/src/__tests__/helpers/uuid.ts`
  (rostering#138). Identical copies in programs-api / scheduling-api
  (program-hub#60).
- **Acceptance:** helper exported from `@saga-ed/soa-event-test-harness`
  (`import { id } from '@saga-ed/soa-event-test-harness'`); all three
  in-tree copies removed; sds adopters import it from day one.
- Source: cross-PR survey 2026-05-06.

### 1.2 — OTel `initTracing()` import-order footgun · **P1**

`[soa]` `[rostering]` `[program-hub]` `[sds]`

`initTracing(name)` MUST be the first import in `main.ts`, before any
module that imports a tracer. Both adopters silently lost spans during
development before catching this. Currently each repo carries the rule
as a one-line comment; new adopters will rediscover it.

- **Acceptance:**
  1. Loud README banner in `@saga-ed/soa-observability` package
  2. ESLint rule (or comment-based lint) in `soa` linting preset that
     fails when a non-tracing import precedes `initTracing` in any file
     named `main.ts`
  3. Update to `decisions/d-observability.md` calling this out as the
     known footgun
- Source: rostering#138, program-hub#60 both hit this; d-observability
  resolved 2026-04-30 but lacks the footgun callout.

### 1.3 — Outbox-pool sizing convention · **P2**

`[soa]` `[rostering]` `[program-hub]`

`createOutboxPool` accepts `max` but adopters set it differently —
rostering#138 leaves default; program-hub#60 explicitly sets `max: 4`
to avoid starving the HTTP request pool. There's no canonical guidance.

- **Acceptance:** `createOutboxPool` defaults to `max: 4` (or whatever
  the agreed-on number is) and the docstring explains why; rostering
  picks up the default by removing the override; program-hub keeps `4`
  redundantly until a soa bump propagates.
- Source: shared-package inventory + adopter PR survey 2026-05-06.

### 1.4 — Bulk-mutation event-emission strategy · **P1 (decision)**

`[soa]` `[program-hub]`

scheduling-api's `setHolidays` and `regenerate` paths would emit
thousands of `calendar_event.*` events under the current per-mutation
envelope pattern. Three options noted in d-publisher-migration but not
selected: per-event envelopes (broker burst risk), bulk-summary events
(consumers re-fetch), or skip emission (loses event-driven benefit).

- **Acceptance:** decision recorded in
  `claude/projects/soa_75/decisions/d-publisher-migration.md` (flip from
  OPEN to RESOLVED), reference impl in scheduling-api PR, runbook note
  for ops.
- Source: d-publisher-migration § Bulk-mutation strategy (OPEN, flagged
  in adopter-lessons commit `fe62c71`).

### 1.5 — Consumer-queue isolation rule · **P2**

`[soa]` `[program-hub]`

program-hub#62 introduces a separate `GroupProjectionConsumer` queue
distinct from `IamProjectionConsumer` to prevent poison-message
backpressure. Earlier program-hub#60 + rostering#138 don't split. No
documented rule for when to split.

- **Acceptance:** rule in `decisions/d-consumer-resilience.md` (e.g.,
  ">1 event family per service → separate consumer queues") plus a
  one-paragraph "queue topology" section in `@saga-ed/soa-event-consumer`
  README.
- Source: program-hub#62 review.

### 1.6 — UPSERT-handler pattern + helper · **P2**

`[soa]` `[program-hub]`

Out-of-order delivery is default in RabbitMQ; consumer handlers must
UPSERT on event timestamp/version, not blind INSERT. Both adopters
independently built this in projection handlers; no shared helper.

- **Acceptance:** `@saga-ed/soa-event-consumer` exports an
  `upsertProjection(tx, table, key, payload, eventTs)` helper or
  documented pattern; example test in `soa-event-test-harness`.
- Source: d-consumer-resilience (RESOLVED 2026-05-05); pattern lives
  inline in adopter handlers.

### 1.7 — Soft-delete vs hard-delete projection guidance · **P2**

`[soa]`

When a downstream service has FKs depending on a projection row,
`status='deleted'` is required; pure read-model caches can hard-DELETE.
Neither rule is currently documented; adopters pick implicitly.

- **Acceptance:** one-page section in d-consumer-resilience or a new
  `decisions/d-projection-deletion.md`, with a decision matrix +
  worked examples from programs-api (soft-delete due to enrollment
  FKs) and a hypothetical analytics-only consumer (hard-delete).

### 1.8 — Non-fatal-broker-startup behavior codified · **P2**

`[soa]` `[rostering]` `[program-hub]`

In dev/test, broker unavailable should log + continue (so docker-compose
profile-gated stacks don't block local dev). In prod, it must fail loud.
Currently each adopter wires this manually.

- **Acceptance:** `ConnectionManager` in `@saga-ed/soa-rabbitmq` accepts
  a `failureMode: 'fatal' | 'log-and-continue'` option; default keyed
  off `NODE_ENV` with explicit override per service; README documents
  the matrix.

### 1.9 — Trace-ID propagation into log payloads · **P3**

`[soa]`

`@saga-ed/soa-event-envelope` ships W3C TraceContext, but
`@saga-ed/soa-logger` (Pino) doesn't auto-include trace_id/span_id in
emitted records. Operators currently grep across two systems.

- **Acceptance:** soa-logger child-logger helper that pulls active OTel
  context and injects `trace_id` / `span_id` into Pino bindings;
  documented in soa-logger README.

---

## 2. Shared-package adoption gaps

### 2.1 — `@saga-ed/soa-contract-check` CI wiring in adopters · **P1**

`[rostering]` `[program-hub]`

Package shipped + soa_75 marks Layers 1+2 as implemented (commit
`5cd5993`). Adopter PRs (rostering#138, program-hub#60/#62) define
events with `.eventType` / `.eventVersion` constants but neither has a
CI step running `soa-contract-check check` against frozen snapshots,
nor checked-in `published/` snapshots.

- **Acceptance:** each event-publishing repo has
  - `contract-check.config.ts` at root
  - `published/<service>/<version>.json` frozen schemas committed
  - CI job in PR workflow that fails on byte-diff without `--bump`
- Source: d-contract-testing RESOLVED + adopter-PR survey.

### 2.2 — Per-publisher events packages parity · **P2**

`[rostering]` `[program-hub]` `[sds]`

`@saga-ed/iam-events@0.1.0-dev.1` is published (rostering#138).
`@saga-ed/programs-events` and `@saga-ed/scheduling-events` are
referenced in program-hub#60/#62 — confirm they are published with
matching dev tags. sds (ledger-api or admissions) needs its own events
package when it joins as a publisher.

- **Acceptance:** all three events packages published to CodeArtifact;
  versions tracked in d-event-package-shape; sds events package decision
  recorded when sds joins.

### 2.3 — `@saga-ed/soa-event-test-harness` adoption + docs · **P2**

`[soa]` `[rostering]` `[program-hub]`

Package exists (v0.1.0-dev.1) but has no usage docs / example test
suite. Adopter integration tests
(`outbox-roundtrip.int.test.ts` in iam-api) are bespoke.

- **Acceptance:** README in `packages/node/soa-event-test-harness/`
  with a worked example mirroring `outbox-roundtrip.int.test.ts`;
  iam-api / programs-api / scheduling-api tests refactored to use the
  harness; covers (a) Postgres + RabbitMQ container spin-up,
  (b) `id()` helper (item 1.1), (c) "tick relay → assert message
  received on bound queue" pattern.

### 2.4 — Prisma CLI runtime-deps parity audit · **P1**

`[rostering]` `[program-hub]`

rostering#138 moves `prisma` from devDeps → deps so preview-deploy
migrate ECS tasks can `pnpm exec prisma migrate deploy`. program-hub#60
doesn't mention this — if its preview deploys also run a migrate task,
it has a latent failure on a clean image.

- **Acceptance:** explicit audit recorded — for each event-driven
  service, either (a) prisma CLI is in `dependencies` and Dockerfile
  uses the `pnpm rebuild prisma` workaround when `--ignore-scripts`,
  or (b) the migrate task uses a separate image with prisma in deps.
  Document the chosen pattern in `claude/esm.md` or a new
  `claude/event-driven-service-packaging.md`.
- Source: memory `project_pr_preview_event_driven_pilot.md` + PR
  diff survey.

### 2.5 — `@saga-ed/soa-rabbitmq` integration template · **P3**

`[soa]`

Package exists at v1.1.3 but no service on soa_75 actually wires it —
adopter wiring lives in apps' `inversify.config.ts`. New adopters
re-derive the binding pattern.

- **Acceptance:** `packages/node/soa-rabbitmq/README.md` includes a
  drop-in inversify binding snippet; `apps/node/<event-driven-template>/`
  scaffolding (or just the README example) shows the canonical
  ConnectionManager + OutboxRelay + EventConsumer wiring.

---

## 3. Infra / IaC follow-ups

> **Note (2026-05-06):** an initial draft of this section flagged
> "preview-deploy IaC not built" as a P1 blocker, plus a P2 cleanup-parity
> gap between rostering and program-hub. Both items were **wrong** —
> end-to-end smoke tests have run against CICD-deployed previews, and
> direct inspection of `cleanup-preview-{iam,programs,scheduling}-api.yml`
> + the underlying composite actions
> (`.github/actions/cleanup-{iam,programs,scheduling}-api/action.yml`)
> shows the cleanup shape is identical across all three services
> (delete service stack → delete routing stack → delete SSM target-group-arn).
> Schema / per-PR secret / broker resource teardown is handled by
> CloudFormation stack delete cascade rather than orchestrated from CI.
> The synthesis error came from weighting a stale decision-doc claim
> over the diff-level evidence; flagged for future re-surveys.

### 3.1 — Orphan-schema reaper coverage extension · **P2**

`[sds]`

Daily reaper workflows exist in rostering + program-hub
(`.github/workflows/cleanup-orphan-preview-schemas.yml`). When sds
joins as an event-driven adopter (ads-adm-api or admissions service),
it needs its own reaper.

- **Acceptance:** sds adds an equivalent workflow when its first
  event-driven preview deploy lands. Track here so it's not forgotten.

### 3.2 — db-host `max_connections` raise (Phase 5 deferred) · **P2**

`[soa]` (external: `@saga-ed/infra-compose`)

With `outboxPool.max=4` and ~5 Prisma connections per service,
10 concurrent PRs × 3 services × 9 connections ≈ 270 — over the default
100 cap on db-host. Currently safe at 1–3 concurrent PRs.

- **Acceptance:** `@saga-ed/infra-compose` HTTP service raises
  `max_connections` to 500 (or sets per-DB cap policy), released, and
  consumed by db-host instances. Closes Phase 5 deferral.
- Source: memory + d-preview-deploy-isolation.

### 3.3 — DLQ Prometheus alert-rule template · **P2**

`[soa]`

Each adopter wires its own DLQ alert (`events_in_dlq > 0` sustained).
No canonical rule template — next adopter rediscovers thresholds.

- **Acceptance:** alert-rule snippet in `@saga-ed/soa-observability`
  README (or a sibling `monitoring/` dir) with thresholds, labels, and
  a worked Grafana panel reference.

---

## 4. Decision-doc → adopter-repo propagation

### 4.1 — `participantType` denormalization on group events · **P2**

`[program-hub]`

program-hub#62 review noted `participantType` defaults to `'staff'`
because `roleName` isn't denormalized onto the group-membership event
payload. Producer needs to include it; consumer handler simplifies
once present.

- **Acceptance:** `programs.group.membership.*` event v2 includes
  `roleName`; programs-api producer + group-projection consumer
  updated; v1 events kept until soak per d-event-versioning.

### 4.2 — Adopter-lesson decisions cross-link · **P3**

`[soa]`

3 adopter-lesson decision docs landed (commit `fe62c71`). The decision
docs themselves don't yet link to the canonical adopter PR diffs that
prompted the lessons.

- **Acceptance:** each adopter-lesson doc carries a "Source PR(s)" line
  near the top: rostering#138 / program-hub#60 / program-hub#62 anchor
  links.

---

## 5. New-adopter onboarding (`sds`)

When `student-data-system` joins on its `soa_75` branch (currently the
parent fixture branch), all P1 items above apply on day one. Track
sds-specific onboarding here:

- [ ] **5.1** sds event-driven service (likely admissions or
  ads-adm-api) chooses publisher vs consumer role; record in
  `decisions/d-sds-adoption.md` (new doc).
- [ ] **5.2** sds events package created if publisher (item 2.2).
- [ ] **5.3** sds preview-deploy infra mirrored from rostering / program-hub
  (items 3.1, 3.2).

---

## Template (copy when adding a new task)

```markdown
### N.M — Short title · **P{1,2,3}**

`[repo-tags]`

One-paragraph context — what's in one repo that's missing in
another, and why it matters.

- **Acceptance:** concrete check that closes the item.
- Source: PR / decision-doc / commit reference.
```

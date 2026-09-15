# D13 — Outbox hardening and blue/green isolation for the event plane

**Status:** PROPOSED 2026-09-15 — needs review by Seth. Spans `soa`, `rostering`, `program-hub`
(and the `saga-bluegreen` CLI). Research for this record was gathered on branch
`claude/outbox-optimization-isolation-os89ee` in each repo.

## Context

Three related problems surfaced together:

1. **Outbox table scan.** The canonical `PRISMA_MODEL_FRAGMENT` shipped a plain
   `@@index([occurredAt])`, because Prisma's DSL cannot express a `WHERE published_at IS NULL`
   partial index. Every adopter copied it, the relay's poll degraded to a scan of all published
   rows, and iam-api's outbox took the DB down with it.
2. **Every task polls the outbox.** With `DesiredCount` 2–3 per colour and two colours warm during
   a bake, up to six relays hammer one table at 500 ms each. Only one needs to.
3. **Colours share the event plane.** Blue/green isolates HTTP via ALB weights, but both colours
   run relays against the same outbox table and consumers against the *same queue names*. Which
   colour's code handles a given message is decided by AMQP round-robin, not by the operator.

## What is already built (do not redo)

| Piece | Where | State |
|---|---|---|
| Partial poll index `outbox_event_unpublished_idx (occurred_at) WHERE published_at IS NULL`, legacy index drop, `published_at` partial index, archive table DDL, boot-time `assertOutboxIndexHealth` (default `'throw'`) | soa `fix/outbox-partial-index-retention` — `packages/node/event-outbox/src/schema.ts`, `create-pool.ts` | Built, tested. **Not merged.** |
| Leader election: session-level `pg_try_advisory_lock(hashtext('soa-event-outbox:outbox_event'), hashtext(current_schema()))`; non-leaders tick in memory only; leader loss re-pursued every `leaderPollIntervalMs` (5 s) | same branch, `relay.ts` | Built, tested. On by default once the version bumps. |
| Retention sweeper: `DELETE … RETURNING` → `INSERT … ON CONFLICT DO NOTHING` into `outbox_event_archive`, bounded per sweep, leader-gated via `startRetentionTimer` | same branch, `retention.ts` | Built. Postgres-only, no S3. |
| iam-db migrations for the four DDL pieces above (`20260914150000`–`20260914150300`) | rostering `fix/outbox-partial-index` | Built. Archive table is a shell until the soa sweeper ships. |
| Event-plane name tagging `applyPreviewTag(name)` → `name.<EVENT_PREVIEW_TAG>` | soa `event-envelope/src/preview-tag.ts`; every relay/consumer in both app repos already wraps names in it | Live. **Empty for blue/green**: `service-template.yaml` sets `EVENT_PREVIEW_TAG = If[IsPreviewDeploy, Identifier, '']` and `IsPreviewDeploy` excludes colours. |
| Colour identity in a task | `OTEL_RESOURCE_ATTRIBUTES=…deployment.identifier=<Identifier>`; parsed by `soa-health` and `soa-logger` | Live. There is no `DEPLOY_COLOR` var and D10's rationale for not adding one still holds. |

**Gap the reference branches do not cover:** all four program-hub services (programs-api,
scheduling-api, sessions-api, content-api) still carry the non-partial
`idx_outbox_event_unpublished`. They will hit the same incident shape, and once event-outbox
bumps with `indexAssert: 'throw'` they will **fail boot** until migrated.

## The isolation problem, precisely

Colours share the database and the broker URL (`/shared/infra/prod/<svc>-rabbitmq-url` has no
colour branch). Consequences today, when blue and green are both warm:

- **Relays:** both colours' tasks contend for the same rows. `FOR UPDATE SKIP LOCKED` keeps it
  correct; leader election (above) keeps it cheap. But the lock is per *schema*, so the leader may
  be a task of the colour that is about to be retired. On `retire` the session drops, the lock
  releases, and the live colour picks it up within ~5 s. Acceptable, but accidental.
- **Consumers:** both colours declare the identical durable queue and both `basic.consume`. Each
  message goes to exactly one of them, chosen by the broker. The real hazard is version skew:
  after an HTTP flip to green, green producers may emit `iam.user.created.v2`; if blue's consumer
  receives it, `ConsumerVersionMismatchError` is treated as poison → nack-without-requeue → DLQ.
  The message is *lost to the live system* even though green has a v2 handler. Frozen-once-published
  versioning guarantees the reverse direction (new code handles old events); it does not protect
  this direction.
- **Idempotency keys are colour-blind** (`consumed_events.consumer_name`, authz-api's
  `projection_readiness`), which is correct: one logical consumer moves between colours.

So "isolation" in prod cannot mean data isolation (same DB). It means: **exactly one colour holds
each consumer at a time, the operator chooses which, and the change is ordered against the HTTP
flip so the consuming colour is never older than the producing colour.**

## Options considered — consumer selection

| Option | Mechanism | Why not / why |
|---|---|---|
| Per-colour queue suffix (`…projection.blue`) | Both colours get every message; dark colour's queue backs up or is drained by dedup | Unbounded backlog on the retired colour, double delivery, still no operator choice. Rejected. |
| Colour tag in the envelope / routing key | Producer stamps its colour | Producer colour ≠ desired consumer colour. Rejected. |
| Derive active colour from the ALB live rule (`DescribeRules`) | Zero new state, events follow HTTP automatically | Ordering is wrong by construction (consumer flips *after* HTTP, inside the hazard window) and the planes cannot be flipped independently, which is the ask. Rejected as primary; fine as a `status` cross-check. |
| **Explicit control parameter + consumer gate** *(recommended)* | SSM `/prod/bluegreen/<service>/active-color` ∈ `blue\|green`; each task compares it to its own identifier and only consumes when it matches | One lever, same shape as the ALB flip, orderable, absent-param = today's behaviour so adoption is per-service and dev/preview are untouched. |
| RabbitMQ `x-single-active-consumer` | Broker enforces ≤1 active consumer per queue | Excellent belt for the gate's braces, but it is a queue *argument* (not policy-settable) so every existing queue must be drained and re-declared, and it caps in-colour parallelism at one consumer per queue. Phase 2, optional. Whether SAC honours consumer `x-priority` varies by RabbitMQ version — do not design around priority. |

## Recommended design

### 1. Control plane

- SSM `String` parameter per service: `/prod/bluegreen/<service>/active-color`. Values `blue`,
  `green`. Written only by `saga-bluegreen` (new subcommands `events flip <svc> <color>`,
  `events status <svc>`), never by CFN or a deploy workflow.
- `saga-bluegreen status` prints HTTP live colour (from the rule weights) and events colour (from
  SSM) side by side and warns when they diverge for longer than the bake convention.
- `saga-bluegreen flip <svc> <color>` grows a `--plane http|events|all` flag. `all` applies the
  fixed ordering below. `retire` refuses if the colour being retired still owns the events plane.

### 2. Task-side gate (soa, one new small package)

`@saga-ed/soa-deploy-color` (or a module inside `event-envelope` if a package is too heavy):

- `getOwnColor()` — parse `deployment.identifier` out of `OTEL_RESOURCE_ATTRIBUTES`, exactly as
  `soa-health` does; returns `null` outside blue/green.
- `ActiveColorGate({ parameterName, pollIntervalMs = 10_000 })` — polls `ssm:GetParameter`;
  exposes `isActive(): boolean` and `on('change', active => …)`. Semantics: parameter absent or
  `getOwnColor()` null → always active (today's behaviour). SSM unreachable → keep last known
  value, log at warn, never flap to inactive on a transient failure.
- Task role needs `ssm:GetParameter` on that one path, added under the existing `IsBlueGreen`
  condition in each `service-template.yaml`. Dev/preview stacks get no env var and no gate.

### 3. Consumer (soa `event-consumer`)

- New opt `gate?: ActivityGate`. Queue assertion and bindings happen on every colour regardless
  (so the queue exists and is bound before the flip). `basic.consume` is issued only while
  `gate.isActive()`.
- New `pause()` / `resume()`: `pause` = `basic.cancel`, then await in-flight handlers; `resume` =
  `basic.consume` again on the same channel. The gate's `change` event drives these.
- Keep `consumerName` and `consumed_events` colour-blind.

### 4. Relay / producer (soa `event-outbox`, on top of the reference branch)

- Same `gate?` opt. `pursueLeadership()` runs only while active; on `change → inactive` the leader
  calls `releaseLeadership()`. Absent gate = current branch behaviour.
- Retention sweep and the S3 exporter (below) already hang off the leader, so they inherit it.
- Two hardening items to add to the reference branch while it is open:
  - **Stale-leader watchdog.** A leader whose relay loop is wedged but whose pg session is alive
    blocks everyone. After N consecutive failed ticks (or a `drainBatch` overrunning
    `txIdleTimeoutMs`), release leadership and re-pursue after a backoff.
  - `onLeaderWaiting` should carry the waiting task's colour so the dashboard can tell
    "dark colour idle by design" from "live colour cannot get the lock".

### 5. Ordering rule (this is the whole point)

**Flip: events first, then HTTP. Rollback: HTTP first, then events.**

The consuming colour must never be older than the producing colour. New code handles old event
versions (frozen-once-published); old code cannot handle new ones. `saga-bluegreen flip --plane
all` encodes this and waits for the outgoing colour's consumers to report paused (drain of
in-flight messages) before reweighting the ALB. The residual window is a rollback that returns
HTTP to the old colour while new-version messages are still queued; those land in the DLQ and
are replayed after the forward fix, using the existing DLQ replay path. Document it, do not
engineer around it.

### 6. S2S HTTP plane

No new mechanism. S2S stays *live-by-default* (no header → ALB live rule) with per-request
propagation of inbound `x-saga-preview-*`, which already makes dark smoke work end to end when the
smoke client sets the header. Two small additions:

- Allow `PREVIEW_ORIGINATE_MAP` to be sourced at runtime from
  `/prod/bluegreen/<service>/s2s-originate-map` (same poller as the gate) so an operator can pin a
  dark colour's *headless* outbound calls (consumers, cron) to a sibling's dark colour during a
  coordinated multi-service smoke, and clear it without a redeploy.
- `saga-bluegreen flip` refuses to make a colour live while its originate pin is non-empty. That
  turns the rule in `sandbox-preview-routing.md` ("never pin a prod service to a colour") into a
  guard instead of a reminder.

### 7. Archive → S3

Chain: `outbox_event` (7 d, sweeper) → `outbox_event_archive` (30–90 d) → S3 (years, lifecycle to
Glacier).

- `OutboxArchiveExporter` in `event-outbox`, ticked by the leader after the retention sweep.
  Selects `outbox_event_archive` rows older than `archiveDays` in `event_id`-ordered batches,
  writes one gzip JSONL object per batch at
  `s3://<bucket>/<service>/yyyy=/mm=/dd=/<first_event_id>.jsonl.gz`, and deletes exactly the
  `event_id`s it uploaded only after `PutObject` succeeds. Deterministic keys make a crash between
  upload and delete a harmless overwrite on retry.
- Bucket per environment, prefix per service; task role gets `s3:PutObject` on its prefix only.
  Add a Glue/Athena table over the prefix so replay is `SELECT … FROM outbox_archive WHERE …` →
  re-insert with `published_at = NULL`. Reuse the README's replay recipe and its
  `consumed_events` dedup caveat.
- Considered and rejected: RDS `aws_s3.query_export_to_s3` (RDS-only, no local parity, needs a DB
  IAM role), DMS/Firehose (overkill for tens of MB per day).

## Rollout order

1. **soa:** merge `fix/outbox-partial-index-retention` with the two hardening items in §4.
   Publish. Do **not** bump adopters yet.
2. **rostering:** merge `fix/outbox-partial-index`; run migrations; then bump event-outbox and
   wire `retention`. Index before bump, or the `'throw'` assert fails boot fleet-wide.
3. **program-hub:** author the same four migrations for programs-api, scheduling-api,
   sessions-api, content-api (raw SQL, `CONCURRENTLY`, one statement per file; Prisma model gets
   the `OutboxEventArchive` fragment and loses the `@@index`). Same index-before-bump order.
   Remember the repo rule: template defaults are prod values, dev overrides explicit.
4. **soa:** ship `soa-deploy-color`, consumer `gate`/`pause`/`resume`, relay gate.
5. **saga-bluegreen CLI:** `events status|flip`, `--plane`, retire/originate guards.
6. Adopt the gate one service at a time, starting with a consumer-only service (authz-api), then
   sessions-api (three consumers, one relay). Creating the SSM parameter is the switch; deleting it
   reverts to today's behaviour.
7. Archive exporter last; it changes nothing operator-facing.

## Open questions for review

1. SSM vs. a `deployment_control` row in each service's DB for the active-colour signal. SSM is
   proposed because the flip CLI already holds AWS credentials and no DB credentials; a DB row
   would make the gate transactional with the service's own writes but needs an admin endpoint.
2. Is a 10 s poll acceptable for the flip latency, or should the CLI also poke tasks (SSM
   parameter change → EventBridge → nothing today; a `SIGUSR2`-style refresh is possible via ECS
   `execute-command` but ugly)?
3. Do we want SAC on queues at all, given it requires draining and re-declaring every queue once?
4. Does iam-api's `DesiredCount: 3` need more than one consumer per queue in future? If so, SAC
   is off the table and the gate alone carries isolation.

# Current architecture — runtime APIs and point-to-point tRPC

Captures the **runtime** state of the rostering / program-hub / student-data-system
service mesh as of 2026-04-30, focused on what the soa_75 outbox-pattern
proof-of-concept needs to refactor. Fixture / snapshot machinery
(`seed-mode.ts`, `snapshot.registry.*`, `*-seed` packages,
`mesh-fixture-cli`, `fixture-deidentify`) is **out of scope** here — those
flows are documented separately in
`student-data-system/claude/projects/federated-fixture/research/`.

## Scope

In: tRPC routers actually exposed by each running API, the cross-service
HTTP calls that happen on the user request path, the existing event /
outbox pipeline, and the cross-DB foreign-reference shape that drives
those calls.

Out: anything fixture-mint, dev-environment seeding, or snapshot
lifecycle. Frontend apps (`apps/web/*`, saga-dash) are mentioned only as
top-of-call-graph consumers.

## Service inventory

| # | Service | Repo | Runtime | Database | Role |
|---|---|---|---|---|---|
| 1 | **iam-api** | rostering | Node tRPC | `iam_local` + `iam_pii_local` | Identity, organizations, groups, memberships, profiles |
| 2 | **programs-api** | program-hub | Node tRPC | `programs_local` | Tutoring programs, periods, enrollment, pods |
| 3 | **scheduling-api** | program-hub | Node tRPC | `scheduling_local` | Tutor availability schedules, calendar events |
| 4 | **ads-adm-api** | student-data-system | Node tRPC | `ads_adm_local` | Attendance read/write, attendance dashboards |
| 5 | **ledger-api** | student-data-system | Node tRPC | `ledger_local` | Assessments, surveys, ingestion, dashboards (already publishes events) |
| L | **saga_api** *(legacy)* | external (saga-edu) | Python | (saga monolith DBs) | Aggregator the modern Node services have not finished replacing — exposes `iam.*`, `pgm.*`, `ars.*` namespaces over a tRPC-shaped HTTP endpoint |

Plus three event-side Node apps in student-data-system (mentioned in §6):
`rabbitmq-bridge` (Lambda), `olap-ingestor` (Lambda), and the
`ledger-forms` / `sds-forms` web apps (UI consumers, not runtime peers).

## 1. tRPC router map per API

Procedures that participate in cross-service flows are flagged ⇄.
Procedures listed for iam-api with the snake_case "namespace" shape
(`iam.getOrgIdsByGroupIds`, etc.) live on the **legacy saga_api** —
they're listed there in §2, not here.

### iam-api (rostering)

`groups`, `users`, `profiles`, `auth`, `people`, `roles`, `events`,
`cacheAdmin`, `authAdmin`.

| Router | Responsibility | Cross-service procedures |
|---|---|---|
| `groups` | Org/school/section/period group hierarchy + memberships | ⇄ `createSubgroupWithMembers`, `addMembersToSubgroup`, `removeMembersFromSubgroup`, `deactivateGroup`, `getChildGroups`, `getChildGroupsBulk`, `getGroupMembers`, `getGroupMembersBulk`, `getChildren`, `getHierarchy` |
| `users` | User CRUD, search, cache-backed reads | (publisher of identity; not directly called cross-service today via the Node-to-Node path) |
| `profiles` | Display names, screen names, PII metadata | — |
| `people` | Person directory | ⇄ `resolvePersons` (called by programs-api enrollment) |
| `auth` | Auth and session | — |
| `roles` | Role definitions / permissions | — |
| `events`, `cacheAdmin`, `authAdmin` | Audit trail + ops | — |

### programs-api (program-hub)

`programs`, `periods`, `enrollment`, `pods`.

| Router | Responsibility | Notes |
|---|---|---|
| `programs` | Tutoring program CRUD, list-by-org, metadata | ProgramSchoolMapping holds an opaque `schoolGroupId` from iam-api |
| `periods` | Tutoring periods within programs, rotation/classroom data | — |
| `enrollment` | Map iam school/section groups to programs; manage period assignments; resolve users per section | Most-coupled router to iam-api. ProgramSectionMapping holds an opaque `sectionGroupId` |
| `pods` | Small tutor+students learning groups | Each Pod has an opaque `rosteringGroupId` pointing at the iam subgroup that mirrors its membership |

### scheduling-api (program-hub)

`schedules`, `calendarEvents`. **No outbound cross-service calls.**
Schedules are keyed by `programId` (string), but the service treats
that as opaque — does not call programs-api at runtime.

### ads-adm-api (student-data-system)

`adm`, `ads`.

| Router | Responsibility | Notes |
|---|---|---|
| `adm` | Attendance read + write | `getAttendanceByPrograms` is the lazy-creation read path that triggers the saga_api fan-out. `updateAttendanceBulk`, `setPeriodAttendanceStatus` are mutations that load policy first. |
| `ads` | Five read-only analytics queries (overview by period / tutor / grading period, attendance report) | All hydrate org trees from saga_api at query time |

### ledger-api (student-data-system)

`student`, `assessment`, `ingestion`, `dashboards`, `survey`. **No
outbound cross-service calls** — pure publisher today (events go out via
the outbox, not via tRPC). Holds opaque `studentRefId` pointing at its
own internal `StudentIdentityRef` table, not at iam-api directly.

## 2. Cross-service runtime communication (the tRPC topology)

```
                                     ┌──────────────────────┐
                                     │   saga_api (legacy)  │
                                     │   Python aggregator  │
                                     │   :5000              │
                                     │                      │
                                     │ Exposes namespaces:  │
                                     │   iam.*  pgm.*  ars.*│
                                     └──────────▲───────────┘
                                                │
                                                │ tRPC over HTTP, snake_case wire
                                                │ /saga_api/v1.0/trpc
                                                │
   ┌─────────────────┐                          │
   │  programs-api   │                          │
   │  (Node)         │                          │
   │                 │                          │
   │  pods.*         │ ─direct tRPC, camelCase─►│  iam-api (Node)
   │  enrollment.*   │  (IAM_API_URL)           │  groups.* people.*
   └─────────────────┘                 ┌────────┘
                                       │
                                       │
   ┌─────────────────┐                 │
   │  ads-adm-api    │ ────────────────┘ via saga_api:
   │  (Node)         │   • pgm.getPeriodMeetingsByProgram
   │  adm.*  ads.*   │   • iam.getOrgIdsByGroupIds
   │                 │   • iam.getOrganizationByOrgId
   │                 │   • iam.getOrgLevelPolicy
   │                 │   • ars.getDecoratedSessionCollates
   └─────────────────┘

   ┌─────────────────┐
   │  scheduling-api │   no outbound cross-service tRPC
   └─────────────────┘

   ┌─────────────────┐
   │  ledger-api     │   no outbound cross-service tRPC
   │                 │   (publishes events instead — see §6)
   └─────────────────┘
```

Two distinct integration styles coexist today:

### A. Direct Node→Node tRPC — programs-api → iam-api

Modern microservice-style: programs-api imports iam-api's `appRouter`
type and constructs a typed client. Calls are camelCase end to end.

- **Client class:** `TrpcRosteringClient` —
  `program-hub/packages/node/rostering-client/src/trpc-client.ts:55-65`
  (constructor takes `baseUrl`, builds a `createTRPCClient` over
  `${baseUrl}/trpc` with superjson).
- **Inversify wiring:**
  `program-hub/apps/node/programs-api/src/inversify.config.ts:39-41`
  — reads `IAM_API_URL`, throws on missing, binds `RosteringClient` as
  a constant value.
- **Imports the iam-api router type** for end-to-end type safety
  (`rostering-client/src/iam-router-type.ts`).

Procedures called (exhaustive at `programs-api/src/services/`):

| From | To | Procedure | Trigger |
|---|---|---|---|
| `pods.service.create()` | `iam-api groups.createSubgroupWithMembers` | mutation | A new pod creates a child group under its period and seeds initial members |
| `pods.service.update()` / `addMembers()` / `removeMembers()` | `iam-api groups.addMembersToSubgroup`, `removeMembersFromSubgroup` | mutation | Pod membership edits |
| `pods.service.delete()` | `iam-api groups.deactivateGroup` | mutation | Pod deletion cascades to its iam group |
| `enrollment.service.setPeriodAssignments()` | `iam-api groups.createSubgroupWithMembers`, `addMembersToSubgroup`, `removeMembersFromSubgroup`, `deactivateGroup` | mutation | Inclusion / exclusion subgroups for period assignments are managed inline |
| `enrollment.service` (read paths) | `iam-api groups.getChildGroups`, `getChildGroupsBulk`, `getGroupMembers`, `getGroupMembersBulk`, `getChildren`, `getHierarchy` | query | Enumerate schools / sections / members when rendering enrollment |
| `enrollment.service.resolveUsersForSection()` | `iam-api people.resolvePersons` | query | Resolve display names / screen names alongside member lists |

All calls are **synchronous and on the user's request path.** Pod
creation in programs-api blocks on the iam-api round-trip; if iam-api is
slow or down, the mutation hangs until timeout. There's a single
graceful-fallback at `pods.service.ts:54` that warns-and-continues if
the subgroup creation fails — every other call propagates the error.

### B. Indirect via legacy aggregator — ads-adm-api → saga_api

ads-adm-api does **not** call iam-api or programs-api directly. It calls
a legacy Python aggregator (saga_api) that re-exposes those services'
data under three flat namespaces (`iam.*`, `pgm.*`, `ars.*`) at
`/saga_api/v1.0/trpc`, with snake_case wire fields (`group_id`,
`org_id`, `user_id`, `include_unassigned_users`). The fact that iam-api
and programs-api also exist as standalone Node services hasn't yet
propagated to ads-adm-api.

- **Client class:** `SagaApiClient` —
  `student-data-system/apps/node/ads-adm-api/src/clients/saga-api.client.ts:195-275`.
  URL constructed at line 207, default 30s timeout, `superjson`
  transformer, no auth header (relies on network boundary).
- **Configured via** `SAGA_API_CLIENT_BASEURL` env (default
  `http://localhost:5000`).
- **Wire schemas are validated locally** with Zod —
  `WirePeriodMeetingSchema`, `WireOrgIdMappingSchema`,
  `WireOrganizationSchema`, etc. — because there's no shared TypeScript
  router type from the Python side.

Provider-level call sites (each provider injects `SagaApiClient`):

| Provider | Used by | saga_api procedures |
|---|---|---|
| `SagaApiProgramScheduleProvider` | `adm.getAttendanceByPrograms` (lazy-create read) | `pgm.getPeriodMeetingsByProgram`, `iam.getOrgIdsByGroupIds`, `iam.getOrganizationByOrgId` |
| `SagaApiAttendancePolicyProvider` | `adm.updateAttendanceBulk`, `adm.setPeriodAttendanceStatus` (mutations) | `iam.getOrgIdsByGroupIds`, `iam.getOrgLevelPolicy` |
| `SagaApiReportDataProvider` | All five `ads.*` analytics queries | `iam.getOrganizationByOrgId` |
| `SagaApiSessionDataProvider` | Attendance collator (during `getAttendanceByPrograms`) | `ars.getDecoratedSessionCollates` |

All calls are **synchronous and on the user's request path.** Every
attendance read and every analytics query fans out to saga_api before
returning. There is no cache layer between ads-adm-api and saga_api in
the request path; the round-trip cost is paid every call.

## 3. Sync vs async — what blocks user requests today

Every cross-service call documented in §2 is on the user request path
inside a tRPC handler. There are **no background workers** or
**async inboxes** receiving cross-service mutations today. If iam-api
or saga_api degrades:

- programs-api `pods.create` and `enrollment.setPeriodAssignments` time
  out → user-visible failure.
- ads-adm-api `adm.getAttendanceByPrograms`, `updateAttendanceBulk`,
  `setPeriodAttendanceStatus`, and all five `ads.*` queries time out →
  user-visible failure.

The only async machinery in the runtime is the **ledger-api → RabbitMQ
→ SQS → S3** analytics pipeline (§6), and it touches no other service's
state.

## 4. Mutating cross-service intents (Seth's hard case)

These are the points where service A's mutation handler synchronously
triggers a state-changing call into service B. They are the cases where
event-driven projections alone (read-side replication) don't help —
they require either domain re-homing (move ownership) or a saga-style
coordination pattern.

| Caller | Callee | Trigger | Effect on callee | Failure mode |
|---|---|---|---|---|
| programs-api `pods.create` | iam-api `groups.createSubgroupWithMembers` | tRPC mutation | New group row + initial memberships in iam_local | Graceful: warn-log, pod row persists without `rosteringGroupId` (`pods.service.ts:54`). Subsequent membership edits will then fail to find the group. |
| programs-api `pods.update` / `addMembers` / `removeMembers` / `delete` | iam-api `groups.addMembersToSubgroup`, `removeMembersFromSubgroup`, `deactivateGroup` | tRPC mutation | Membership / lifecycle changes in iam_local | Errors propagate; partial success possible if multiple membership edits in one pod operation |
| programs-api `enrollment.setPeriodAssignments` | iam-api `groups.createSubgroupWithMembers`, `addMembersToSubgroup`, `removeMembersFromSubgroup`, `deactivateGroup` (multiple per call) | tRPC mutation | Inclusion / exclusion subgroups created, modified, deactivated in iam_local | Errors propagate; no transactional boundary — partial group-edit state is possible if a later call in the sequence fails |

ads-adm-api has **no mutating cross-service intents**: its calls into
saga_api are reads. ledger-api and scheduling-api have no outbound
mutations.

So the mutating-intent surface is entirely **programs-api → iam-api**,
concentrated on `pods` and `enrollment`. Both flows manage iam-api
groups whose existence is driven by programs-api's domain (a Pod, a
period assignment) — Seth's "Pod owns its membership locally; iam-api
stops having a Pod-shaped Group at all" framing maps directly onto this
surface.

## 5. Database layout and cross-DB foreign references

Each service owns a private Postgres database. Cross-domain references
are stored as **opaque text UUIDs** — never as Postgres foreign keys —
and are resolved at runtime via the tRPC calls in §2.

| Service | Database | Cross-DB foreign refs (text columns, no FK) |
|---|---|---|
| iam-api | `iam_local` (+ `iam_pii_local` for PII split) | None |
| programs-api | `programs_local` | `ProgramSchoolMapping.schoolGroupId` → iam group; `ProgramSectionMapping.sectionGroupId` → iam group; `Pod.rosteringGroupId` → iam subgroup |
| scheduling-api | `scheduling_local` | `programId` (text, opaque) → programs-api program |
| ads-adm-api | `ads_adm_local` | `AdmAttendance.iamUserId`, `programId`, `periodId`, `tutorId` — all text, sourced from saga_api responses |
| ledger-api | `ledger_local` | `studentRefId` → an internal `StudentIdentityRef` table (not a cross-DB ref) |

**No service holds a projection of another service's data.** Every
read of cross-domain state is a live tRPC call to the owner. This is
the property the outbox / projection refactor would change — consumers
would gain `iam_*_ref` / `pgm_*_ref` tables that they could read from
locally.

## 6. Existing event / outbox infrastructure (ledger-api only)

ledger-api is the only service that already runs an outbox publisher.
The pipeline below moves events to S3 for analytics — it does **not**
yet feed any other Node service's runtime state. Worth capturing
because it's the pattern the soa_75 POC will likely generalize.

### Outbox table — `ledger_local.outbox_event`

`student-data-system/packages/node/ledger-db/src/prisma/schema.prisma:217-232`

```prisma
model OutboxEvent {
  eventId       String    @id
  aggregateType String   // e.g. "assessment", "submission"
  aggregateId   String   // UUID of the aggregate
  eventType     String   // e.g. "submission.recorded", "submission.corrected"
  eventVersion  Int       @default(1)
  payload       Json
  occurredAt    DateTime
  claimedAt     DateTime?
  publishedAt   DateTime?
  attempts      Int       @default(0)
  lastError     String?
  @@map("outbox_event")
}
```

Envelope shape: `(eventType, aggregateType, aggregateId, eventVersion,
payload, occurredAt)`. `eventVersion` + semantic event names give
versioned-consumer support; `claimedAt` / `publishedAt` / `attempts` /
`lastError` are the publisher's bookkeeping.

### Publisher — `OutboxPublisher`

`student-data-system/apps/node/ledger-api/src/queue/outbox-publisher.ts`

- Polls `outbox_event` (default 500 ms interval, batch of 100).
- Postgres advisory lock (`pg_try_advisory_xact_lock`) elects a single
  publisher per cluster.
- Publishes to RabbitMQ exchange `ledger.events` (topic, durable),
  routing key = `eventType`.
- Only acks the row (sets `publishedAt`) after RabbitMQ confirms.
- Started from `main.ts` on boot, graceful stop on shutdown.

### Bridge — `rabbitmq-bridge` (Lambda)

`student-data-system/apps/node/rabbitmq-bridge/src/handler.ts`

- EventBridge Scheduler 1-minute rate.
- Drains RabbitMQ queue `ledger.events.olap` (bound to
  `ledger.events` with routing key `#`).
- Wraps each message in `{ eventType, occurredAt, payload }` and batches
  into SQS, dedupe-keyed on `messageId = eventId`.
- Acks RabbitMQ only after SQS send succeeds.

### Consumer — `olap-ingestor` (Lambda)

`student-data-system/apps/node/olap-ingestor/src/handler.ts`

- SQS-triggered.
- Validates payload against the Zod registry in
  `@saga-ed/ledger-schema`.
- Writes gzipped JSONL to S3 partitioned as
  `s3://bucket/raw/event_type=<...>/dt=<YYYY-MM-DD>/hh=<HH>/...`.
- Quarantines unparseable messages to `s3://bucket/quarantine/`
  (no retry — poison-pill protection).

### Why this matters for soa_75

The outbox publisher, the envelope shape, and the idempotency /
DLQ-style discipline already exist in ledger-api in working form. Seth's
six-item program in `student-data-system/claude/projects/federated-fixture/sources/prompt-2.md`
proposes extracting them as shared infra and applying the pattern to
iam-api and programs-api. None of iam-api / programs-api / ads-adm-api
has an outbox table, an event publisher, or a consumed-events
idempotency table today.

## Pain-point summary (what soa_75 is here to address)

1. **Mutating cross-service intents on the request path** —
   programs-api `pods.*` and `enrollment.setPeriodAssignments` block on
   iam-api. Failures partway through a multi-call sequence leave
   inconsistent state; there is no transactional boundary across
   service hops.
2. **Read-side fan-out** — ads-adm-api's attendance reads each fan out
   3-5 saga_api calls. No projection / cache; every read pays the
   cross-service cost.
3. **Two integration styles in parallel** — direct Node↔Node typed
   tRPC (programs-api → iam-api) coexists with the legacy snake-cased
   saga_api gateway (ads-adm-api → saga_api). Any refactor needs an
   answer for both, including whether ads-adm-api should be moved off
   saga_api as part of the same effort or whether saga_api itself
   becomes an event-source.
4. **No projection tables anywhere** — every cross-domain reference is
   resolved live. Consumer-side `iam_*_ref` / `pgm_*_ref` projection
   tables (per Seth's #5) do not exist in any consumer DB.
5. **Outbox infra is real but isolated** — ledger-api already runs a
   working outbox → RabbitMQ → SQS → S3 pipeline, but it serves
   analytics only. iam-api and programs-api do not publish events.

## File reference

Direct tRPC topology:
- `program-hub/packages/node/rostering-client/src/trpc-client.ts:55-65`
- `program-hub/packages/node/rostering-client/src/iam-router-type.ts`
- `program-hub/apps/node/programs-api/src/inversify.config.ts:39-41`
- `program-hub/apps/node/programs-api/src/services/pods.service.ts` (mutation call sites: 45, 54, 134, 160, 184, 202, 231, 255)
- `program-hub/apps/node/programs-api/src/services/enrollment.service.ts` (mutation + read call sites: 55, 59, 84, 209, 212, 280, 283, 345, 348, 381, 385, 396, 410, 413, 427, 440, 443, 449, 654, 660, 663, 672)

Legacy aggregator topology:
- `student-data-system/apps/node/ads-adm-api/src/clients/saga-api.client.ts:195-275`
- `student-data-system/apps/node/ads-adm-api/src/sectors/adm/providers/impls/saga-api-program-schedule-provider.ts`
- (and sibling `saga-api-attendance-policy-provider.ts`,
  `saga-api-report-data-provider.ts`, `saga-api-session-data-provider.ts`)

Existing outbox pipeline:
- `student-data-system/packages/node/ledger-db/src/prisma/schema.prisma:217-232`
- `student-data-system/apps/node/ledger-api/src/queue/outbox-publisher.ts`
- `student-data-system/apps/node/rabbitmq-bridge/src/handler.ts`
- `student-data-system/apps/node/olap-ingestor/src/handler.ts`

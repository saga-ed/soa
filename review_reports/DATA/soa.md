# SOA — Data & Compliance Pre-Launch Review

**Repo:** `/home/user/soa` (saga-soa shared infrastructure)
**Scope:** Data & FERPA-safety of shared primitives (logger, fixture-deidentify, event stack, db/postgres, preview-headers, seed/fixtures)
**Mode:** Read-only. Only write is this file.
**Date:** 2026-07-12

## Summary

soa holds no student database, but it ships the logging, de-identification, event, and DB
primitives every downstream FERPA-handling repo (student-data-system, rostering/iam) relies on.
The primitives are, on the whole, sound and thoughtfully built: the logger carries a real
fleet-wide PII redaction list with documented pino limitations; the fixture de-identifier is
deterministic and versioned; the event consumer has a bounded dedup-table retention sweep; the
Postgres/Mongo providers are pure connection managers that introduce **no** hard-delete default.
The material data risks are all of one shape — **allow/deny lists that are safe for what they
enumerate but silent on what they omit**: the fixture de-identifier only scrubs an enumerated set
of collections+fields (notably never `dob`, and passes unknown collections through untouched), and
the logger redaction list omits several common FERPA direct identifiers (`studentId`, `ssn`,
`phone`, `address`). Neither is a live leak in soa itself, but both make it easy for a downstream
repo to leak by omission. No real PII was found baked into repo fixtures/seed data.

## Severity counts

| Severity | Count |
|----------|-------|
| S1 | 0 |
| S2 | 1 |
| S3 | 2 |
| S4 | 1 |
| **Total** | **4** |

---

## Findings

### [DATA-1] fixture-deidentify scrubs an allowlist of collections+fields; unknown collections and unlisted PII fields (incl. `dob`) pass through raw — Severity S2, Confidence M

- **Location:** `packages/core/fixture-deidentify/src/mongo-deidentifier.ts:23-37` (collection switch), `:65-77` (field allowlist)
- **Claim:** De-identification is opt-in per collection and per field. Any collection not named in the `switch` is silently skipped, and within handled collections only an enumerated field list is replaced — so any other PII field (most notably date of birth) survives into the fixture/snapshot that downstream repos consume.
- **Evidence:**
  - Collection switch defaults to no-op:
    ```
    switch (coll.collection) {
      case 'iam_user_profiles': ...
      case 'iam_orgs': ...
      case 'saga_learn_sessions': ...
      default:
        break;   // any other collection shipped verbatim
    }
    ```
  - Field-level allowlist (nothing else on the doc is touched):
    ```
    if ('screen_name' in doc) doc['screen_name'] = identity.screen_name;
    if ('email' in doc) doc['email'] = identity.email;
    if ('first_name' in doc) ...
    if ('last_name' in doc) ...
    if ('username' in doc) ...
    if ('display_name' in doc) ...
    ```
  - `DEIDENTIFIED_MONGO_COLLECTIONS` (`:160`) is exactly three collections. There is **no `dob`/date-of-birth handling anywhere** in the module, even though the sibling logger explicitly flags DOB as FERPA (`packages/node/logger/src/pino-logger.ts:44`).
- **Impact:** A prod-mirror extraction that grows a new PII-bearing collection, or a new PII column (`dob`, `phone` at top level, `address`, guardian contact outside the one `user_provided_metadata` key handled at `:97`) on an already-handled collection, is de-identified to a partial degree only — the new field ships real. Because this is the shared scrubber that gates prod-mirror → fixture/snapshot flows across the fleet, a silent omission here is a multi-repo FERPA exposure. The module's own header comment scopes it to a point-in-time D3.6 Phase A spike ("real PII lives in `iam_user_profiles.screen_name`"), which is exactly the kind of assumption that drifts.
- **Suggested action:** (a) Add explicit `dob`/date-of-birth handling to `transformIamUserProfiles`. (b) Make an unknown collection in `DEIDENTIFIED_MONGO_COLLECTIONS`-eligible payloads *fail loud* (or route through a deny-by-default scrub) rather than `default: break`, so a newly-added collection cannot ship un-scrubbed unnoticed. (c) Keep/extend the leakage grep referenced in `fake-names.ts:10-13` and run it in CI against a fresh extraction so field drift is caught.

### [DATA-2] Logger PII redaction deny-list omits common FERPA direct identifiers (`studentId`, `ssn`, `phone`, `address`) — Severity S3, Confidence M

- **Location:** `packages/node/logger/src/pino-logger.ts:30-62` (`REDACT_PATHS`)
- **Claim:** The fleet-wide structured-log redaction list is a curated deny-list. It covers email, names, `dob`, and secrets/tokens, and blunt-redacts request objects (`input`/`payload`/`body`) wholesale — but it does not list several PII fields a downstream service is likely to log as top-level structured keys.
- **Evidence:** The list contains `email`, `name`, `firstName`/`lastName`(+`Norm`), `dob`, `password`/`token`/`accessToken`/`refreshToken`/`clientSecret`/`otp`/`authCode`, and wholesale `input`/`payload`/`body`. It does **not** contain `studentId`/`student_id`, `ssn`, `phone`/`phoneNumber`, `address`, or `ip`. A downstream `logger.info('lookup', { studentId })` (a FERPA direct identifier) is emitted in clear. The header comment also correctly documents that interpolated message strings are never redacted (`:15-18`) — ``logger.info(`user ${email}`)`` leaks by design.
- **Impact:** Defense-in-depth is partial. The wholesale `input`/`payload`/`body` redaction catches tRPC/Express request bodies, which is the common leak path, so exposure is limited to hand-built structured field bags — but a student ID logged as a discrete field reaches CloudWatch/Datadog un-redacted across every service using the shared logger.
- **Suggested action:** Add `studentId`/`student_id` (+ `*.` variants), `ssn`, `phone`/`phoneNumber`, `address` to `REDACT_PATHS`. Keep the enumerate-the-shapes approach (top-level + `*.` + `err.`) to avoid pino's ancestor/descendant overlap throw documented at `:20-25`. Optionally lint against string interpolation of known-PII vars at call sites.

### [DATA-3] Event envelope carries unclassified payloads across service boundaries; `outbox_event` rows are never purged after publish — Severity S3, Confidence M

- **Location:** `packages/node/event-envelope/src/index.ts:36` (`payload: z.record(z.string(), z.unknown())`); `packages/node/event-outbox/src/relay.ts:290-294` (marks `published_at`, no delete); `packages/node/event-outbox/src/schema.ts:11-30` (table DDL, no TTL); contrast `packages/node/event-consumer/src/consumed-events-retention.ts` (dedup table IS swept)
- **Claim:** The cross-service envelope has no payload classification or redaction layer — publishers put whatever they want in `payload`, and it crosses RabbitMQ and is persisted as `jsonb`. Published outbox rows are marked, not deleted, and there is no retention sweep for `outbox_event` (grep for `DELETE FROM outbox_event`/`purge`/`retention` in the package returns nothing), so any PII in an event payload accumulates indefinitely in each service's Postgres.
- **Evidence:** Relay only sets `published_at`:
  ```
  UPDATE outbox_event SET published_at = NOW() WHERE event_id = ANY($1::uuid[])
  ```
  The only retention primitive in the event stack targets the *dedup* table (`consumed_events`), not the outbox; there is no analogous `OutboxRetention`. The envelope's `payload` is fully open (`z.unknown()`), with no PII/classification field on the envelope meta (`EventEnvelopeMetaSchema`, `:11-22`).
- **Impact:** Payload content governance is entirely delegated downstream — reasonable as a design choice, but there is no shared guardrail (classification tag, size cap, redaction hook) preventing a service from putting student PII into a durable, broadcast, indefinitely-retained event. The retention asymmetry (dedup swept, outbox not) means PII payloads have no shared expiry story.
- **Suggested action:** Consider (a) an optional envelope `dataClassification` meta field + a documented "no raw PII in payloads" contract, and (b) a shared `OutboxRetention` sweep mirroring `ConsumedEventsRetention` so published rows don't retain PII forever. At minimum document the retention gap in `claude/event-driven.md` so each consuming repo owns a purge.

### [DATA-4] Postgres/Mongo providers introduce no hard-delete default; soft-delete convention is correctly left to downstream schemas — Severity S4 (informational / sound), Confidence H

- **Location:** `packages/node/postgres/src/postgres-provider.ts` (whole file); `packages/node/db/src/sql.ts:1` (`export {}` placeholder); `packages/node/db/CLAUDE.md`
- **Claim:** The shared DB adapters are pure connection/pool managers (ORM-agnostic `pg.Pool` / `MongoClient`). They expose no query, delete, or CRUD abstraction, so soa neither makes hard-delete "easy/default" nor can it violate the fleet "soft-delete everywhere" convention — that invariant lives in downstream Prisma schemas, as intended. Cross-database join prevention is likewise structural: each provider manages one logical DB/pool.
- **Evidence:** `PostgresProvider` surface is `connect`/`disconnect`/`isConnected`/`getPool`; no delete/query helpers. `db/src/sql.ts` (MySQL) and `redis.ts` are placeholders. No convenience delete method exists to default the wrong way.
- **Impact:** None — this is the safe design. Noted so the audit explicitly records that the "hard-delete easy by default?" concern is **N/A for soa**.
- **Suggested action:** None. Keep delete/soft-delete policy owned by downstream schema packages.

---

## Areas reviewed

- **logger** (`packages/node/logger/`) — redaction list, pino construction paths, trace/deployment mixins. Redaction present and shared across both construction paths (`redact` exported `:65`); gap is list coverage (DATA-2).
- **fixture-deidentify** (`packages/core/fixture-deidentify/`) — deidentifier walk, deterministic identity map (sha1, versioned prefix, no RNG/Date), fake-name pools screened against real fixture names. Allowlist gaps (DATA-1).
- **event stack** — `event-envelope` (schema, trace hygiene, W3C refine), `event-outbox` (write/relay/schema, SKIP LOCKED claim, fatal-error halt), `event-consumer` retention. Payload classification + outbox retention gap (DATA-3).
- **db / postgres** — connection managers, pool safety guards (gh-186 idle-in-tx timeout, keepAlive, self-heal). No delete abstraction (DATA-4).
- **preview-headers** — `store`/`forward`/`header-keys`/`originate-map`. Only forwards `x-saga-preview-*` string headers (`extractPreviewHeaders` filters to prefix, skips array values); caller auth headers take precedence over preview headers (`withPreviewHeaders`, `forward.ts:22-26`). No PII carried. Sound.
- **seed / fixtures** — searched packages/apps for real-looking emails in seed/fixture/snapshot files. Only synthetic values found (`user_*@fixture.test` generated identities; canonical `dev@saga.org` dev user in `saga-stack-cli/src/core/seed/profiles.ts`). No real PII baked into the repo.

## Areas NOT reviewed

- Downstream repos' actual use of these primitives (whether student-data-system/rostering supply complete redaction lists, scrub all collections, or honor soft-delete) — out of scope; this review is soa's primitives only.
- The AWS loaders' secret handling (`aws-postgres-loader.ts`, `aws-mongo-loader.ts`) beyond confirming they source credentials from SSM/Secrets Manager — a secrets-focused review, not data/FERPA.
- `pubsub-*` real-time push family (not in the data-plane scope list).
- Runtime/integration behavior — this was a static read-only review; no tests executed.

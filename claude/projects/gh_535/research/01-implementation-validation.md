# I#535 implementation measurements — 2026-10-22

The worktree baseline is SOA `10924a216c0ab6f2371de8ddb0cbc2f9aca2993a` plus the epic/child project scaffolds. This record explains implementation choices and local evidence; GitHub owns delivery state.

## Boundaries observed in the source

The relay uses a non-confirm AMQP channel. Its successful publish hook runs before the outbox transaction commits. Therefore `publishAccepted` remains counted when the later outbox commit fails and `publishConfirmed` remains null. Consumer `onProcessed` historically includes duplicates, so new observations distinguish delivery, committed new work, committed duplicate skips and client settlement outcomes. Existing metrics continue to receive their original calls. Event callback exceptions/rejections are isolated so they cannot turn committed work into retry/requeue behavior; one warning per instance bounds callback-error logging.

Existing activity gates, reconnect logic, advisory-lock leadership and retention behavior remain in place. A gate unit-test fixture previously omitted all AMQP delivery fields; it now supplies the fields required by the observation boundary.

Reporters use an isolated caller-owned reporting connection, existing publisher exchange and separate owned channels. They do not write reports to the business outbox. Sequence increments per snapshot attempt; missing sequence values are expected after coalescing/errors, and cumulative counters bridge missing reports. Publish failures carry fixed transport/backpressure categories; processing failures carry fixed envelope/unsupported/schema/database/handler/commit categories. No raw errors or business payloads enter reports.

## Verification

Local runtime: Node 24.12.0, pnpm 9.15.3, Docker 29.9.1.

- Event-consumer: 131 unit tests pass, including observer boundaries and all existing gate/recovery tests.
- Event-outbox: 91 unit tests pass, including accepted publish followed by failed outbox commit.
- Event-stats: 21 unit tests pass, including frozen JSON schema, receiver comparisons, cardinality, idle/unknown distinction, epochs, monotonic time, timeout/coalescing, shutdown/restart, backoff/recovery and transport channel cleanup.
- All three package type checks pass; dependency builds and event-stats ESLint pass. Changed event-library source and observation tests also pass ESLint. New TypeScript files pass Prettier.
- A frozen offline filtered install passes with only the new package importer added to the lockfile; existing locked versions are preserved.
- Real integration: isolated Postgres 17 and RabbitMQ 3.13 testcontainers; one relay, two named consumers with independent queues. Each observes three deliveries: one commit, one duplicate, one failed handler/nack. Database has two projection rows and two consumed-event rows; each DLQ has one message. Three separately transported report identities reconcile with that evidence. Closing the reporting connection leaves business state intact; reconnecting publishes cumulative state, and the reference receiver advances its baseline across the missing report.

The local testcontainers dependency initially segfaulted importing optional SSH native crypto (`sshcrypto.node`), before any test ran. A local preload makes its optional native load throw, allowing ssh2's existing JavaScript fallback; the integration test passes with that fallback. This does not stub RabbitMQ, Postgres or business transport. No workaround is installed in repository code or CI. The exact local preload and verification output are captured in `sources/validation-2026-10-22.txt`.

The existing package CI only schedules layers 0–3; event-stats resolves to layer 4. A focused job runs its builds, type checks, unit tests and real integration test, retaining the workflow's existing Node 22 setting. Remote CI results must be assessed on the PR; local Node 24 success is not a claim about remote CI.

## Release/adoption boundaries

The package README is the durable integration contract. Event-consumer 0.2.0 and event-outbox 0.3.0 must be published before event-stats 0.1.0 through the existing single-package workflow. No package has been published and no service/cloud deployment performed.

I#537 owns service wiring and wildcard-binding audits; I#538 owns contract pins, receiver persistence, retired-epoch rejection, expiry/freshness and Vishnu UI. The pure comparison helper is a receiver calculation example, not a durable ingestion service. The demonstration uses disposable testcontainers rather than the complete `gh536` synthetic stack. Latency histograms, queue-depth gauges and transaction-safe event creation counts are not available from these hooks and are not fabricated. In-memory counters lose their unreported tail on abrupt termination.

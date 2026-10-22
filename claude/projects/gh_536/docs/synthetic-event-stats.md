# I#536 — synthetic event telemetry runbook

Infrastructure implementation for [I#536](https://github.com/saga-ed/soa/issues/536),
[I#535](https://github.com/saga-ed/soa/issues/535),
[I#537](https://github.com/saga-ed/soa/issues/537), and the ingestion portion of
[I#538](https://github.com/saga-ed/soa/issues/538). Statistics UX remains deferred.

## Prepared environment

Set `gh536` owns slot 3. Primary checkouts and slot 0 were not modified.

| Repo | Worktree / branch |
| --- | --- |
| SOA | `/home/skelly/dev/worktrees/soa-gh_536-event-telemetry` / `gh_536-event-telemetry` |
| Rostering | `/home/skelly/dev/worktrees/rostering-gh_537-event-stats-adoption` / `gh_537-event-stats-adoption` |
| Program hub | `/home/skelly/dev/worktrees/program-hub-gh_537-event-stats-adoption` / `gh_537-event-stats-adoption` |

Vishnu: <http://127.0.0.1:11930>. Reports: <http://127.0.0.1:11930/api/event-stats>.
The current graph retains its existing health/topology presentation; the new
statistics API is available for the next UX iteration.

From the SOA worktree (use this built CLI, not a global CLI from another checkout):

```sh
pnpm --filter @saga-ed/soa-event-stats... --filter @saga-ed/saga-stack-cli... -r build
CHOKIDAR_USEPOLLING=1 CHOKIDAR_INTERVAL=1000 SS_ACTOR=gh536 \
  node packages/node/saga-stack-cli/bin/run.js stack up --set gh536 \
  --only iam-api,programs-api,scheduling-api,vishnu \
  --no-auto-pull --no-seed --skip-prep
node apps/web/vishnu/scripts/check-event-stats.mjs 3
```

`--skip-prep` is appropriate for these already installed/built worktrees. No reset
or seed is necessary. Normal service startup can process existing outbox work and
run its normal reconciliation tasks. The script refuses slot 0 and validates the
live API's slot and complete telemetry scope before writing.

It inserts two unique synthetic `programs.program.created` outbox rows, waits for
the first projection, replays that envelope once, and causes one real scheduling
handler SQL failure through a temporary trigger restricted to the second random
program UUID. The trigger/function are removed in `finally`. The successful
projection, two outbox rows, dedupe rows and failed DLQ message remain as evidence.
Use an otherwise quiet slot: concurrent same-event-type traffic or service restart
causes the exact counter assertions to fail rather than producing a false pass.
After restarting producers, wait 90 seconds for old instances to become stale.

Expected deltas:

| Participant | Expected |
| --- | --- |
| Programs relay | 2 attempts, 2 accepted; confirmations unavailable (`null`) |
| Programs program-group consumer | 3 deliveries, 2 commits, 1 duplicate, 3 ack attempts |
| Scheduling programs-projection consumer | 3 deliveries, 1 commit, 1 duplicate, 1 handler failure, 2 ack attempts, 1 nack attempt |

The script reconciles the published outbox rows, scheduling dedupe records and
successful/failed projection rows. Captured successful output:
[2026-10-22 evidence](../sources/synthetic-event-stats-2026-10-22.json).

## Recreate the local package overlay

The three new package versions are not published. Builds use only these local
links: `soa-event-stats`, `soa-event-consumer`, `soa-event-outbox`. Keep existing
service envelope pins: the fleet currently uses Zod 3 while SOA uses Zod 4; the
consumer boundary accepts a structural single-argument parser and the unchanged
wire envelope. Do not enable an all-package SOA link as a substitute.

```sh
node claude/projects/gh_536/scripts/link-adopters.mjs \
  /path/to/rostering-gh_537-event-stats-adoption \
  /path/to/program-hub-gh_537-event-stats-adoption
```

Run `pnpm install --no-frozen-lockfile` in each adopter, then generate its Prisma
clients with slot-local DB variables and build the IAM/programs/scheduling service
closures. The local root `package.json` overrides and generated `pnpm-lock.yaml`
are intentionally not committed. Original local-overlay inputs are backed up at
`/home/skelly/.codex/backups/gh537-local-links/` on this machine.

Release gate: publish the shared dependencies/packages in SOA dependency order,
then remove only these three local overrides, regenerate adopter registry
lockfiles and run frozen installs/CI before merging adopter PRs. Exact candidate
pins are stats `0.1.0`, consumer `0.2.0`, outbox `0.3.0`. No registry publish,
cloud deployment or main-branch merge was performed by this implementation.

## Coverage and boundaries

All OutboxRelay instances and EventConsumer subscriptions in the three selected
services are wrapped. IAM is producer-only; programs and scheduling are
producer/consumer. Programs has eight subscriptions, scheduling one. Publishers
use their existing service exchanges and `observability.event_stats.reported`.
The selected subscriptions bind business namespaces/exact keys, not `#`; these
reports cannot enter those business handlers. Other fleet services are not yet
instrumented, and their bindings must be audited before broader rollout.

Ad hoc scripts/direct AMQP publications bypassing these shared helpers are outside
coverage (the duplicate in this test deliberately demonstrates that boundary).
Idle registered consumer streams report zero; unsupported producer confirmation
is null. No counts imply end-to-end exactly-once delivery. Reporting owns separate
short-lived AMQP resources, excludes observability traffic, drops failed reports
without an offline backlog, and recovers from cumulative counters next heartbeat.

Vishnu stores per-instance cumulative reports and monotonic deltas with epoch
protection. It exposes declared service mappings and explicitly unverified stream
topology; it does not fabricate graph-edge rates. The receiver is synthetic/local
only. See [its README](../../../../apps/web/vishnu/README.md) for bounds and trust.

## Validation record (2026-10-22)

- Shared event packages: 246 unit tests; type checks and stats lint passed.
- Real PostgreSQL/RabbitMQ tests: shared fan-out/duplicate/failure/outage pipeline
  and five Vishnu persistence/ingestion cases passed.
- CLI: 1,885 tests passed across the full run and the corrected launch-env suite
  rerun (14 existing TODOs). The first run exposed three expected-env fixtures
  needing the new telemetry/PII variables; the 36-test affected suite then passed.
- Vishnu: 19 unit tests, types, production build and browser checks passed.
- Programs: 1,349 tests; scheduling: 398 tests; both type checks passed.
- IAM: type check passed; full service suite passed 3,643 tests and exposed one
  outdated integration test invoking private relay tick without leadership.
  After using public start and polling for the exact event ID, that test passed.
- All three adopter service closures built successfully. Rostering-wide
  `pnpm check` could not complete: its native build tooling crashed (SIGSEGV,
  then SIGBUS on retry). This broad check remains a release gate; it is not
  reported as green. Local Testcontainers runs used the optional SSH native-addon
  fallback because the host's cached addon crashed under Node 24.
- SOA targeted frozen install and changed-doc validation passed.
- The repeatable slot-3 scenario reconciled real DB records and reported counters.
  Old process identities remain visible as stale following watcher restarts; they
  are not combined with current-epoch rates.

Review covered hook boundaries, exception isolation, scope filtering, SQL
parameterization, bounded storage, server-only credentials, lifecycle shutdown,
and unrelated-worktree isolation. Claude-only review commands were not available;
these checks and the concrete tests provide the review evidence for this draft.

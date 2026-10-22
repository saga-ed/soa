# Vishnu mesh viewer

View the synthetic-dev mesh managed by `ss`, or explore an explicitly labeled
fixture preview. Live mode derives topology from the `ss` manifest and probes the
selected slot's local services. The server also ingests cumulative event statistics
from IAM, programs and scheduling. Statistics are available at `/api/event-stats`;
the graph statistics UX is a separate follow-up. Datadog is not connected.

## Run with synthetic-dev

From the SOA repository root:

```sh
pnpm --filter @saga-ed/soa-event-stats... --filter @saga-ed/saga-stack-cli... -r build
ss stack up --slot 0 --with dash --with vishnu --no-auto-pull --no-seed
ss stack verify --slot 0 --with dash --with vishnu
```

Open `http://localhost:8930`. The dashboard runs at `http://localhost:8900`.
`--no-seed` preserves existing data; it does not provision demo personas.
For an already-running stack, add just the viewer:

```sh
ss stack up --slot 0 --only vishnu --no-auto-pull --no-seed
```

Use the same `--slot` or `--set` as the stack being observed. Vishnu uses
`8930 + slot × 1000`, honors the resolved state directory, and is managed by
normal `ss` process lifecycle commands. Never take down another session's slot.

The development-only, loopback-bound `/api/mesh` adapter runs inside Vite. It
imports the built CLI collector; `/api/health` gates readiness. The frontend polls
every 15 seconds without overlapping requests. Existing geometry and selection
survive observation updates; collector failures mark retained data stale.

Live signals are deliberately limited:

- HTTP success means the local health endpoint responded, not end-to-end health.
- TCP success means the infrastructure listener is reachable, not that a database
  schema or queue is healthy.
- Endpoint identity is unverified by the probe; `ss stack verify` checks process
  provenance separately. HTTP redirects are rejected.
- Relationships are the dependencies declared in the `ss` manifest, which is not
  a complete inventory of every API endpoint or event binding.
- Traffic, latency, error counts, and endpoint/event counts stay unknown.
- Broker selection exposes the logical event dependencies routed through it.

The adapter accepts no arbitrary target URLs or mutations and never returns
launch environment variables, database credentials, or application records.
This local adapter is not a production authentication boundary.

## Fixture preview and checks

`pnpm --filter @saga-ed/vishnu dev` without `ss` opens fixture mode.
On a running live viewer, use `http://localhost:8930/?mode=fixture`.

```sh
pnpm --filter @saga-ed/vishnu check-types
pnpm --filter @saga-ed/vishnu test
pnpm --filter @saga-ed/vishnu build
```

With the app running, `pnpm --filter @saga-ed/vishnu test:browser` checks the real
browser interactions using the repository's Playwright installation. Set
`VISHNU_TEST_URL=http://localhost:8930/?mode=fixture` when the server is in live mode.
`pnpm --filter @saga-ed/vishnu test:live-browser` verifies polling and failure handling
with controlled browser responses; it does not alter running services.
`pnpm --filter @saga-ed/vishnu test:synthetic` checks the running slot 0 dashboard
mesh, real probe refresh, stable layout, and RabbitMQ inspection. Set
`VISHNU_TEST_URL` and `VISHNU_TEST_SLOT` to check another slot.

If the host has exhausted file watchers, run
`CHOKIDAR_USEPOLLING=1` before the `ss stack up` or `pnpm dev` command.

## What to review

- Data systems, services, and applications in distinct left-to-right bands.
- Rounded orthogonal routes with arrows indicating actual direction, including
  reciprocal program/scheduling events and right-to-left API requests.
- Search, keyboard selection, pan/zoom, minimap, fit controls, and side inspection.
- Overview, incident, and missing-telemetry scenarios using exactly the same
  topology. Switching measurements should preserve positions and the viewport.
- Declared relationships remain visible when traffic is zero or unknown.
- Event paths are logical relationships through RabbitMQ. The broker node shows
  infrastructure scope; it is not a claim that every path has independent queue
  measurements.

The geometry model is separate from observed health and traffic. ELK computes
orthogonal routes in a browser worker; custom edges retain its routing rather than recomputing
curves from node positions. The current graph model is an initial local contract, not
the final telemetry API contract.

The first version uses edge halos to distinguish crossings. Dense overlapping
routes still need an explicit aggregation/lane policy before scaling to the full
fleet. Fit selection, Focus canvas, Hide inspector, and Browse as list provide
alternatives to reading the whole graph at a small zoom.

## Style dependencies

The canonical `@saga-ed/product-style` package is pinned to public source commit
`9b134187093f550a4d33cfda4d37c8ab02cdbfed` using an immutable archive dependency.
The local CodeArtifact token was expired during setup; this uses the real package
without copying or recreating its tokens. Adopt the registry release once access
and version availability are verified.

The documented Svelte component library was still an empty private package when
inspected. Small local Svelte components use the canonical CSS layers until that
library is usable. Montserrat is bundled locally.

## Remaining integration

The [implementation plan](../../../claude/projects/vishnu/plans/implementation.md)
and [telemetry findings](../../../claude/projects/vishnu/research/telemetry-2026-10-20.md)
describe the dedicated tRPC API, server-side Datadog queries, durable event
projections, staff authorization, and synthetic-dev → wootdev → production gates.

Vishnu consuming an event does not demonstrate another service's projection
completion. Do not derive projection lag from last-event age or outbox count.
Live measurements need verified source identity, environment/deployment scope,
query interval, freshness, and evidence links.

## Event statistics in synthetic dev

The server owns a dedicated `vishnu` PostgreSQL database and
`vishnu.slot-N.event-stats.v1` RabbitMQ queue. It checks existing `iam.events`,
`programs.events`, and `scheduling.events` exchanges and binds only
`observability.event_stats.reported`. Start the three adopters so all exchanges exist.
It uses the existing broker credentials; service identity is a validated declaration,
not a cryptographic authentication claim. This endpoint is local-only.

Reports are scope-checked (environment, slot/deployment, broker and vhost), schema
validated, deduplicated and persisted before ack. Snapshot and rate baseline update
atomically. Retired epochs cannot replace a current epoch. Storage failures leave
reports unacked for redelivery. Invalid reports use a bounded one-hour DLQ.
The read API preserves per-instance/per-stream identities, explicit capabilities,
null unsupported counters, stale sources and unverified topology mappings.

Bounds: 256 sources, 64 retired epochs per live source (then fail closed), 24-hour
retention, 90-second staleness; input queue 10,000 reports with one-hour TTL.
Reporter heartbeats are five seconds in synthetic dev. Missing heartbeats produce
stale state, not zero activity. A new epoch/source needs a fresh rate baseline.

For the pre-release worktrees and repeatable real outbox/duplicate/handler-failure
check, follow [the I#536 test runbook](../../../claude/projects/gh_536/docs/synthetic-event-stats.md).
The check leaves two identifiable synthetic outbox rows, a successful projection,
deduplication records and the expected failed event in the business DLQ. Its temporary
failure trigger is removed in `finally`. It never resets/seeds the slot.

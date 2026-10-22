# Vishnu mesh viewer

View the synthetic-dev mesh managed by `ss`, or explore an explicitly labeled
fixture preview. Live mode derives topology from the `ss` manifest and probes the
selected slot's local services. No Datadog or application event collection is
connected yet.

## Run with synthetic-dev

From the SOA repository root:

```sh
pnpm --filter @saga-ed/saga-stack-cli build
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

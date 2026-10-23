# Vishnu mesh viewer

View the synthetic-dev mesh managed by `ss`, or explore an explicitly labeled
fixture preview. Live mode derives topology from the `ss` manifest and probes the
selected slot's local services. The server also ingests cumulative event statistics
from IAM, programs and scheduling. Statistics are available at `/api/event-stats`, in the API inspector, and in
keyboard-accessible MQ badge previews. An optional server-side Datadog adapter
provides scoped APM observations and links to Datadog for flow analysis.

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
- HTTP edge traffic, edge latency and endpoint counts stay unknown without
  caller-specific evidence. MQ counts/rates come from reporting instances; optional
  Datadog metrics describe services and are labeled separately from local probes.
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

## Partial-stack lifecycle states

The default topology retains saga-dash, Connectv3 and Coach plus their declared
dependencies. Additional active-service discovery requires a responding local
endpoint or a live managed process whose service directory and slot port match
its PID record. Historical, malformed and
reused PID records alone do not add services to the active mesh. On Linux, process
verification uses `/proc`; inaccessible metadata is unverified, not proof of failure.

Declared dependencies that have never been observed running in this viewer session
are neutral **not started** nodes. A previously managed service whose PID record
was removed is **stopped**, also neutral. An observed service that exits with its
record still present, or whose endpoint responds unsuccessfully, remains
**unhealthy**. Existing nodes and edges remain stable across those transitions.
Without current launch intent, a dead historical PID alone cannot establish an
unexpected outage across viewer restarts; it is excluded from active discovery; declared product dependencies can still
appear as neutral, not-started nodes.


## Datadog observations and flow analysis

Codex's Datadog MCP OAuth login is for agent investigation. Vishnu independently
uses a read-only API/application key pair on its server. It never reads personal
MCP OAuth tokens. Configure the server environment or the git-ignored file
`apps/web/vishnu/.env.local` (restart Vishnu after editing):

```dotenv
DD_SITE=datadoghq.com
DD_API_KEY=<read-only-integration-api-key>
DD_APP_KEY=<scoped-application-key>
VISHNU_DATADOG_ENV=synthetic
VISHNU_DATADOG_DEPLOYMENT=slot-3
VISHNU_DATADOG_DEPLOYMENT_TAG=deployment.identifier
```

Required permissions: `timeseries_query`, `monitors_read`, and APM read access
for service dependencies. Never prefix these secrets with `VITE_` or commit them.
The deployment tag must be available on trace metrics and configured as a Datadog
primary tag for the Service Dependencies API; otherwise that query may be
unavailable. No fallback silently broadens the query to all deployments.

`/api/datadog` is read-only and has the same loopback/origin restrictions as the
other local APIs. Fixed requests are coalesced and cached for 60 seconds, with
8-second timeouts and rate-limit backoff. No browser-supplied queries/URLs are
accepted. Missing credentials, denied requests, partial responses, stale data and
zero measurements remain distinct. APM data does not overwrite local probe health.

The default metric prefix is `trace.http.server.request`; the duration distribution
is interpreted in seconds and displayed in milliseconds. Override with
`VISHNU_DATADOG_METRIC_PREFIX` only for an equivalent seconds-based distribution.
Requests and errors use `.as_rate()`. The inspector shows the latest bucket, and
an earlier p95 bucket at least five minutes before it, never an average of percentiles.
The query window is 15 minutes; points expire after 3 minutes. Retention and SDK
sampling must be verified in the live organization before claiming full coverage.

Telemetry refresh preserves geometry. User-selected signal views can smoothly
reflow matching systems into an expanded focus area, retaining every node and
connection in a smaller context frame. Disable Reflow signal focus to keep the
full layout. All paths restores the original geometry. Node badges show service metrics;
lines marked `observed` have an exact scoped dependency observation. Thin gray lines represent structure; stronger colored lines represent signals.
Only synthetic data for the displayed slot is eligible for graph overlays. If a
cloud environment/deployment is configured, its observations remain explicitly
labeled in the inspector and the slot graph is not colored from them.

Display thresholds (configurable; not monitor definitions):

- `VISHNU_DATADOG_HOT_RATE`: 10 requests/second.
- `VISHNU_DATADOG_WARNING_P95_MS`: 2500 ms.
- `VISHNU_DATADOG_CRITICAL_P95_MS`: 5000 ms.

The p95 defaults match the existing IaC monitor defaults, but these badges evaluate
the latest bucket rather than the monitor's sustained window. Hot traffic alone is
not a fault. Only monitor groups explicitly including the exact environment,
deployment and service are attached; environment-wide monitors are not attributed
to a synthetic slot. The adapter reads at most the first 100 service-mesh monitors.

Inspector links open scoped Datadog span search; use Trace Queries / Flow Map in
Datadog for fan-out, repeated calls and waterfalls. Edge links filter destination
service and `@span.parent.service`. Missing propagation/parent tags can yield no
results, so a destination-only link is provided too. Vishnu does not ingest or
reconstruct trace trees, and retained span counts are not used as traffic totals.

Checks: `pnpm --filter @saga-ed/vishnu test:datadog-browser` covers controlled
browser responses, scope isolation, expiry, errors, links, and stable graph geometry.
No live Datadog coverage is established by that test.


## Stand-up signal demo

Open `/?mode=demo` for an isolated, clearly labeled simulation. It makes no live
mesh, MQ or Datadog requests. All paths includes invented early warnings at 70%
of a budget, with Hot, Slow, Fan-out and Warnings views for emphasis. Path count remains unchanged while switching views; geometry can tween into a
focused layout. Reduced-motion users get immediate transitions.

Palette uses Saga semantic tokens: orange (`--color-attention-strong`) for traffic,
blue (`--color-primary`) for latency, magenta (`--chart-2`) for fan-out, clay
(`--color-danger`) for a threshold breach. Opacity is `0.35 + 0.65 × min(1,
value / budget)`; labels remain fully opaque and show the value and percentage.
The demo budgets are illustrative, not operational thresholds. Its causal example
is two Programs calls per IAM request, each making 25 Scheduling calls: 50 calls
per root request. The Return to live view link exits the simulation.


Path labels are placed in screen coordinates and avoid nodes, controls and other
labels. They degrade from signal text to protocol identifier plus an 18px
partially transparent grayscale info icon, then to an icon alone when necessary.
Hover or keyboard focus reveals the complete description. Unplaceable labels
remain available in Crowded paths and the inspector. Coach → IAM simulates 12
HTTP 500 responses in 500 requests (2.4% errors); saga-dash → Programs remains
the orange hot path. The demo's full-mesh/selection reflow retains connectivity,
handles interrupted transitions, and restores the exact original geometry.

## Hosted dev/prod runtime

The hosted [SOA/tRPC backend](../../node/vishnu-api/README.md) serves the built
frontend behind JANUS staff authentication. See [deployment preparation](../../../infra/vishnu-api/OPS.md)
for the dev container and infrastructure bring-up. This is separate from the
synthetic Vite adapter above; cloud MQ adoption is not enabled by these templates.

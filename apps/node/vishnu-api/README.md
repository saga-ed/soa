# Hosted Vishnu API

One Node 24 process serves the static SvelteKit frontend and the read-only tRPC
backend. It uses SOA ExpressServer/Inversify and shared health helpers. JANUS
signature verification and staff permissions guard both assets and API responses.
The synthetic viewer continues to run through its loopback Vite adapter.

## Runtime

Build dependencies, backend and frontend from the repository root:

```sh
pnpm exec turbo run build --filter=@saga-ed/vishnu-api^...
pnpm --filter @saga-ed/vishnu-api build
pnpm --filter @saga-ed/vishnu build
```

Set `VISHNU_ENVIRONMENT=dev`, `VISHNU_DATADOG_ENV=dev`,
`VISHNU_DATADOG_SCOPE=environment`, `VISHNU_MQ_ENABLED=false`, `DD_SITE=datadoghq.com`
and inject `DD_API_KEY`/`DD_APP_KEY` from Secrets Manager. Start with
`pnpm --filter @saga-ed/vishnu-api start`. Default port: 8931.
`VISHNU_STATIC_DIR` overrides the compiled frontend location in the container.
The expected public origin is `https://vishnu.wootops.org`; production uses
`https://vishnu.sagaops.org`. Arbitrary origins and authentication bypasses fail
at startup. Local browser navigation still requires the expected Host and a real
JANUS staff session; the automated test supplies a signed test session locally.

`/trpc/telemetry.mesh`, `.datadog`, and `.eventStats` are GET-only procedures.
`/api/mesh`, `/api/datadog`, and `/api/event-stats` are compatibility routes to
those same procedures. The current frontend uses the compatibility routes.
`/health` and `/health/ready` are unauthenticated ALB checks. Datadog outages do
not cause restart loops: cached observations expire and the UI reports stale or
unavailable data. Readiness checks the MQ connection when that receiver is enabled.

## Observation semantics

Cloud topology combines reviewed source-declared clients with services and
relationships observed in APM. `src/declared-topology.ts` holds the dated source
catalog with repository/file evidence and configuration conditions. It is not an
automatic fleet discovery or proof of deployed client configuration. Declared
edges persist through quiet windows/outages and retain stable IDs when APM sees
them; observed-only dependencies remain additional evidence. Update the catalog
when client wiring changes. Conditional clients remain labeled conditional.
Declared-only paths are dashed with readable neutral strokes; the inspector
distinguishes not observed, observed, stale and unavailable. Unknown is never zero.
This first catalog covers application/API request wiring, not cloud databases or
broker bindings; those cannot be inferred from the synthetic launcher. APM adjacency is labeled `APM`; it supplies no
protocol, edge count, or edge latency. Service rates/p95 remain service-level
measurements. Lack of data stays unknown. Composite monitor inputs are shown as
evidence, but do not independently raise a critical signal.

Environment scope is explicit because the measured trace series currently lack
`deployment.identifier`. It never falls back silently from deployment scope.
Cloud MQ is disabled for this first deployment: durable storage, receiver scope
and producer adoption need a separate rollout. Synthetic MQ remains supported.

## Validation and deployment

```sh
pnpm --filter @saga-ed/vishnu-api test
pnpm --filter @saga-ed/vishnu-api check-types
pnpm --filter @saga-ed/vishnu-api test:browser
```

The browser test requires the frontend/backend builds and Playwright Chromium.
It checks a signed staff session, cloud scope, graph layout, inspector statistics
and disabled MQ state. See [deployment operations](../../../infra/vishnu-api/OPS.md).


## Bedrock investigation assistant

The assistant is a single TypeScript Strands agent. It reads the same mesh,
call rankings and resource snapshots as the UI, and emits validated UI actions.
It cannot run shell commands, arbitrary Datadog queries, deployments or mutations.
The authenticated `/api/assistant/turn` POST streams NDJSON. The chart routes
below add bounded historical queries and personally owned saved-view writes. Requests require the exact configured Origin and a
verified JANUS staff subject. Conversations are subject-bound, expire after
30 minutes, and are held in process memory (a task restart expires them).

Configuration:

- `VISHNU_AGENT_ENABLED=true` enables the assistant (default off).
- `VISHNU_AGENT_MODEL=us.anthropic.claude-sonnet-5-5` selects the Bedrock profile.
- `AWS_REGION=us-west-2` selects the AWS region.
- `VISHNU_AGENT_PROFILE=saga-dev` is for local SSO only; leave it unset in ECS,
  where the AWS SDK uses the task role. No Bedrock API key is needed.
- Existing `DD_API_KEY` and `DD_APP_KEY` remain server-only and supply resource
  queries as well as call telemetry. Never put secrets in `VITE_*` variables.

The runtime allows two simultaneous investigations and 50 conversations, with a
90-second deadline, 12 tool calls and bounded prompt/output/history sizes.
Each staff subject can start 12 investigations per rolling hour; each API
process permits 60 per rolling hour. Each turn permits six model invocations,
with an estimated 16,000-input-token ceiling per call and 48,000 across the
turn, checked before calls using Strands' token estimate. These are operational
limits, not an account-wide monetary cap: counters are in memory and reset on
restart, and multiple replicas each have their own process limit. The output
limit is 1,800 tokens per model invocation. Cancellation propagates to Strands.
Model usage is returned as token counts.
A user changing the view during a response gets an explicit Apply action;
otherwise the requested filters apply immediately. Restore recovers the view
from before the investigation. Failed or unavailable measurements stay unknown.

`/api/resources` queries Datadog container CPU, CPU limit, working set and memory
limit, retaining each container ID and ECS task family. Five-minute averages
and reported limits are shown explicitly. Resource-only APIs/workers can enter
the hosted mesh without invented HTTP edges. Generic container names such as
`api` need an explicit identity map and are not guessed. Native synthetic
processes do not yet publish these resource metrics; the local resource view
explains that gap instead of assigning host totals to APIs. Historical charts
are described below. Runtime heap/GC panels, throttling and automatic remediation
are not included.

## Assistant sandbox handoff

The existing blue deployment uses a template newer than this branch. Preserve
that deployed template, its MQ preview tag `sandbox-gh537`, database configuration
and existing secrets. Do not replace it with this branch's older service template.

The deploy coordinator must add these task environment values on **blue only**:
`VISHNU_AGENT_ENABLED=true`, `VISHNU_AGENT_MODEL=us.anthropic.claude-sonnet-5-5`,
`AWS_REGION=us-west-2`. Use the existing Datadog Secrets Manager references.
`infra/vishnu-api/assistant-dev-policy.json` is the exact proposed Bedrock grant,
restricted to one inference profile and its three underlying regional model
ARNs, verified with `get-inference-profile`. IAM simulation with this grant and
the current `SagaProdMax` boundary allows both model invocation actions.
The grant has NOT been applied. Prefer a dedicated blue task role if granting
it to the shared task role would change green's permissions. Keep the existing
permissions boundary and ECS task trust policy. No green/prod promotion is part
of this handoff.

Validation commands from the repository root:

```sh
pnpm --filter @saga-ed/vishnu-api check-types
pnpm --filter @saga-ed/vishnu-api test
pnpm --filter @saga-ed/vishnu-api build
pnpm --filter @saga-ed/vishnu check-types
pnpm --filter @saga-ed/vishnu test
pnpm --filter @saga-ed/vishnu build
pnpm --filter @saga-ed/vishnu-api test:browser
pnpm --filter @saga-ed/vishnu test:assistant-browser
VISHNU_LIVE_AGENT=true pnpm --filter @saga-ed/vishnu test:assistant-live
```

The live test invokes the real model. It verifies incoming IAM slow-call filtering,
model-driven restore without refresh, and resource navigation. For the deployed
sandbox, set `VISHNU_TEST_URL=https://vishnu.wootops.org`,
`VISHNU_TEST_BLUE=true`, and `VISHNU_TEST_STORAGE_STATE` to a local Playwright
staff session file. The test sends the blue preview header. Credentials and
browser storage state must never be committed.

## Historical charts and private saved views

`show_chart` lets the Strands agent emit a validated data-only chart definition;
ECharts renders line, histogram and scatter plots. The model cannot supply query
strings, executable chart code or another scope. `POST /api/charts/query` resolves
canonical mesh system IDs against the server-selected Datadog scope. A chart has
an explicit rolling window or fixed ISO dates. Queries cover 5 minutes–30 days
within the past 31 days; older fixed definitions remain saved but cannot query
outside that first-release bound. Datadog retention may be shorter.

CPU and working-set memory use `container.cpu.usage` and
`container.memory.working_set`, converted to cores and MiB. Replica identity
includes task family and container ID. Service grouping means the average of
reporting replicas, not a total or a percentage of capacity. Scatter pairs the
same replica at the same timestamp; no forward filling. Native synthetic
processes currently lack these metrics and show an explicit empty state.

Latency uses Datadog's retained server-span analytics (`apm_read`), excluding
health probes. It is labeled sampled, not all-request APM latency. Line charts
support average, maximum and p95. Request-duration histograms use a bounded
20-bin span aggregation after measuring the maximum; interval-statistic
histograms instead bin average/max/p95 time buckets and label that distinction.
Missing intervals break lines instead of becoming zero. Exact scope and resolved
time range appear with every result. The latency drill-through opens scoped
traces in Datadog. There is no mirrored time-series warehouse.

Queries use existing server-only `DD_API_KEY`/`DD_APP_KEY` credentials; no new
Bedrock API key or role grant is required. The history reader coalesces equivalent
queries, caches at most 64 results for three minutes and admits four concurrent
queries. It allows at most 100 upstream requests per process per hour, uses a
12-second request timeout and a 4 MB response bound, and backs off on 429.
These limits are process-local and separate from the mesh reader; Datadog's
shared account limits still apply. Failed refreshes return unavailable, never
unlabeled stale measurements. The UI shows the original query time on cached data.

`GET /api/charts/catalog` reports the current scope. `/api/chart-views` supports
owner-scoped GET/POST; `/api/chart-views/:id` supports PUT/DELETE. All hosted
routes require JANUS staff identity; POST/PUT/DELETE also require exact Origin.
Each view belongs to `claims.sub` and the current telemetry/mesh scope. Updates
require the current revision. There are at most 50 saved views per owner and
eight charts per view. The loopback synthetic adapter uses the local developer
identity, not multiuser authentication.

`VISHNU_DATABASE_URL` is the existing Vishnu Postgres connection. On first saved
view access it creates the additive `vishnu_chart_view` table and owner/scope
index. The table stores definitions, chart ordering, mesh minimization, time
settings and revisions, never measurements. Existing MQ tables are untouched.
The database principal needs CREATE/SELECT/INSERT/UPDATE/DELETE for this table.
Rollback to older application code leaves the unused table in place; do not drop
users' saved views. Saved definitions remain listable during a Datadog outage.

Choose **Charts → Saved chart sets** to reopen a private pinned set. Rolling
windows move when reopened; fixed windows retain their exact dates. Manual
changes made during an assistant response require **Apply suggested view**.
Restore previous view and Reset view work without reloading. Unsaved edits are
not automatically persisted.

Additional checks (from the repository root):

```sh
pnpm --filter @saga-ed/vishnu exec vitest run --config vitest.int.config.ts server/chart-views.int.test.ts
pnpm --filter @saga-ed/vishnu test:charts-browser
VISHNU_LIVE_AGENT=true pnpm --filter @saga-ed/vishnu test:charts-live
```

The integration test starts disposable Docker Postgres/RabbitMQ infrastructure;
the chart browser test exercises local private saved views and deletes its test
view. The live test consumes Bedrock tokens and uses real scoped Datadog history.
For blue, use the same `VISHNU_TEST_URL`, `VISHNU_TEST_BLUE` and staff storage-state
settings documented above. Deploy through the coordinator using the existing
blue template, role, database and secrets; this branch's older infrastructure
must not replace the sandbox template.

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
The authenticated `/api/assistant/turn` POST streams NDJSON; all other write
routes remain disabled. Requests require the exact configured Origin and a
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
Cancellation propagates to Strands. Model usage is returned as token counts.
A user changing the view during a response gets an explicit Apply action;
otherwise the requested filters apply immediately. Restore recovers the view
from before the investigation. Failed or unavailable measurements stay unknown.

`/api/resources` queries Datadog container CPU, CPU limit, working set and memory
limit, retaining each container ID and ECS task family. Five-minute averages
and reported limits are shown explicitly. Resource-only APIs/workers can enter
the hosted mesh without invented HTTP edges. Generic container names such as
`api` need an explicit identity map and are not guessed. Native synthetic
processes do not yet publish these resource metrics; the local resource view
explains that gap instead of assigning host totals to APIs. Historical baseline
comparison, runtime heap/GC panels, throttling and automatic remediation are
not included in this first demonstration.

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

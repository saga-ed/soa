# Vishnu implementation plan

Date: 2026-10-20  
Branch: `work/vishnu-discovery-handoff`

## Intent and decision status

Vishnu is an environment-aware mesh visualization and diagnostic viewer. The user authorized implementation with parallel agents. The first implementation is a standalone fixture-backed SvelteKit application at `apps/web/vishnu` in this checkout. Final repository placement remains open; this location makes the work concrete and reviewable without assuming a production destination.

Accepted requirements:

- Model the application on Saga dashboards and existing tRPC/RabbitMQ services.
- Constrain visual design to [saga-ed/product-style](https://github.com/saga-ed/product-style), published at [style.wootdev.com](https://style.wootdev.com). Prefer its actual tokens, components, and interaction guidance; do not merely imitate screenshots.
- Query Datadog directly from the server for operational telemetry.
- Maintain required application-derived state through RabbitMQ event projections. Fill demonstrated producer event gaps as project work.
- Use progressive disclosure: mesh overview → side inspector → deeper system or evidence view.
- Preserve graph pan, zoom, and selection when opening the inspector.
- Provide recognizable traffic, topology, and health indicators; make crossings unambiguous.
- Support laptop screens and large monitors without shrinking labels beyond readability.

Working defaults, not settled product decisions:

- Standalone staff-facing application; explicit staff authorization must precede live telemetry access.
- Existing Datadog monitor states inform health, supplemented by independently measured queue/projection conditions.
- Edge width means declared endpoint or distinct event-type count; intensity means traffic. These must remain separately labeled.
- Current-state view first, with a bounded time window for observations. Refresh cadence and historical investigation scope remain open.
- Collapse broker internals in the overview while retaining a selectable broker and clearly labeled logical event paths.

## Phase 1: reviewable fixture application

Build a runnable SvelteKit/Svelte 5 application with typed graph fixtures, style-guide-based styling, a stable graph, explicit fixture context, search, pan/zoom, fit controls, and an accessible side inspector.

Represent data systems, mesh services, and applications in left-to-right bands. Use actual arrows for direction rather than implying that every flow moves left-to-right. Include IAM, programs, scheduling, databases, broker relationships, and a dashboard as a representative slice. Include reciprocal scheduling → programs events to exercise realistic routing.

Keep declaration and observation separate in the model:

- Stable node/relationship IDs and environment/deployment scope.
- Connection kind, declared endpoint/event count, publisher/consumer or request direction, and provenance.
- Observation source, measured interval, freshness, traffic, error/latency values, health, and evidence references.
- Explicit unknown, stale, zero, and unavailable states.

Fixtures must be visibly identified as fixtures. Environment controls must not imply live environment connectivity. Include enough meaningful cases to review quiet services, failure, missing telemetry, traffic, multiple consumers, shared databases, and reverse flows.

### Layout and edge semantics

Use layered ordering and reserved routing lanes to reduce crossings and bends. Keep tightly related nodes near each other. Use consistent incoming/outgoing attachment areas and sufficient clearance around nodes. Route long or reverse connections around the outside where this improves traceability.

For unavoidable crossings, render a gap or bridge without a junction dot. An actual junction requires an explicit marker. Never silently overlap unrelated paths. Deliberate aggregates require a visible count and explicit aggregation semantics; their thickness must not accidentally imply summed traffic.

Do not redraw node positions during telemetry refresh. Selection should emphasize the complete selected route or immediate neighborhood and dim unrelated edges. Inspector opening must not trigger graph re-layout. Zoom may progressively reveal labels and detail, but meaning must remain consistent.

First-click inspector: identity, environment/deployment, status, key metrics, freshness, and relationship details. Provide a clear path toward deeper evidence. On narrow screens, let details occupy available width while retaining a return to the previous graph position. Include visible legends and non-color status cues.

## Phase 2: backend and telemetry contract

The synthetic-dev integration now supplies a development-only adapter through
Vite, registered as optional `ss --with vishnu`. It displays manifest-declared
relationships and live slot-local HTTP/TCP reachability, with unmeasured traffic
and errors left unknown. This establishes local stack visibility before the
dedicated API below. It does not implement Datadog collection or event projections.

Implement a dedicated typed tRPC API and Postgres projection store using the scheduling-api service composition pattern. Keep Datadog credentials server-side; batch and cache read-only queries. Preserve source intervals and freshness rather than presenting cached values as instantaneous.

Use verified IAM identity plus explicit authorization for mesh diagnostics. Do not infer staff privileges from a valid session alone. Reuse shared EventConsumer transaction/deduplication behavior, preview-scoped queues/exchanges, versioned contracts, and DLQ handling.

Maintain three conceptually distinct datasets:

1. Declared topology and supported contracts.
2. Application facts projected from events.
3. Datadog operational observations.

Vishnu receiving an event proves only Vishnu received it. It does not prove another consumer committed its projection. Measure actual consumer progress through existing telemetry or a deliberately designed consumer-originated progress signal.

See [telemetry discovery](../research/telemetry-2026-10-20.md) for concrete sources, pins, and gaps.

## Phase 3: verify and connect the first live slice

Before connecting live telemetry:

1. Verify current Datadog metric names, tags, monitor inventory, permissions, sampling/aggregation behavior, and deployment scope.
2. Verify whether shared Prometheus event metrics are actually ingested. OTLP intake alone is insufficient evidence.
3. Verify queue-level telemetry availability; broker totals cannot be assigned to individual consumer edges.
4. Identify a real event and follow producer/outbox/broker/consumer evidence across the chosen relationships.
5. Define required additional application facts and add producer events only where existing contracts cannot supply them.
6. Agree environment identity and staff authorization; verify synthetic-dev behavior independently of hosted environments.

The initial slice is IAM → programs projection and programs → scheduling projection, alongside their databases and dashboard calls. These are adjacent topology relationships, not an assertion that an IAM user event causally creates a program event.

## Verification and rollout gates

Fixture gate: type checks/build pass; graph interactions work; selected routes remain traceable at crossings; keyboard access, labels, focus, and non-color health cues remain usable. Review representative laptop and large-monitor viewports.

Integration gate: zero, stale, and unavailable data remain distinguishable; metrics carry the correct environment/deployment; consumer replay and duplicate delivery do not corrupt projections; authorization prevents unintended cross-environment access.

Operational gate: exercise slow calls, failures, backlog, projection delay where measurable, missing telemetry, and idle services. Confirm evidence links and acceptable query/collection overhead.

Roll out through synthetic-dev and wootdev before production using Saga infrastructure conventions. Production hosting/deployment is later work. This plan records no live queries, infrastructure mutation, deployment, or confirmed production coverage.

## Hosted deployment plan — dev and prod (2026-10-20)

### Reference application and evidence

Use **staff-admin-console in saga-dash** as the deployment reference. The old
rostering IAM console explicitly marks itself deprecated and points to that app.
This resolves the earlier “admin-dash in rostering” reference without copying a
retired deployment pipeline.

Inspected local source revisions (not a live AWS inventory):

- saga-dash: `0884440b55a4b854cd605e83fad9d1a0d018b3a6`.
- rostering: `fe9eb74c4bbba824cb42124deb3bcab01e607d0d`.
- program-hub: `593b52855a0c6e31a7c880a3f69cab7767ec5354`.

Primary reference files:

- `/home/skelly/dev/rostering/apps/web/iam-console/CLAUDE.md` — deprecation notice.
- `/home/skelly/dev/saga-dash/apps/web/staff-admin-console/CLAUDE.md` — current app architecture and dev/prod release model.
- `/home/skelly/dev/saga-dash/.github/workflows/staff-admin-console-deploy.yml` — manual, code-only frontend/backend deployment, separate environment roles, per-environment concurrency.
- `/home/skelly/dev/saga-dash/apps/web/staff-admin-console/scripts/deploy.sh` — prebuilt SPA ZIP upload to Amplify and completion polling.
- `/home/skelly/dev/saga-dash/infra/staff-admin/frontend-template.yaml` and `frontend-samconfig.yaml` — hosting and environment configuration.
- `/home/skelly/dev/saga-dash/infra/staff-admin/backend/template.yaml`, `routing-template.yaml`, and `samconfig.yaml` — Lambda, target group, routing, origin and authentication configuration.
- `/home/skelly/dev/saga-dash/apps/web/staff-admin-console/backend/src/app.ts` — verified Janus identity and staff permission checks.
- `/home/skelly/.codex/plugins/cache/saga-tools/saga-iac/1.21.3/references/principles.md` — current hosting, role separation and environment invariants.

Source discrepancies to resolve before infrastructure is applied: the staff-admin
infra README still says production is undeployed, but its current app documentation
says production has been live since July 29. Its routing template uses ALB-native
JumpCloud OIDC plus Janus; current Saga principles call ALB-native OIDC retired in
favor of Janus + WAF. Do not treat stale prose as deployed fact or silently copy
this exception. Verify actual listeners, WAF, gate configuration and approved
internal-app perimeter during implementation. No AWS resources were inspected or
changed while producing this plan.

### Proposed environment layout

| Item | Dev | Prod |
|---|---|---|
| UI hostname (proposed; verify availability) | `vishnu.wootops.org` | `vishnu.sagaops.org` |
| API hostname (proposed) | `vishnu-api.wootops.org` | `vishnu-api.sagaops.org` |
| Hosting | Dedicated Amplify app, `dev` branch | Separate-account Amplify app, `main` branch |
| HTTP backend | Dedicated Lambda behind shared ALB | Same pattern in prod account |
| Event projection worker | Private ARM64 ECS service on shared dev cluster | Private ARM64 ECS service on shared prod cluster |
| Projection database | Dedicated Vishnu DB/roles on approved dev database tier | Dedicated Vishnu DB/roles on approved prod database tier |
| Release trigger | Manual GitHub workflow dispatch | Manual GitHub workflow dispatch through prod environment controls |

Keep the implementation in SOA for the first hosted release, matching the existing
checkout and shared telemetry packages. This is a proposed ownership choice, not a
reason to relocate staff-admin code or share its runtime role. Use `soa` as project
namespace with Vishnu-scoped resources. Reserve actual stack names, SSM paths,
listener priorities and hostnames only after discovery; do not reuse staff-admin
resource identifiers. No public product navigation, per-PR hosted frontends or
switchboard registration for the viewer by default.

“Internal” follows the reference console's staff-authenticated access model:
Amplify may serve the static app shell publicly, but all topology and telemetry
are obtained only from an authenticated, authorized API. Ship no environment
inventory, sensitive fixtures, credentials or telemetry in static assets. If the
requirement is network-private access even to the HTML/JS, Amplify's normal public
hosting is not sufficient: resolve that hosting decision before bootstrap rather
than calling a login screen network isolation.

### Architecture and access boundary

1. Retain the SvelteKit static UI and Saga style package. Replace the development
   Vite middleware in hosted builds with a dedicated typed tRPC HTTP backend.
   The production artifact must not depend on `ss`, local pidfiles, local sibling
   checkouts, port probes or `/api/mesh` supplied by Vite. Keep the current adapter
   as an explicit synthetic-dev mode. Make the UI data-provider contract shared
   between local and hosted modes; a missing hosted config fails visibly and
   never falls back to fixtures.
2. Follow staff-admin's frontend → own backend boundary. Browser requests carry
   the staff session to that backend; Datadog and infrastructure credentials
   remain server-side. Validate the Janus signature, issuer, expiry and intended
   staff permission on every diagnostic request. Propose a read-only
   `vishnu:view` permission, subject to the existing gate's permission vocabulary;
   do not inherit impersonation or administration rights just to view telemetry.
   Anonymous, nonstaff and unauthorized staff requests must fail closed.
3. Use the current Janus/WAF baseline unless the platform owner confirms the
   staff-admin ALB-OIDC exception remains required. If exact edge parity is
   required, reproduce its OPTIONS handling and top-level login navigation,
   not just its authenticate-oidc listener action. In either case retain backend
   authorization; do not trust caller-supplied identity headers. Confirm custom
   ops-domain gate support, callback allowlists, cookie domain/SameSite handling,
   exact credentialed CORS origin and CSP before release.
4. Keep the Lambda request-bounded: serve declared topology, cached Datadog reads
   and projection queries with limits, timeouts and stale-data semantics. Grant
   the backend read-only access to Vishnu projections. Scope Datadog credentials
   to required read APIs and resolve them through Secrets Manager. Fix each
   deployment's environment and allowed sources server-side; no arbitrary target
   URLs, user-supplied Datadog queries or dev credential path into production.
5. Run durable RabbitMQ consumers in a separate private ECS worker. Reuse Saga's
   EventConsumer deduplication and transactional projection pattern. Give Vishnu
   its own queues/bindings and DLQ; never compete for an application consumer's
   queue. The worker writes only its own projection database and has no public
   listener. IAM/RabbitMQ/DB permissions are distinct from the HTTP backend's.
6. Store topology declarations, application projections and measured telemetry
   separately. Counts are message totals over an explicit interval; rates are
   messages/sec; neither is the existing distinct-event-type count. Handle
   publish fan-out, redelivery and multiple queues explicitly. A Vishnu receipt
   does not prove a different consumer committed its projection. Preserve
   declared MQ-P/MQ-C roles even at zero traffic, and distinguish configured
   capability from observed worker health. Unknown metrics remain unknown.

### Delivery sequence and reviewable outputs

**1. Reference and environment preflight.** Read the current staff-admin workflow
and deployed configuration in each account using read-only access. Inventory
available hostnames, certificates, listener priorities, WAF/Janus integration,
GitHub environments, SSM references, database provisioning path, RabbitMQ scope,
Datadog site/tags and operator permissions. Record differences from repository
configuration. Confirm the staff permission and the static-shell access policy.
Resolve the OIDC/Janus discrepancy here, before authoring routing changes.

**2. Production-capable backend.** Add a Vishnu backend package, versioned shared
contracts, validated hosted config, staff auth, tRPC query surface, Datadog adapter
and projection reads. Expose minimal liveness/readiness plus build revision and
environment identity without leaking credentials or topology anonymously. Ensure
polling budgets and cache keys cannot mix environments or users' authorization
scopes. Preserve synthetic-dev behavior and add the new components to `ss` when
available. Source-derived protocol/role annotations are declarations, not live
telemetry, and must ship with provenance.

**3. Collector and data provisioning.** Add the event worker, initial projection
schema/migrations, retention, replay/backfill strategy and DLQ handling. Start with
IAM → programs and programs → scheduling evidence, then extend the fleet. Prove
actual producer/consumer event bindings; a startup dependency list is insufficient.
Identify missing producer/projection-completion signals as explicit source-service
changes. Avoid student payload storage: project only the metadata/counters needed
for diagnostics. Agree retention and payload filtering before consuming real data.

**4. Infrastructure bootstrap.** Author separate frontend, backend and routing
stacks following staff-admin's change boundaries. Package the Lambda from a built
bundle rather than expecting `sam build` to construct the workspace. Add collector
bootstrap/service infrastructure using Saga's shared ARM64 ECS conventions, and
provision the per-environment DB, secrets and queues before enabling consumers.
Use per-environment explicit parameters; production defaults and complete dev
URL/secret overrides prevent accidental cross-environment calls. Plan the Lambda
VPC path to the projection DB and outbound access to Datadog/JWKS. Create least-
privilege, Vishnu-only GitHub OIDC roles. Infrastructure changes use the appropriate
AppInfra/PlatformInfra permissions; routine releases do not gain IAM/CFN powers.

**5. Release workflow.** Add a manual `vishnu-deploy.yml` workflow with environment
`dev|prod` and component `frontend|backend|collector|all`. Serialize by environment;
do not cancel an active release. Use GitHub OIDC, protected environment controls,
locked pnpm installs and quality checks. Frontend: build with the exact API origin,
upload ZIP to the existing Amplify branch and poll completion. Backend: build with
commit identity, update the existing Lambda bundle and await readiness. Collector:
use the standard ECS deploy path with a separate, scoped role; require backward-
compatible migrations and graceful drain/reconnect. Deploy compatible backend and
collector changes before the frontend. Preserve release artifacts and record
commit SHA, account, environment, migration version and validation outcome.
Routine UI/API code releases follow staff-admin's code-only model; collector ECS
changes and infrastructure bootstrap remain separate permission boundaries.

**6. Dev release.** Bootstrap resources and auth before enabling real telemetry.
Deploy a reviewed revision manually. Verify staff login, denied access cases,
correct dev-only sources, reconnect/replay, invalid schema handling, Datadog
throttling, broker outage, stale observations and projection freshness. Check the
served CSP/CORS headers after the artifact upload, not only the stack's settings.
Exercise the actual bus panel, MQ-P/C badges, protocol labels, inspector, resizing,
large-screen fit and laptop operation using authenticated browser tests.

**7. Production promotion.** Promote the dev-validated commit through the prod
workflow. Verify all origins, issuers, secrets, RabbitMQ vhost/exchanges, DB identity
and Datadog filters are prod-specific. Establish a small authorized operator group
and validate real read-only telemetry before broader staff access. Record which
systems/metrics are supported; do not claim complete mesh coverage from reachability
or declaration data. Monitor collector lag, DLQ, API errors, query cost and cache
age throughout initial operation.

### Acceptance gates and rollback

- CI: frontend/backend/worker type checks and builds; auth tests; explicit protocol
  unknowns and dual MQ roles; no cross-environment config; transactional duplicate
  delivery; restart recovery; stale/zero/unknown telemetry; no sensitive static data.
- Access: anonymous and nonstaff calls cannot read topology or counts. Wrong-environment,
  expired and tampered sessions fail. OPTIONS returns only approved CORS metadata.
  Direct API calls receive the same authorization checks as UI requests.
- Telemetry: a known test event is traced through publisher → RabbitMQ → the actual
  target projection; published and consumed metrics reconcile under documented
  fan-out/redelivery semantics. Fixture values cannot appear as live readings.
- Operations: authenticated smoke tests pass in dev and prod; revision/environment
  match the selected release; alarm ownership, freshness thresholds, retention and
  recovery procedures are documented before promotion.
- Frontend rollback: redeploy the retained previous environment-specific artifact.
  Backend rollback: repush the previous Lambda ZIP, matching staff-admin's bare-ARN
  target model (do not assume an alias/version rollback exists). Worker rollback:
  previous task image with compatible schema, without purging queues or projecting
  twice. Use expand/contract migrations; retain DB/queues during code rollback.
  A collector failure leaves stale/unknown data visible and is not a reason to
  mark the monitored application unhealthy.

### Implementation boundaries

This is a deployment plan, not a deployment authorization or a claim of hosted
readiness. The current running application remains synthetic-dev only. No hosted
Vishnu stacks, domains, roles, secrets, database, collector or Datadog integration
have been created. The first executable work package is the reference/preflight
record plus the production backend/auth contract; simply uploading today's SPA
would leave it without a usable authenticated hosted telemetry source.

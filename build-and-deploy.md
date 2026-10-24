# Vishnu build, deployment and MQ go-live handoff

Prepared 2026-10-24 for the Claude agent taking over release/deployment work.
This document is a review plan, **not authorization to execute the rollout**.

## User authorization and ownership

The user explicitly requires review and approval of the go-live plan before any
package version changes/publications, adopter modifications, merges, configuration
changes or further cloud deployments. The earlier dev viewer deployment was
separately authorized and is complete. Do not treat that approval as approval for
MQ rollout or production. Obtain approval for the concrete sequence and its gates.
Do not send Slack/email announcements unless separately instructed.

Codex continues Vishnu core/UX work in this session, starting with persistent
source-declared connections. Coordinate before editing the same files or branch.
Do not deploy the current branch tip blindly: select an explicitly reviewed
commit/image. Do not reset, stash, clean, switch or broadly stage the shared
worktree; it may contain ongoing Codex changes. Check status before every write.

Read `/home/skelly/dev/skilgoreT-skills/facts/preferences.md`, repository
`CLAUDE.md`, applicable `.claude/rules/`, and current saga-iac/release skills.
The user retains `claude/projects/gh_<issue>/` for initiative history.

## Workspaces and review entry points

- SOA implementation: `/home/skelly/dev/worktrees/soa-gh_536-event-telemetry`,
  branch `gh_536-event-telemetry`; [PR#543](https://github.com/saga-ed/soa/pull/543),
  against main. Primary `/home/skelly/dev/soa` contains unrelated work; leave it alone.
- IAM adoption: `/home/skelly/dev/worktrees/rostering-gh_537-event-stats-adoption`,
  branch `gh_537-event-stats-adoption`;
  [rostering PR#1783](https://github.com/saga-ed/rostering/pull/1783).
- Programs/Scheduling adoption:
  `/home/skelly/dev/worktrees/program-hub-gh_537-event-stats-adoption`,
  branch `gh_537-event-stats-adoption`;
  [program-hub PR#1023](https://github.com/saga-ed/program-hub/pull/1023).
- Epic [I#536](https://github.com/saga-ed/soa/issues/536), shared reporting I#535,
  adoption I#537, Vishnu receiver/UI I#538. Child SOA PRs: #540, #541, #542;
  inspect their integration/base state before deciding what to merge.
- [Synthetic validation/release notes](claude/projects/gh_536/docs/synthetic-event-stats.md).
- [Participant and binding inventory](claude/projects/gh_537/research/participant-inventory.md).
- [Dev operations](infra/vishnu-api/OPS.md) and
  [deployment evidence](claude/projects/gh_538/docs/dev-deployment-2026-10-23.md).
- [Hosted backend](apps/node/vishnu-api/README.md),
  [frontend](apps/web/vishnu/README.md).

## Already deployed — do not recreate

https://vishnu.wootops.org is live in dev account `396913734878`, us-west-2,
cluster `dev-shared-arm`. One ARM64 Node container serves the static SvelteKit UI
and SOA ExpressServer/tRPC backend. JANUS protects both assets and API endpoints;
there is no hosted auth bypass. Real staff login and dev Datadog data were verified.

Stacks: `soa-vishnu-api-bootstrap-dev`, `soa-vishnu-api-blue-routing`,
`soa-vishnu-api-green-routing`, `soa-vishnu-api-blue`, `soa-vishnu-api-green`.
All were CREATE_COMPLETE. Blue runs one healthy task; green is idle at zero.
The live rule at priority 4015 is outside CFN, blue=100/green=0. Header preview
rules at 2/18 are CFN-owned and must remain. Registry:
`infra/bluegreen-services.json`. Recheck live state before acting.

Deployed runtime: `9c4b699a56debd3c6d0ffffb837649aca687ff50`;
ECR `396913734878.dkr.ecr.us-west-2.amazonaws.com/soa/vishnu-api:9c4b699a`,
digest `sha256:0e7bbb1025d90eb89a00ec33a736eb05142df5b84445b4c384b511a2bfb4435b`.
Later commits add CI/operations records and ongoing core changes; they are not
necessarily deployed. No production deployment was made.

JANUS dev host: `gate.wootops.org`; ALB has the matching wildcard certificate.
Route53 zone: `Z07700453LJ7LUSAA9XZ6`. CloudFormation `saga-waf-dev` reports the
completed ALB association; direct WAF reads were denied even to PlatformInfra.
Do not request Admin or weaken authentication to work around read permissions.

Datadog secrets already exist in dev: `datadog/api-key/default` and
`soa/vishnu/dev/datadog-app-key`. ARNs are in samconfig; values must never enter
git, output, frontend bundles, command arguments or this handoff. The dedicated
application key has apm_read/timeseries_query/monitors_read; Actions API disabled.
It is currently user-owned. Application credentials are separate from agent MCP.

## What is not live

- Shared telemetry package candidates are not released. On the 2026-10-23
  registry check: stats absent, consumer latest stable 0.1.0, outbox 0.2.0.
  Recheck registry before assigning versions.
- Branch candidates already have stats **0.1.0**, consumer **0.2.0**, outbox
  **0.3.0**. Do not bump again mechanically or overwrite an existing version.
- Adopter PRs are drafts. Local synthetic builds used selective workspace links;
  generated local override/lockfile changes were intentionally excluded.
- Hosted `VISHNU_MQ_ENABLED=false`; no cloud receiver PostgreSQL/broker wiring.
- Existing hosted topology was recent APM adjacency only. Codex is adding a
  source-declared baseline. This improves visibility but does not enable MQ.
- Publishing SOA does not rebuild or instrument consumers automatically.
- No Vishnu GitHub deploy role/workflow exists; dev bring-up was manual.
  Hosted auth/browser validation is in Package CI, not a deployment workflow.

## Decisions required before an executable MQ rollout

1. **Scope:** Datadog currently uses explicit environment-wide scope because
   trace series lacked deployment.identifier. `loadConfig` rejects enabling MQ
   in this mode: the receiver/UI were built for an exact deployment scope.
   Design an environment+broker+vhost view that retains deployment/revision/
   instance/epoch identities, or another explicitly approved scope model.
   Do not silently broaden existing validation, relabel colours, merge dev/prod,
   or double-count process restarts/colour transitions. Preserve inactive-colour
   business-worker gates. Test the chosen model through receiver and UI.
2. **Durability and ownership:** provision a dedicated telemetry PostgreSQL
   store/schema, migration ownership and bounded retention, plus receiver
   credentials/network access. Define ingestion ownership across blue/green:
   competing consumers must not leave either read API with an incomplete view.
3. **Broker isolation:** preserve publisher-owned exchanges; use the dedicated
   routing key `observability.event_stats.reported`. Vishnu owns separate
   telemetry queues/bindings, never business queues. Audit the *actual dev*
   wildcard bindings. The synthetic audit is not evidence for cloud bindings.
   Existing credentials do not imply per-service permission isolation.
4. **Topology/mapping:** map report service/exchange/queue/consumer identities to
   hosted nodes without guessing, including `saga_dash` and `connectv3-api` IDs.
   Source-declared links are not traffic. Counts cannot establish queue backlog,
   broker confirmation, end-to-end success or causal HTTP edge latency.
5. **Activation and rollback:** approve per-service flags, full identity values,
   rollout order, expected overhead, observation duration and stop thresholds.
   Define how to disable reporters without altering business messaging.

## Proposed gated release sequence — approval required

1. Review the above decisions and concrete PRs. Re-run synthetic contract,
   pipeline, restart, duplicate, rollback and failure-isolation tests after any
   scope/receiver changes. Keep reporting off by default.
2. Merge only the reviewed SOA release changes after approval. Verify complete
   workspace runtime dependency closure: envelope/logger/rabbitmq/etc. may also
   need an approved release. Publish dependencies first, then consumer/outbox,
   then stats, following actual dependency order. Keep existing adopter envelope
   compatibility: fleet Zod 3 versus SOA Zod 4 was handled through a structural
   parser boundary, not by upgrading every package in the fleet.
3. Use manual `.github/workflows/publish-codeartifact.yml`, one `single_package`
   at the committed version. Run its dry-run/preflight first; keep tests enabled.
   Main merge does not publish. Branch prereleases require explicit approved
   `-dev.N` versions/ref. Verify published artifacts and dependency resolution.
4. In adopter worktrees, remove only the three telemetry local overrides, pin
   published versions, regenerate registry lockfiles, and prove frozen installs,
   builds and CI. Inspect diff for unrelated changes. Rostering broad checks
   previously hit a native tool crash; that gate must be resolved/reverified.
5. Deploy and validate receiver infrastructure first (after approval), with no
   reporters enabled. Validate durable restart/replay, expiry, scope rejection,
   permissions and failure isolation. No synthetic traffic into business queues.
6. Merge approved adopter PRs with reporting disabled. Relevant main changes
   trigger their dev CI deployments. **Program-hub PR#1023 changes both Programs
   and Scheduling**, and shared lockfile changes may trigger additional service
   workflows: inspect current path filters and dependency-closure detection.
   Do not promise a one-service deployment unless the plan actually guarantees it.
7. Verify normal API/outbox/consumer operation, then enable IAM, Programs and
   Scheduling in approved, observed steps. `EVENT_STATS_ENABLED=true` requires
   environment, deployment, revision, broker, vhost and RABBITMQ_URL; invalid
   enabled configuration fails startup. The adoption PRs alone do not supply
   hosted enablement. Defaults are opt-in (false unless exactly `true`).
8. Check startup/idle heartbeats, attributable roles, duplicate versus committed
   work, rates, freshness, reporter failures, restart persistence and colour
   transitions in Vishnu. Verify business latencies/error rates/queue behavior
   remain at baseline. Soak for the explicitly approved duration.
9. Production requires a separate reviewed plan and approval after dev evidence.
   Do not reuse dev ARNs, priority assumptions, credentials or deployment scope.

Rollback: disable reporters first; if business operation regresses, restore the
previous immutable service image/approved colour. Stop or revert receiver/UI
independently. Preserve durable evidence where appropriate; never delete business
queues/data or overwrite published package versions to roll back.

## Build and operations cautions

Use Node 24/pnpm 9. From the SOA worktree:

```sh
pnpm exec turbo run build --filter=@saga-ed/vishnu-api^...
pnpm --filter @saga-ed/vishnu-api check-types
pnpm --filter @saga-ed/vishnu-api test
pnpm --filter @saga-ed/vishnu-api build
pnpm --filter @saga-ed/vishnu check-types
pnpm --filter @saga-ed/vishnu test
pnpm --filter @saga-ed/vishnu build
pnpm --filter @saga-ed/vishnu-api test:browser
```

ARM64 Dockerfile: `apps/node/vishnu-api/Dockerfile`. CodeArtifact credentials use
BuildKit `--secret id=npmrc,src=...`, never build arguments. ECS injects Datadog
secret values through the execution role. Task role has no application AWS rights.

`infra/vishnu-api/render-deploy-command.py` prints complete dev SAM commands;
it does not execute them. SAM CLI parameter overrides replace the whole configured
list, not individual entries. Existing stacks require reviewed UPDATE change sets,
not repeating initial CREATE steps. Preserve green desired count zero unless
explicitly deploying it for a cutover. Recheck shared listener priorities.

Use current Saga skills/profile guidance. Observer for ordinary reads, AppInfra
for service resources, PlatformInfra for shared DNS where authorized. No silent
Admin fallback. Current blue/green tooling behavior must be checked via help/source:
the bundled wheel previously lacked the command; a local iac checkout was used.
Do not follow its generic "retire CFN rules" warning for the intentional
header-gated blue/green preview rules. The live weighted rule remains outside CFN.

Synthetic viewer: http://127.0.0.1:11930, isolated set `gh536`, slot 3. Preserve it
and other agents' stacks. Neither its probes nor its broker-binding inventory
prove cloud deployment correctness. Do not restart unrelated services.

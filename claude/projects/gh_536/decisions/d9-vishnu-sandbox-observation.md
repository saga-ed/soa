# d9 — How hosted Vishnu observes a patch-party sandbox (dev)

PENDING — 2026-10-29

## Context

The next phase soaks updated iam-api, programs-api and scheduling-api branches in a
patch-party sandbox before they merge. **Success criterion:** hosted Vishnu runs
against a *deployed* sandbox of all three services with reporting enabled, and
visibly receives and renders reports from all three.

Today hosted Vishnu cannot see a sandbox at all:

- Sandboxed services set `EVENT_PREVIEW_TAG=<Identifier>` = `sandbox-<name>` and
  apply `applyPreviewTag` to all broker topology, including the reporter's
  `publisherExchange`. A sandbox named `gh537` publishes reports on
  `iam.events.sandbox-gh537`, `programs.events.sandbox-gh537` and
  `scheduling.events.sandbox-gh537`.
- The receiver binds only the untagged `iam.events`, `programs.events` and
  `scheduling.events` (`event-stats-receiver.ts`). The store accepts a report only
  when its service maps to the exact exchange it arrived on (`REPORTERS`), and only
  when `{environment, deployment, broker, vhost}` equals its scope (d3).
- Reports carry the deployment the adopter passes as `EventStatsDeployment`
  (default `main`). For the soak it is `sandbox-<name>`, so the d3 scope
  `dev / main` rejects them as well.
- soa has no `sandbox-deploy.yml`, so Vishnu cannot be a composition member
  (patch-party §4.7).

Constraints carried forward: d3's exact-scope rejection, and d1's rule that Vishnu
checks but never declares publisher exchanges.

## Options

1. **(a) An idle hosted colour observes one named sandbox.** A default-off setting
   (`EventStatsPreviewTag=sandbox-<name>`) makes that colour check and bind the
   tagged reporter exchanges, accept each service only on its own tagged exchange,
   and use `sandbox-<name>` as its exact MQ deployment. The live colour is untouched.
   - Small change (config, store, receiver, template parameter, label). No new
     infrastructure. One sandbox per colour at a time; APM stays environment-wide.
2. **(b) Vishnu as a real sandbox member** through a new soa `sandbox-deploy.yml`.
   - Needs a soa sandbox workflow, a per-sandbox Vishnu database, routing and
     target-group SSM paths, a JANUS host for a sandbox Vishnu, and the dispatch
     allowlist. Weeks of work, and none of it is needed to watch three reporters.
3. **(c) The live colour accepts several deployments** (d3 option 3: scope on
   `{environment, broker, vhost}` with deployment as a UI dimension, binding tagged
   exchanges dynamically).
   - Reopens d3, changes the live view, and needs exchange discovery (or a list)
     plus double-counting tests. More than the soak needs.
4. **(d) Sandboxed reporters publish untagged, as `deployment=main`.**
   - No Vishnu change, but sandbox reports would mix into the live dev view, and
     an untagged exchange in a sandbox breaks the §4.2 topology isolation. Rejected.

## Recommendation

**Option (a)**, on idle **blue**. Confidence: high that it meets the success
criterion. Medium on the shared-store note below, which is acceptable for a soak.

Implemented on branch `gh_538-vishnu-sandbox`, default off. With the setting absent,
the task definition, `/config.json`, queue arguments, bindings and status label are
unchanged (covered by tests).

### What must be true at the end (sandbox `gh537`)

- **Colour:** blue (`soa-vishnu-api-blue`), image from this branch, `DesiredCount=1`.
  Green stays live on rule 4015 with `dev / main`, unchanged.
- **Blue's scope:** `{environment: dev, deployment: sandbox-gh537, broker:
  shared-dev-mq, vhost: /}`. `VISHNU_MQ_PREVIEW_TAG=sandbox-gh537`, which must equal
  `EVENT_STATS_DEPLOYMENT` (enforced in code, by a template Rule, and in the renderer).
- **Queue:** `vishnu.sandbox-gh537.event-stats.v1` and its `.invalid` DLQ. Same
  bounds as main (10,000 messages, 1h TTL), plus `x-expires` of 24h, so both queues
  delete themselves a day after blue stops consuming.
- **Bindings:** routing key `observability.event_stats.reported` only, on
  `iam.events.sandbox-gh537`, `programs.events.sandbox-gh537` and
  `scheduling.events.sandbox-gh537`. They are checked, never declared (d1). Until
  the sandbox services have declared them, the receiver retries with backoff.
- **Store:** `iam-api` is accepted only from `iam.events.sandbox-gh537`, and the same
  for the other two. Reports with `deployment=main`, another sandbox, or another
  service are rejected and counted in `receiver.rejected`.
- **UI** (through `x-saga-preview-vishnu-api: blue`): status line reads
  `MQ telemetry (dev / sandbox-gh537 · patch-party sandbox; APM stays dev-wide)
  connected`. The iam-api, programs-api and scheduling-api nodes show **Live**
  MQ counters from fresh sandbox reports. The APM topology and latency are still the
  environment-wide Datadog view, not the sandbox's.

### Adopter-side pieces Vishnu depends on (not edited here)

Neither gh_537 branch's `sandbox-deploy.yml` passes event-stats parameters yet. Each
template already declares them (default off). Per component, the sandbox deploy
must add to `service-parameter-overrides-json`:

```json
"EventStatsEnabled": "true",
"EventStatsBroker": "shared-dev-mq",
"EventStatsDeployment": "${{ needs.config.outputs.identifier }}"
```

(`EventStatsVhost` defaults to `/`. The identifier is `sandbox-<name>`.)

- **rostering** (`/home/skelly/dev/worktrees/rostering-gh_537-event-stats-adoption/.github/workflows/sandbox-deploy.yml`):
  the iam-api deploy job only.
- **program-hub** (`/home/skelly/dev/worktrees/program-hub-gh_537-event-stats-adoption/.github/workflows/sandbox-deploy.yml`):
  only when `inputs.service` is programs-api or scheduling-api. The sessions-api
  and content-api templates don't declare these parameters, and CloudFormation
  rejects unknown parameters.
- Gate the three keys behind a new dispatch input (for example `event-stats`,
  default `'false'`) so merged sandbox deploys stay off. A composition cannot pass
  per-service inputs (microservices#764), so dispatch these components directly
  (patch-party §5 workaround), or default the input on for the soak branch only.
- The adopter templates' `EventStatsRequiresScope` Rule needs `Lane=none`, which
  sandboxes already use.
- Before enabling, run the d5 binding audit against the sandbox exchanges.
  `claude/projects/gh_536/scripts/broker-binding-audit.py` already matches the
  `*.events.<tag>` exchanges.

### Accepted trade-offs

- **One store for both colours (d4):** sandbox rows sit in the same
  `event_stats_source` table as green's. `source_key` includes deployment and
  `read()` filters by exact scope, so neither colour shows the other's rows. They
  do share the 256-source cap and the 24h retention. Three services with a few
  instances each are far below the cap.
- **One sandbox per colour.** Observing another sandbox means redeploying blue.
- **The APM view is not sandbox-scoped.** The label says so.

## Related artifacts

Paths under `/home/skelly/dev/soa/` refer to branch `gh_538-vishnu-sandbox`.

- `/home/skelly/dev/soa/apps/node/vishnu-api/src/telemetry/event-stats-store.ts` (`mqPreviewTag`, `reporterExchanges`, store exchange gate)
- `/home/skelly/dev/soa/apps/node/vishnu-api/src/telemetry/event-stats-receiver.ts` (`exchanges`, `queueArguments`)
- `/home/skelly/dev/soa/apps/node/vishnu-api/src/telemetry/event-stats-runtime.ts`
- `/home/skelly/dev/soa/apps/node/vishnu-api/src/config.ts`
- `/home/skelly/dev/soa/apps/web/vishnu/src/lib/graph/event-stats.ts` (`hostedMqScope`, `hostedMqLabel`)
- `/home/skelly/dev/soa/infra/shared/service-template.yaml` (`EventStatsPreviewTag`, `SandboxObservationIsExact`)
- `/home/skelly/dev/soa/infra/vishnu-api/OPS.md` (§ Observing a patch-party sandbox)
- `/home/skelly/dev/soa/packages/node/event-envelope/src/preview-tag.ts`
- `/home/skelly/dev/worktrees/rostering-gh_537-event-stats-adoption/infra/iam-api/service-template.yaml` (`EventStats*` parameters; `EVENT_PREVIEW_TAG` = `Identifier`)
- `/home/skelly/dev/worktrees/program-hub-gh_537-event-stats-adoption/infra/programs-api/service-template.yaml`, `/home/skelly/dev/worktrees/program-hub-gh_537-event-stats-adoption/infra/scheduling-api/service-template.yaml`
- `/home/skelly/.claude/plugins/cache/saga-tools/saga-iac/1.22.0/skills/patch-party/SKILL.md` (§2, §4.2, §4.7, §5)
- [d1](d1-event-stats-routing.md), [d3](d3-mq-scope-model.md), [d4](d4-receiver-store-and-colour-ownership.md), [d5](d5-broker-isolation-and-audit.md), [d7](d7-activation-and-rollback.md)

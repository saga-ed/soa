# d3 — MQ telemetry scope model for hosted Vishnu (dev)

RESOLVED — 2026-10-28

User ruling: "Option 2". Datadog stays environment-wide; MQ gets its own exact
scope `{environment: dev, deployment: main, broker, vhost}`. `config.ts:37` is
changed explicitly to allow this, the UI labels the two scopes separately, and
IAM, Programs and Scheduling report `EVENT_STATS_DEPLOYMENT=main` in dev.

## Context

Hosted Vishnu (dev) runs with `VISHNU_DATADOG_SCOPE=environment` because dev trace
series carry no `deployment.identifier` tag, so a deployment-scoped Datadog query
returns nothing. `apps/node/vishnu-api/src/config.ts:37` refuses `VISHNU_MQ_ENABLED=true`
in that mode and requires `EVENT_STATS_ENVIRONMENT` and `EVENT_STATS_DEPLOYMENT` to
equal Vishnu's own Datadog scope. The receiver (`event-stats-store.ts:52`) accepts a
report only when `environment`, `deployment`, `broker` and `vhost` all equal its
scope, and names its queue `vishnu.<deployment>.event-stats.v1`. MQ cannot be
enabled until the scope model is chosen.

Each report also carries `service`, `revision` and `instance` (default
`hostname:pid`), so processes, revisions and colour transitions stay distinguishable
under a single deployment value. In dev, PR previews publish to preview-tagged
exchanges (`applyPreviewTag`), so the main dev exchanges carry only the shared dev
mesh's traffic.

## Options

1. **One shared value for both MQ and Datadog.** Set `VISHNU_DATADOG_SCOPE=deployment`
   and give Vishnu and every reporter the same `deployment` value.
   - No code change: the existing gate passes.
   - The live APM view goes empty, because no dev trace has a matching
     `deployment.identifier`. That regresses what is deployed today.
2. **Separate scopes: Datadog stays environment-wide, MQ gets its own exact scope.**
   Datadog keeps `environment` scope. MQ uses `{environment: dev, deployment: <one
   shared dev-mesh value>, broker, vhost}`, configured independently. IAM, Programs
   and Scheduling report that same deployment value.
   - Small, explicit code change: `config.ts:37` allows environment-wide Datadog with
     an exact MQ scope, still requiring the same `environment`. The UI labels the two
     scopes separately, so nobody reads APM and MQ counts as the same population.
     Tests cover config, receiver rejection and UI labelling.
   - Keeps today's APM view and the receiver's exact-match safety. Colour and
     revision identity is kept per report.
3. **Environment + broker + vhost view, with deployment as a dimension inside it.**
   The receiver scopes on environment, broker and vhost and accepts several
   deployments, grouping them in the UI. This is the model the handoff describes.
   - Most flexible; ready for previews or multiple meshes in one view.
   - Largest change: store scoping, queue naming, UI grouping, and new tests for
     double counting across deployments. Nothing in dev needs it yet.
4. **Tag dev traces with `deployment.identifier` fleet-wide**, then use option 1.
   - Cleanest end state, but it is fleet observability work outside this initiative.

## Recommendation

**Option 2**, with the shared deployment value `main` (the dev mesh fed from
`main` merges). It is the smallest change that keeps today's APM view working,
leaves the receiver's exact-match rejection in place, and keeps colour, revision and
instance identity. Options 3 and 4 stay open for prod or a later multi-mesh need,
and report payloads don't change either way. Confidence: medium-high. The main
uncertainty is whether the UI's scope labelling needs more than a label (to verify
in implementation).

This replaces the earlier plan wording ("keep exact deployment scope; no code
change"), which missed that a shared value would empty the APM view.

## Related artifacts

- `/home/skelly/dev/worktrees/soa-gh_536-event-telemetry/build-and-deploy.md` (§ Decisions required, item 1)
- `/home/skelly/dev/worktrees/soa-gh_536-event-telemetry/apps/node/vishnu-api/src/config.ts` (lines 28–37)
- `/home/skelly/dev/worktrees/soa-gh_536-event-telemetry/apps/node/vishnu-api/src/telemetry/event-stats-store.ts` (line 52)
- `/home/skelly/dev/worktrees/soa-gh_536-event-telemetry/apps/node/vishnu-api/src/telemetry/event-stats-runtime.ts` (lines 18–27)
- `/home/skelly/dev/worktrees/soa-gh_536-event-telemetry/packages/node/event-stats/src/service.ts` (lines 72–79)
- [d1](d1-event-stats-routing.md) (routing and exchange ownership)

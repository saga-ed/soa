# Vishnu chat charts — first-release scope and saved views

**Status: RESOLVED 2026-11-05 — chart experience and Datadog historical-source direction agreed; remaining architecture choices are open.**

**Initiative:** [RabbitMQ event telemetry and Vishnu](../README.md).

## Context

Vishnu Chat should assemble charts from natural-language requests, including CPU
and memory for IAM over thirty minutes and latency investigations over a week.
On 2026-11-05 skelly answered the first-release clarification questions below and
requested a data-architecture conversation before implementation proceeds.

## Decisions

1. **Include histograms and scatter plots in the first release**, alongside line
   charts and Datadog drill-through links. Do not defer their UI functionality to a
   later release. Empty states are acceptable until suitable observations have
   accumulated; do not manufacture data or imply that collection already exists.
   A request-latency histogram requires distribution observations, not just an
   average and maximum. Empty charts must explain the missing evidence.
2. **Charts may take priority over the mesh.** It is acceptable for the mesh to
   minimize while a chart investigation is active. Users must be able to pin a
   created set of charts and persist that view across sessions. Persistence is a
   first-release requirement, not merely an in-memory chat feature. Saved-view
   storage remains to be settled in the architecture discussion.
3. **Keep chart queries within the currently selected, authorized scope.** Chat
   must request an explicit scope switch before querying another environment or
   deployment. Do not silently broaden a query to obtain data. Existing sources
   can have different declared scope granularity (for example environment-wide
   APM versus sandbox MQ); disclose that difference and do not present it as
   exact deployment attribution.
4. **Rely on Datadog for historical measurements.** In the architecture discussion,
   skelly stated: "I don't want to rebuild datadog locally" and chose reliance on
   Datadog availability as the historical-source direction. Vishnu will not build
   a parallel metrics warehouse or mirror Datadog history for offline availability
   as part of this release. Historical chart coverage depends on what is collected,
   retained, scoped and accessible in Datadog. Saved chart definitions remain
   Vishnu-owned application data, distinct from measurement history.
5. **Saved views are personally owned and private in the first release.** Skelly
   chose "personal ownership by default, saved views private initially". Persist
   chart sets against the authenticated staff identity and enforce ownership on
   listing, reading, updating and deleting them. No sharing, public links or
   cross-user view access in the initial release. Reopening a saved view does not
   bypass the user's current telemetry authorization or the explicit scope-switch
   rule. Sharing may be considered separately later.
6. **Saved time ranges are rolling by default, with an explicit fixed-window
   option.** Skelly approved both modes. A saved "last 30 minutes" view resolves
   against the current time when reopened. A fixed incident view preserves its
   start/end timestamps and queries Datadog for that interval. Fixing the window
   does not archive measurements or guarantee that they remain available beyond
   Datadog retention. Persist the mode explicitly so reopening cannot silently
   change a rolling view into a fixed one, or vice versa.

## Architecture discussion required

Saga's mesh uses event-driven projections. Discuss how Vishnu should follow that
pattern for mesh state and saved investigations while Datadog supplies historical
measurements. Remaining choices include saved-view storage, query caching and
outage presentation, and how any missing MQ or other
historical signals should reach Datadog. No new collector, event schema, broker
topology or retention policy has been selected.

The prior proposal was reusable chart components driven by a validated chart
specification, rather than executable code generated at runtime. ECharts was a
candidate library. Neither the library nor a specific persistence implementation
is made binding by this decision.

The discussion should distinguish saved chart definitions from measurement history,
current-state projections from historical time buckets/distributions, durable
business events from best-effort telemetry snapshots, and recoverable history from
data that was never collected. The existing latest-report MQ store is not a
historical chart store or an unlimited replay log.

## Related artifacts

- [Telemetry pipeline](../../vishnu/docs/02-telemetry-pipeline.md)
- [Existing store and colour ownership](d4-receiver-store-and-colour-ownership.md)
- [Source scope model](d3-mq-scope-model.md)
- [Performance telemetry semantics](vishnu-performance-telemetry.md)

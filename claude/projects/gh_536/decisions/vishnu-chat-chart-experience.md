# Vishnu chat charts — first-release scope and saved views

**Status: RESOLVED 2026-11-05 — chart experience, historical source, private saved views and architecture recommendations approved by skelly.**

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
   storage follows decision 7 below.
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
7. **Use the existing Vishnu Postgres database for saved investigations.** Skelly
   accepted the remaining architecture recommendations. Store private chart
   definitions, layout, scope and time settings as Vishnu-owned application data.
   Saving a view is a normal database transaction; an event/outbox workflow is not
   needed unless another service later needs to consume the change.
8. **Keep mesh state in the existing event projections and query historical
   measurements through the Vishnu backend.** Use a bounded, short-lived query
   cache. Report stale cached measurements or unavailable data explicitly during
   a Datadog outage. Saved definitions remain accessible independently of Datadog;
   the cache is not a durable historical store or an offline-availability promise.

## Implementation boundaries

Saga's event-driven projections remain the mesh-state mechanism; Datadog supplies
historical measurements. Implementation must verify actual metric coverage,
permissions and scope tags, and choose bounded cache/query limits. Missing MQ or
other historical signals require a collection-gap assessment before choosing how
they should reach Datadog. No new collector, event schema, broker topology or
retention policy is implicitly authorized by the saved-view architecture.

The prior proposal was reusable chart components driven by a validated chart
specification, rather than executable code generated at runtime. ECharts was a
candidate library. Library selection and database schema details remain engineering
choices within the approved architecture.

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

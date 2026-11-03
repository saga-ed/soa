# Path endpoint rankings — implementation handoff

The user authorized concurrent implementation, real synthetic traffic, and testing
in synthetic-dev followed by the existing blue sandbox. Production and changing
the normal hosted route are not part of this release.

## Code to integrate

Hosted release: `9fbaf0b63f45f403f736a0e46f45bd3b7dd1d6a2` on local validation
branch `gh538-performance-validation`, based on sandbox revision `246cbc40`.
Worktree: `/home/skelly/dev/soa/.claude/worktrees/gh538-performance-validation`.
The ordered new commits are `bbc01c01`, `f5211f96`, `8ebfad73`, `9fbaf0b6`.

Synthetic source: `/home/skelly/dev/worktrees/soa-gh_536-event-telemetry`,
branch `gh_536-event-telemetry`, application revision `2b8b6e09`.
The complete Vishnu web/API trees are identical to the hosted release. The
synchronization preserves unrelated epic changes and infrastructure history.
Commits are local; no branch push, PR merge or production rollout was performed.

## User behavior and measurements

Select Slow, Hot or Fan-out and click a directed HTTP path. The inspector ranks
endpoint names for that caller→callee pair. The top-right gear sets N (default 5,
range 1–50); browser local storage preserves it across reloads. N changes display,
not collection cost. The graph labels use attributable path evidence too.

Slow ranks retained outgoing-client p95; Hot ranks retained outgoing-client counts.
Fan-out ranks calls per sampled same-source parent server request traversing the
path, with parent endpoint, denominator and maximum shown. These are bounded
retained observations, not population traffic totals or fleet-wide rankings.

The reader unions bounded count/p95 endpoint aggregate rankings, searches recent
client spans and retrieves at most five distinct traces. JSON uint64 identifiers
are preserved exactly before parent joins. Truncated, restricted and unusable
traces are rejected. Cache duration is 180 seconds; freshness is 300 seconds.
Search plus retrieval is bounded to six seconds so missing fan-out does not
exceed the UI timeout and hide other APM evidence.

## Synthetic evidence

The driver sent 1,252 authenticated loopback GET requests across baseline, burst
and mixed profiles; all succeeded. It uses existing data and does not reseed,
reset or write domain records. See [traffic evidence](../research/performance-telemetry-validation.md).

Real browser checks at port 11930, without mocked API responses, verified:

- Programs → IAM permissions endpoint: 18.45 ms retained p95 and 20 retained calls.
- Path Hot label: 21 retained client spans across returned endpoints.
- Five usable traces: permissions called five times across five sampled
  `programs.list` parent requests, mean/max one call per parent.
- N updated immediately, persisted across reload, and did not change the path.
- Graph path selection and measured labels; no browser errors.

A caught integration mismatch required restoring synthetic MQ subscriptions to
IAM, programs and scheduling. Hosted continues to subscribe to all eight known
reporters. No publisher exchanges were declared. After the fix the local receiver
connected, its queue had one consumer and zero ready/unacknowledged messages.

Validation: 42 API tests, 62 web tests, seven driver tests, API/web type checks,
production builds, Datadog/ranked-inspector browser checks and local signed-session
hosted browser regression. The build retains the existing large-chunk warning.

Run traffic from any directory:

```sh
node /home/skelly/dev/worktrees/soa-gh_536-event-telemetry/apps/web/vishnu/scripts/synthetic-traffic.mjs --slot 3 --profile mixed --duration 60
```

An existing slot-3 synthetic login cookie is required. The driver bounds request
count, concurrency and duration and keeps authentication data out of output.

## Hosted validation

Blue deployed successfully on 2026-11-03 UTC (November 2 Mountain time).
CloudFormation reached `UPDATE_COMPLETE`; the service has one healthy task on
revision `9fbaf0b63f45f403f736a0e46f45bd3b7dd1d6a2` and task definition `:7`.
The exact ECR digest is
`sha256:184f160aad4044631edbd18305cdb326855cec2d709176b41cb050b2087acdaf`.

The change set used the previous template and changed only `ImageArn` and
`BuildRevision`. Final comparison verified every other blue parameter (including
resolved SSM values), green's parameters/service, and live routing unchanged.
Blue retains `sandbox-gh537` MQ scope; APM remains environment-wide `dev`.
Green remains the normal route at weight 100; blue is weight 0.

Access blue at `https://vishnu.wootops.org/` with header
`x-saga-preview-vishnu-api: blue`. The normal URL without this header serves green.
Blue `/health` and `/health/ready` returned HTTP 200 with the new revision and
`runtime.ready=true` (including MQ connectivity). Green remained healthy at
`1509871278a3d03a95d39b351093d622498febc0`. Unauthenticated UI requests redirected
to JANUS, and telemetry HTTP/tRPC requests returned 401. The new container had
healthy status and no startup warning/error log events.

After refreshing an expired synthetic login, a final bounded mixed run completed
502 requests with zero failures at 00:14:57–00:16:01 UTC. The refreshed reader at
00:17:12 UTC returned three path endpoints and five usable traces. Programs→IAM
permissions had 21 retained calls and 8.63 ms p95. The preceding expired-cookie
preflight stopped on 401 before generating workload, as intended.

Read-only hosted Datadog queries returned attributable endpoint measurements.
The inspected hosted trace sample lacked source server parent requests, so its
fan-out denominator was unavailable; the UI must not manufacture one.

Authenticated deployed browser validation requires the user's JANUS browser
session. The browser host was unavailable during this work. A local signed-session
harness is regression evidence only; it is not proof of deployed authentication.

Direct cross-Claude messaging is not available in this tool session. This committed
handoff provides exact local refs for the Claude deployment/maintenance agent.

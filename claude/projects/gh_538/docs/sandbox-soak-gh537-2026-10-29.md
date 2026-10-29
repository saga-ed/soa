# Sandbox soak `sandbox-gh537` — Vishnu observing deployed, reporting APIs (dev)

Started 2026-10-29. Approved by skelly ("Approve the sandbox soak"). Decisions d8, d9.
Manifest: [`claude/projects/gh_536/patch-party.json`](../../gh_536/patch-party.json).

## Success criterion: met 21:43Z

Hosted Vishnu **blue** (`soa-vishnu-api-blue`, image `soa/vishnu-api:3db18670` from draft
soa PR#556, digest `sha256:8087e4b6ee7fbdac22b1a1f6bb0d483d5e15bcd834ed13923501354d26963a87`)
stores fresh reports from all three sandboxed services in scope
`dev / sandbox-gh537 / shared-dev-mq / /`:

| Service | Revision | Reports | Streams | Fresh at |
|---|---|---|---|---|
| iam-api (rostering) | `3b552682` | 55 | 1 | 21:43:35Z |
| programs-api (program-hub) | `40adb410` | 10 | 30 | 21:43:33Z |
| scheduling-api (program-hub) | `40adb410` | 12 | 11 | 21:43:48Z |

Live dev traffic stayed on green `15098712` (rule 4015 unchanged). Green's own queue
`vishnu.main.event-stats.v1` kept its single consumer.

## Steps and evidence

1. **Preflight** (patch-party §4): 4.9 dispatchable ✓; 4.1 service-scoped TG path ✓;
   4.2 RabbitMQ topology all `applyPreviewTag`-ed ✓; 4.4 `canonical` legal ✓; 4.7/4.8 ✓.
   4.2 finding: program-hub sets no `PREVIEW_ORIGINATE_MAP` and points `IamApiUrl` at
   shared dev, so sandbox programs-api background IAM calls reach shared dev IAM
   (existing behaviour; writes need program or pod changes; the soak drives no traffic).
2. **Sandbox deploys** (`sandbox-deploy.yml`, direct dispatch, `event-stats=true`, TTL 72h):
   rostering 40952814226; program-hub 40952819659 and 40952823878, then re-dispatched
   as 40958579752 and 40958584192 after the template fix below. Identity probes with
   `x-saga-preview-<svc>: sandbox-gh537`: iam-api `/health/ready` ready (iam, PII DBs
   connected); programs-api and scheduling-api `/health` at the branch head (their
   `/health/ready` is behind JANUS).
3. **Defect found and fixed:** program-hub's `dev` and `prod` samconfig stanzas deploy
   `infra/shared/service-template.yaml`, not the per-service templates, so the first
   program-hub sandbox stacks had no `EventStats*` parameters. Moved the wiring to the
   shared template (program-hub `40adb410`); both stacks now carry
   `EventStatsEnabled=true`, broker `shared-dev-mq`, deployment `sandbox-gh537`.
4. **d5 binding audit re-run** (read-only credential `shared-dev-mq-readonly`, in memory
   only): 550 bindings. The only report-key matches outside DLQ `#` bindings are
   Vishnu's own `vishnu.main.event-stats.v1` bindings. No business consumer.
5. **Blue observer:** reviewed change set (blue task definition revision 2 and service
   only). Queue `vishnu.sandbox-gh537.event-stats.v1`: quorum, 1 consumer, bound only to
   `observability.event_stats.reported` on `{iam,programs,scheduling}.events.sandbox-gh537`,
   `x-expires` 24h, `x-max-length` 10,000, TTL 1h.

## Still open

- UI check through a real JANUS session: open vishnu.wootops.org with request header
  `x-saga-preview-vishnu-api: blue` (e.g. a header extension). Expect the status line
  `MQ telemetry (dev / sandbox-gh537 · patch-party sandbox …)` and Live counters on
  the three nodes.
- Soak window (d7: 48h) and post-soak checks: reporter failures, broker connection
  count, and shared dev iam-api for writes originating from the sandbox.
- **Teardown (explicit; direct dispatches have no TTL sweep, microservices#713):** delete
  the three `*-sandbox-gh537` service stacks then routing stacks, tear down their
  db-host DBs (`skipSnapshotCheck`), verify clean (patch-party §6), and revert blue
  (`DesiredCount` and image back, or `VishnuMqEnabled=false`).

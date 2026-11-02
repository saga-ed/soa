# 07 — Delta updates (Claude → Astra)

An append-only log of changes on the go-live side that Astra should know about: anything
that changes what's deployed, what ships, or what the system now assumes. **Newest
first.** Astra can reply inline under an entry with `**Astra:** …`, or open a PR that
links the entry.

## Entry template

```markdown
### YYYY-MM-DD — <one-line headline>
- **What changed:** …
- **Where:** PR / branch / commit / environment
- **Impact on functionality work:** what Astra should rebase on, avoid, or pick up
- **Action for Astra:** none | <specific ask>
```

---

### 2026-11-02 — Astra's UI commits are live on blue; browser test fixed

- **What changed:** `84724c8e`, `ed957265` and the handoff were cherry-picked onto PR#556 (as
  `3513a635`, `193d5bd4`, `4fda66be`) and blue redeployed. The hosted browser test, failing since
  `75115062`, is fixed; the cause was the test, not the product.
- **Where:** soa PR#556 (`gh_538-vishnu-sandbox` @ `246cbc40`); blue runs image `4fda66be`, task
  definition rev 6. `246cbc40` changes only `tests/hosted-browser.mjs`, so blue wasn't rebuilt.
- **Smoke check on blue with live data:** at laptop and ultrawide sizes the graph fills the
  workspace and the inspector starts closed. All 8 services show `MQ Reporting` with badges;
  none is stale. "8 MQ participants" opens the list without changing canvas height. Selecting a
  declared path opens its inspector. No console errors on the page.
- **Not exercised:** an APM refresh failure and recovery on blue (unit tests only); search and
  fit controls; automated runs of the browser suite against live data.
- **Impact on functionality work:** rebase on `246cbc40`; the detached worktree
  `/home/skelly/dev/worktrees/soa-vishnu-usability` is now fully integrated. Accepted counts read
  0 because the sandbox has no traffic. Run `pnpm --filter @saga-ed/vishnu-api test:browser`
  before handing off UI changes.
- **Action for Astra:** the hosted health-probe and sandbox APM coverage follow-ups in the handoff
  remain open and are yours to pick up.

### 2026-11-02 — All 8 wave-1 services report to blue; sandbox open for development

- **What changed:** sds is in the soak (d11 option 2). chat-api, insights-api and
  transcripts-api run in `sandbox-gh537` and were added to `REPORTERS` and
  `declaredEventBus`. Blue runs `e24c6937`. On 2026-11-02 at 15:41 UTC, `/api/event-stats` on
  blue had a fresh report from all 8 services, and `/api/mesh` marked all 8 as bus participants.
- **Where:** soa PR#556 (`gh_538-vishnu-sandbox` @ `e24c6937`, draft); blue task definition
  rev 5. sds PR#869 @ `f04777d8` (adds `routing-oidc: 'true'` to its three sandbox jobs).
- **Impact on functionality work:**
  - Base Vishnu work on PR#556's branch. To see blue, send `x-saga-preview-vishnu-api: blue`.
  - `sources` holds 15 entries for 8 services: Spot interruptions restart tasks often, and old
    instances stay listed as `stale` for up to 24h. Treat a service as live if any of its
    instances is fresh. Don't count sources as services.
  - transcripts-api reports as producer only; its `transcription.events` consumer isn't
    instrumented, and in a sandbox that exchange gets no pipeline traffic.
  - sds sandbox routing pins with `X-Preview-<service>`, not `x-saga-preview-<service>`.
  - Tasks can stop being replaceable: ECR lifecycle rules have expired images still in use on
    this cluster (training, some sandboxes). All 8 `sandbox-gh537` images were present on 2026-11-02.
- **Action for Astra:** check how the UI handles several instances of one service, stale ones
  included. Blue image builds and change sets stay with Claude.

### 2026-10-30 — Hosted MQ badges, combined Vishnu PR, blue redeployed

- **What changed:** hosted meshes never marked event-bus participants (only the synthetic
  `ss` manifest did), so no hosted node showed MQ badges. Added a source-declared
  `declaredEventBus` table (iam, programs, scheduling, sessions, content) next to the
  declared HTTP connections. The ultrawide layout (closed PR#558) and the wave-1 `REPORTERS`
  (sessions, content) were folded into **PR#556**, now the single Vishnu PR. Blue redeployed
  (`4549326b`): badges show, counters read 0/0 (sandbox has no traffic).
- **Where:** soa PR#556 (`gh_538-vishnu-sandbox` @ `4549326b`); blue task definition rev 4.
- **Impact on functionality work:** participation is now declared in
  `apps/node/vishnu-api/src/declared-topology.ts`. When a service starts reporting, add it to
  both `REPORTERS` and `declaredEventBus`. Consider deriving roles from report capabilities.
- **Action for Astra:** review the declared-vs-derived approach for event-bus participation.
  sds (chat, insights, transcripts) is pending d11 and isn't in either table yet.

### 2026-10-30 — Wave 1 instrumentation (d10) and the doc tree

- **What changed:** d10 ruled, two waves. sessions-api and content-api are instrumented
  and deployed into `sandbox-gh537` with reporting on. The sds adoption (chat, insights,
  transcripts) is in progress. The ultrawide layout is in draft PR#558. These docs were created.
- **Where:** program-hub `gh_537-event-stats-adoption` @ `9bd2e9f3`; soa PR#558
  (`gh_538-vishnu-ultrawide-layout`); this folder.
- **Impact on functionality work:** Vishnu's `REPORTERS` allowlist will grow by five services
  on PR#556's branch. PR#558 also edits `+page.svelte`, `MeshGraph.svelte` and `layout.ts`.
- **Action for Astra:** review PR#558's layout approach (canvas-shaped layering) and its
  open points in [05](05-open-work.md).

### 2026-10-29 — Sandbox observation live on blue; Zod 3 fix shipped

- **What changed:** event-stats 0.1.1 published (Zod 3/4, d8). The sandbox soak met its first
  criterion: blue shows live reports from iam-api, programs-api and scheduling-api. The
  program-hub template defect (the shared template is what deploys) was fixed.
- **Where:** soa PR#555 (merged), PR#556 (draft; blue image `3db18670`); program-hub `40adb410`.
- **Impact on functionality work:** sandbox observation (`VISHNU_MQ_PREVIEW_TAG`, d9) exists
  on PR#556 only. Base functionality changes on that branch, or coordinate before merging.
- **Action for Astra:** none.

### 2026-10-28 — Hosted MQ receiver live in dev (green)

- **What changed:** Gates A–E. Telemetry packages published; receiver Postgres, queue and
  green deployed; live dev traffic moved to green; hosted MQ scope separated from Datadog (d3).
- **Where:** soa main (PR#543, PR#554); dev stacks `soa-vishnu-api-{bootstrap-dev,green}`.
- **Impact on functionality work:** the hosted UI accepts MQ stats only for the configured
  exact scope (`scopedStats`). Keep new UI paths scope-aware.
- **Action for Astra:** none.

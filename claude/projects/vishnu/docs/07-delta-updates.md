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

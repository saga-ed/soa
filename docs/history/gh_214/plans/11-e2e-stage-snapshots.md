# M14 — Stage checkpoints: `e2e run --from <stage>` via per-stage snapshots (soa#214, tracker #221)

Progressive flows rebuild state the slow way: to work on stage 6 you replay Playwright
stages 1–5 every time. This plan adds **stage checkpoints**: opt-in snapshotting of the
DB state after each green stage, and `--from <stage>` to **restore** the predecessor
checkpoint and start Playwright at the named stage — turning a multi-minute UI replay
into a seconds-long `pg_restore`.

```bash
ss e2e run saga-dash/journey --headless --snapshot-stages     # bake: checkpoint after each stage
ss e2e run saga-dash/journey --from sessions                  # later: restore ckpt(schedule), run 6..N
ss e2e run saga-dash/journey --from 6 --through 7             # windows compose with --through
```

The feature is almost pure composition — both halves already exist and even anticipate
each other:

| Existing seam | Status | Where |
|---|---|---|
| Native snapshots: per-DB pg_dump/mongodump + manifest, restore-as-owner, schema-ahead guard, redis flush, per-slot roots | ✅ | `core/snapshot/*`, `runtime/snapshot-store.ts`, `runtime/snapshot.ts` (SnapshotIO seam) |
| Snapshot manifest RESERVES flow linkage: optional `flowId` + `systems` "(feeds the flow layer)" | ✅ | `core/snapshot/manifest.ts` |
| Stage addressing by id / number / project (`stageMatches`, powers `--through`) | ✅ | `core/flow/resolve.ts` |
| The exact insertion point: `executeResolvedFlow` step 2 "reset + seed (coupled; skipped …)" | ✅ | `e2e-orchestrate.ts:599` |
| Prerequisite recursion (connect-session ⇐ journey through 'schedule') — today a full replay | ✅ | `e2e-orchestrate.ts:571` |
| Per-slot snapshot roots + M13 `--set` threading (a set's checkpoints live in ITS slot's root) | ✅ | `derive-instance.snapshotsDir`, M13 parse injection |

## 1. Semantics

### 1.1 Baking (`--snapshot-stages`)

On `e2e run <spa>/<flow> --snapshot-stages` (progressive flows only), after each stage's
Playwright project exits 0, store a snapshot of the flow closure's DBs:

- **fixtureId**: `flow-<spa>-<flow>-s<phase>-<stageId>` (e.g. `flow-saga-dash-journey-s5-schedule`).
  Deterministic ⇒ re-baking OVERWRITES (checkpoints are cheap, disposable derivatives —
  no retention scheme; `snapshot delete` works on them like any fixture).
- **Scope**: the databases of the flow's (slot-filtered) closure — the same set the run
  reset. Reuses `storePlan` with `only: closureDatabases`.
- A stage that fails stops the bake (later checkpoints would be lies); earlier
  checkpoints from the same run remain valid.

### 1.2 Restoring (`--from <stage>`)

`--from <stage|number|project>` on a progressive flow:

1. Resolve the target stage via `stageMatches` (same addressing as `--through`).
   `--from` at stage 1 ⇒ plain run (nothing to restore). Non-progressive flow ⇒ error.
2. Locate the PREDECESSOR checkpoint `flow-…-s<N-1>-<id>` in the slot's snapshot root.
   Missing ⇒ pointed error listing the baked stages that DO exist + the bake command.
3. Validate compatibility (§2). Violations ⇒ hard error with a re-bake hint.
4. In `executeResolvedFlow`: up(closure) as today, then REPLACE step 2's reset+seed with
   `restorePlan` + SnapshotIO restore (+ redis flush — same as `snapshot restore`), then
   run stages N..through only.
5. `--from` composes with `--through` (a window), with `--set`/`--slot` (checkpoints are
   per-slot — a set bakes and restores in its own `snapshots-s<N>` root, zero sharing),
   and is mutually exclusive with `--skip-reset` (restore IS the state source).

### 1.3 Fast-follow consumer: prerequisites

`connect-session`'s `prerequisite: {flow: journey, throughStage: schedule}` currently
replays the whole journey. Once checkpoints exist, the prerequisite recursion checks for
a valid `flow-…-s5-schedule` checkpoint first and restores instead of replaying (flag:
`--prereq-from-snapshot`, default on once trusted). Same machinery, biggest single win.

## 2. Checkpoint identity & compatibility (the correctness core)

A checkpoint is valid input for `--from` only if the world still matches what produced
it. The manifest's optional flow block records, and restore-time validation checks:

```jsonc
"flow": {
  "spa": "saga-dash", "flow": "journey",
  "stageId": "schedule", "phase": 5,
  "prefixHash": "sha1(...)",          // §2.1 — flow-definition drift
  "occurrenceDate": "2026-07-06",     // §2.2 — date coherence
  "seedProfile": "roster",
  "spaHead": { "sha": "5ea7c876", "dirty": false },   // §2.3 — advisory only
  "bakedAt": "2026-07-04T16:20:00Z"
}
```

- **§2.1 prefixHash (HARD)**: sha1 over the JSON of stages `1..N`'s definitions
  (id/phase/project/spec/requiredSystems) + flow name + seed spec. Any edit to the
  producing prefix in flows.json invalidates downstream checkpoints. Pure function in
  `core/flow/`, unit-tested for stability (key order canonicalized).
- **§2.2 occurrenceDate (HARD, reused not re-clamped)**: journey state embeds dates
  (schedules, sessions, term windows) derived from `PLAYWRIGHT_OCCURRENCE_DATE`. A
  `--from` run MUST export the checkpoint's baked occurrence date — not today's clamp —
  so restored data and running specs agree. Refuse when the baked date is > 7 days old
  (staleness cliff; `--from-stale-ok` escape hatch). This is the subtle bit; §5 V2
  validates it across a real day boundary (bake with Monday-clamp on Saturday, restore
  Sunday).
- **schema-ahead guard (HARD, already built)**: `restorePlan`'s existing per-DB
  migration-head check runs unchanged — a checkpoint baked before a migration landed is
  refused, exactly like any snapshot restore.
- **§2.3 spaHead (WARN-only)**: SPA repo HEAD + dirty flag at bake time. Spec-code drift
  can't be hash-fenced cheaply (state depends on backend code too); a mismatch warns
  ("checkpoint baked at 5ea7c87, worktree now at f31c2a1 — re-bake if stages changed
  behavior"). Consistent with M13's warn-only branch-drift philosophy: checkpoints are a
  dev accelerant, not a correctness proof — the full un-checkpointed run stays the
  source of truth (and stays the default).

## 3. What restore does NOT capture (stated risks)

- **In-memory service state**: services keep running across the restore (same as
  `snapshot restore` today — its documented, working mode). Projection/cache staleness
  is possible in theory; V1 empirically gates this for journey. If a service proves
  cache-sticky, the fallback is a per-service bounce after restore (launcher already
  kill/relaunches by pidfile) — NOT in MVP.
- **Event plumbing**: outbox rows and `consumed_events` dedup tables live IN the DBs, so
  they restore coherently; an unshipped outbox row baked mid-flight could re-publish
  after restore — consumers are idempotent by design (dedup table), noted not solved.
- **Sessions/auth**: e2e mints fresh personas per run (cookie jar + devLogin) — nothing
  auth-shaped needs to survive the snapshot.
- **Redis**: flushed on restore (existing `redisFlushdb`), matching `snapshot restore`.

## 4. Milestones

### M14-A — Pure core: identity + planning (do first) — **S–M**
| Item | Effort | Notes |
|---|---|---|
| Manifest `flow` block (additive optional zod; keep schemaVersion) | S | `core/snapshot/manifest.ts` |
| `stagePrefixHash` + checkpoint fixtureId scheme + compat evaluator (pure: manifest×resolved-flow×today ⇒ ok/violations/warnings) | S–M | `core/flow/checkpoint.ts`; heavy unit coverage incl. date-cliff cases |
| `--from` resolution in `resolveFlow` (stage window: from..through; errors for stage 1 edge, non-progressive, from>through) | S | reuses `stageMatches` |

### M14-B — Orchestration: bake + restore paths — **M**
| Item | Effort | Notes |
|---|---|---|
| `--snapshot-stages`: post-stage store via SnapshotIO (storePlan scoped to closure DBs, overwrite semantics) | M | in `executeResolvedFlow`'s stage loop |
| `--from`: replace reset+seed with validate→restore→redis-flush; export baked occurrence date to Playwright env | M | the §1.2 path; FlowExecError on violations |
| Flag wiring + mutual exclusions (`--from`×`--skip-reset`), pointed missing-checkpoint error listing baked stages | S | `commands/e2e/run.ts` |
| Int tests: fake SnapshotIO records per-stage dumps; `--from` runs only stages N.. with restored env date; every compat violation path | M | mirror snapshot.int.test.ts harness |

### M14-C — Polish + the prerequisite win — **S–M**
| Item | Effort | Notes |
|---|---|---|
| Prerequisite-via-checkpoint (`connect-session` restores journey@schedule when valid) | S–M | biggest wall-clock win |
| `snapshot list` renders the flow block (flow/stage column); docs page `docs/e2e.md` + `docs/snapshots.md` cross-section | S | |
| Bake-freshness surfacing in `e2e list` (which stages of each flow have valid checkpoints) | S | nice-to-have |

### Explicit non-goals (this milestone)
Auto-bake by default (opt-in until date-reuse is trusted); cross-slot/cross-machine
checkpoint sharing (per-slot roots are the isolation story); checkpointing
non-progressive flows; hash-fencing backend code drift (§2.3 is warn-only by design).

## 5. Validation

- **V1 (correctness)**: bake `journey --through schedule --snapshot-stages` on slot 0;
  then `--from schedule` (restore ckpt s4-pods, run stage 5 only) must go green with NO
  stage 1–4 Playwright, and its stage-5 assertions see identical data (schedule page
  contents match the full-run baseline). Negative: edit stage 2's spec entry in
  flows.json ⇒ `--from schedule` refuses on prefixHash; roll a migration forward ⇒
  schema-ahead guard refuses.
- **V2 (date coherence)**: bake on day D (weekend ⇒ Monday clamp), `--from` on D+1:
  run must export the BAKED occurrence date and stage assertions must hold; a
  \>7-day-old checkpoint refuses without `--from-stale-ok`.
- **V3 (speed, the point)**: measure `--from sessions` wall-clock vs full replay
  through sessions — target: restore+verify ≤ 15s vs minutes of stages 1–5.
- **V4 (M13 synergy)**: bake inside `--set wta` (slot 1) — checkpoint lands in
  `snapshots-s1`, `--from` under the same set restores it, slot 0 checkpoints untouched.

## 6. Open questions for skelly

1. **Default-on baking?** Plan says opt-in `--snapshot-stages` until V2's date-reuse
   proves trustworthy, then flip progressive-flow default. OK to stage it that way?
2. **Staleness cliff**: 7 days + `--from-stale-ok` — right number?
3. **Naming**: `--from` (mirrors `--through`) vs `--resume-at`? Plan assumes `--from`.
4. Should `--from` with NO valid checkpoint offer to fall back to a full replay
   (`--from-or-replay`) for CI ergonomics, or always hard-error (plan assumes
   hard-error: silent replay hides the time regression the flag exists to kill)?

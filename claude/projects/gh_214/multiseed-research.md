<!-- Multi-seed design-space research (RESEARCH ONLY, no implementation) — multiseed-research ultracode (wf_4755de8f-25a), 2026-07-02. For soa#214/#221. Motivated by the scheduling-topology A/B flow. -->

# Multi-Seed Support for saga-stack-cli — Design-Space Research Report

> Scope: a design-space analysis of adding *named-dataset* seeding to `saga-stack-cli`. No implementation, no timeline. Code references are to the four research areas.
>
> **Note on inputs:** the dedicated "cross-system coordination" research area returned only a placeholder (`test`). The cross-system dimension is therefore reconstructed from the substantive evidence in the other three areas — chiefly the scheduling+programs+sessions FK-coupling findings in `repo-seeds` and the `restored`-set composition seam in `snapshot-alt`. Where a cross-system conclusion rests on that reconstruction rather than direct evidence, it is flagged.

---

## 1. The requirement, precisely stated

The feature request is usually phrased as: **"a flow declares which seed dataset each system needs."** Taken literally that is a *per-system, service-keyed* selection: `scheduling-api → ab-topology`, `sessions-api → ab-topology`, everyone else default.

The evidence says that literal per-system framing is the right *mechanical* unit but the wrong *authoring* unit. The decisive fact comes from the hardest case (`repo-seeds`, "TRIAD" finding): an A/B topology dataset is not independently choosable per system. programs-api defines `rotationCount`/`rotationPattern`; scheduling-api mints one slot per `(period, rotation)`; sessions-api projects per-rotation `slot_projection`/`pod_assignment_projection`. All three derive ids from the *same* shared positional-index catalogs (`@saga-ed/program-seed-ids`, `@saga-ed/demo-seed-ids`). Selecting `ab-topology` for scheduling but leaving programs on the default is not a valid state — the FKs would not line up, and sessions' projection would reference rotations that programs never declared.

So the correct statement of the requirement is two-layered:

- **The unit the flow author reasons about is a cross-system SCENARIO** — a named, internally-coherent set of datasets that must be applied together across the coupled systems (the triad + iam personas). "ab-topology" is a scenario, not a scheduling-only fixture.
- **The unit the machinery carries is per-system** — a scenario resolves to a `{system → dataset}` map that the CLI stamps onto individual seed steps. The systems outside the coupled core (content, playback, ads-adm) either take the default or realize the scenario differently (content via a fixtures file, ads-adm via the upstream write path — it has no dataset of its own).

**Resolution:** model the *selection primitive* as per-system (it must be, to reach individual `db:seed` steps and to compose with the existing per-system machinery), but provide a *scenario* as the authored, validated grouping so that coherent multi-system datasets cannot be half-selected. A design that exposes only the raw per-system map — with no scenario-level coherence check — is the primary cross-system safety hazard this feature introduces.

---

## 2. Today's singleton architecture — how seed works end to end

Seeding is a **purely additive/subtractive composition over a frozen, singleton step registry.** There is exactly one canonical seed per system, baked in as a fixed command + fixed env bag, and nothing in the pipeline mutates it.

**CLI side — the frozen registry.** A `SeedStep` (`core/seed/types.ts:57-76`) is `{id, service, databases, cwd, command:string[], env, requiresServiceUp, optionalSteps, failureMode}`. The registry `SEED_STEPS` (`core/seed/profiles.ts:151-311`) is a `Record<SeedStepId, SeedStep>` with **exactly one** canonical step per id, and `SeedStepId` is a *closed* union (`profiles.ts:19-30`: iam, sessions, programs, scheduling, content, coach-pg, qtf-demo, playback…). The command argv is hardcoded per entry — almost always `['pnpm','db:seed']` (`profiles.ts:180,191,216,230,243`).

**CLI side — selection is union/narrow only.** `SeedSelection` (`types.ts:105-124`) = `{profile, reset?, addOns?, perSystem?, only?, exclude?}`. `composeSeedPlan` (`compose-seed-plan.ts:35-59`) builds a *set of step-ids* as `PROFILE_STEPS[profile] ∪ ADDON_STEPS[...] ∪ perSystem-steps`, then `only`/`exclude` narrows it. Crucially `perSystem` (`SystemSeedOverride = {system, profile}`, `types.ts:23-26`) unions in the *same canonical steps* for that system at a heavier **profile** — it varies *quantity* (roster vs full), never *identity* (which fixture). The types comment is explicit: "Additive only… use only/exclude to NARROW."

**CLI side — emit verbatim (the load-bearing constraint).** `composeSeedPlan` walks `SEED_RUN_ORDER` and pushes each frozen registry step **unchanged** into the plan (`compose-seed-plan.ts:55` `const step = SEED_STEPS[id]`, `:84-85` `online/offline.push(step)`). The `SeedPlan` (`types.ts:94-98`) is just arrays of the shared, frozen `SeedStep` objects. There is **no point in the pipeline where per-selection data is merged onto a step.** `e2e-orchestrate` (`:327,444`) and `stack up` (`up.ts:355`) all call `composeSeedPlan(selection, active, restored)` and hand the plan straight to `api.seed`.

**CLI → repo — env is the only dynamic channel.** `runSeedStep` (`stack-api.ts:364-374`) spawns `runner.run({cwd, command, args, env: seedEnv(step)})`. `seedEnv` (`:346-355`) only *expands* `${TOKEN}`s already present in the frozen `step.env.vars` (kinds: `inline` single `DATABASE_URL`, `inline-multi` a `POSTGRES_*`/iam bag; `dotenv` throws, unimplemented). It never injects per-selection data. Flow `env` (`flow/types.ts:136`) is Playwright-runtime env for stages only and does **not** reach seed steps (`stack-api.ts:372`).

**Repo side.** Each of the 8 systems ships one deterministic `db:seed`, dominant shape truncate-then-build from deterministic ids (e.g. scheduling-api `seed()` deletes every table `seed.ts:217-222` then rebuilds; iam-db reverse-dependency `deleteMany` sweep `:524-544`). Ids are computed offline from shared `*-seed-ids` catalogs (`deriveGroupId = uuidv5(...)`, positional `programId = NS + pad(index+1)`), so independent seeds agree with no DB/network.

**What makes it a singleton — exactly.** Four independent facts, each of which must change for multi-seed:
1. `SeedStepId` is a *closed union* with one step per id (`profiles.ts:19-30`).
2. Each step's `command` is a *hardcoded* argv (`profiles.ts:180…`).
3. `composeSeedPlan` emits steps *verbatim* — no per-selection mutation (`compose-seed-plan.ts:84-85`). **This is the load-bearing gap.**
4. The repo `db:seed` is destructive truncate-then-build, so even if two datasets reached one DB, they could not coexist on the default path.

The single largest new capability multi-seed requires is **step cloning/synthesis at compose time** — the one thing the pure `compose-seed-plan` module today guarantees never happens.

---

## 3. The design axes

Four independent choices. Any concrete option is a point in this product space.

**(a) Where the dataset name lives (authoring surface).**
- *New orthogonal axis on `SeedSelection`* — e.g. `datasets?: {system: ServiceId; dataset: string}[]`, parallel to `perSystem`/`addOns`, matching the "orthogonal to profile" ethos (`types.ts:31`). Semantically clean: separates *which fixture* (identity) from *how much* (profile/quantity).
- *Overload `perSystem`* — add optional `dataset?` to `SystemSeedOverride`. Smaller type change, but forces a meaningless `profile` on a pure dataset swap and conflates quantity with identity.
- *New add-on* — model `ab-topology` as a `SeedAddOn`. Zero new axis, reuses proven machinery — but add-ons only ever *union more* steps; they cannot *replace* the default (see axis d).
- *Scenario-level field* — a single `scenario: 'ab-topology'` that resolves (in the flow layer) to a per-system dataset map. This is layer (a)'s answer to the §1 scenario requirement.

Coupling constraint: whatever field is added to `SeedSelection` **must** be mirrored in `seedSelectionSchema` (`flow/types.ts:59-70`) in the same change, or the `_seedSelectionInSync` compile guard (`flow/types.ts:73`) breaks. Also note `effectiveSeed`'s shallow spread (`resolve.ts:150-156`): a stage that sets `datasets`/`scenario` *replaces* the flow's wholesale — no element merge.

**(b) How it reaches the repo (transport).**
- *`SEED_DATASET` env var* — inject into the step's env bag. Lowest per-repo surface; composes into the existing `inline`/`inline-multi` `SeedEnv` kinds with no argv change. Repo reads `process.env.SEED_DATASET` and branches. **Directly precedented:** scheduling/programs/iam already do `process.env.SEED_DEMO_ONLY === '1' ? seedDemoOnly() : seed()` (`scheduling-api/seed.ts:948`).
- *`db:seed:<name>` command-variant* — swap the frozen argv to a distinct package script. Most CLI-native (each variant becomes a `SeedStepId` exactly like qtf-demo), but multiplies tsup build+run pairs and hand-maintained registry entries. **Precedented:** `qtf-demo → ['pnpm','db:seed:qtf-demo']`.
- *Fixtures dir* — `fixtures/<name>/` selected by env, seed loads the named JSON bundle. Best for *data-only* variation (content-api's `migrated-content.json`, sds-fixtures `--slsid`), useless for structural/id coordination. **Precedented:** content-api, transcripts-api.

**(c) Code seed-variant vs snapshot-fixture (or both).**
- *Code seed-variant* — deterministic, reviewable in a PR, version-tracked *with schema*. Cost: authored per repo; the triad is net-new code, not just data.
- *Snapshot-fixture* — a stored `pg_dump -F c`/`mongodump --archive` under `~/.saga-mesh/snapshots/<fixture-id>/`. Named datasets exist *for free* (fixtureId = dir name; `store/restore --only <svc>` already scopes to a service's DB closure). Fast restore, no per-repo code. Cost: opaque binary (not PR-reviewable), and **schema-drift-fragile** — the schema-ahead guard (`plan.ts:226-264`, non-bypassable) blocks a fixture *newer* than your migrations but **does not catch behind-drift**, so restoring an old `ab-topology` fixture onto new code silently yields a stale schema.
- *Both* — the architecture already composes them per-service (see axis d).

**(d) Per-system vs scenario selection + cross-system coordination.**
- *Per-system* is the mechanical unit; it must exist to reach individual steps.
- *Scenario* is the authoring/coherence unit; it exists so the coupled triad cannot be half-selected (§1).
- The **union-vs-substitute** question is the sharpest sub-choice: does selecting a dataset *ADD TO* the default step for that system, or *REPLACE* it? Add-ons and `perSystem` can only union. A true A/B topology must **replace** the default scheduling/sessions seed — you do not want both the journey-default schedule *and* the A/B schedule seeded. If substitution is required, no add-on/`perSystem` framing suffices and compose-time step substitution is mandatory.
- Coexistence sub-choice: if two datasets must live in one DB, the destructive truncate-then-build must yield to the *additive scoped-delete-by-id* pattern (`seedDemoOnly`: `deleteMany({where:{programId:{in: demoProgramIds}}})`, scheduling `:750`). For A/B this is likely *not* needed — one active dataset at a time (full DB replace) is the natural model.

The composition seam already exists (`snapshot-alt`): `composeSeedPlan(selection, active, restored)` gate 2 *skips* a service's `db:seed` when it is fully in `restored`, while partial restore keeps it. So a flow can reference **either** a named seed **or** a named snapshot per system with **no planner change** — the per-system code/snapshot choice is already a supported hybrid at the plan level.

---

## 4. Candidate design options (each end-to-end)

### Option A — Parameterized-seed-per-dataset (`SEED_DATASET` env + compose-time step synthesis)

**Flow declaration.** `seed: { profile: 'full', datasets: [{system:'scheduling-api', dataset:'ab-topology'}, {system:'sessions-api', dataset:'ab-topology'}, {system:'programs-api', dataset:'ab-topology'}] }` (or, preferred, a `scenario:'ab-topology'` that resolves to this map).

**CLI.** New orthogonal `datasets` field on `SeedSelection` + mirror in `seedSelectionSchema` (same commit, compile guard). In `composeSeedPlan`, when a selected step's service has a dataset, emit a **cloned** step with `SEED_DATASET=<name>` added to `.env.vars`. This is the new capability — the first place the frozen registry is mutated per selection.

**Repo.** Each triad seed grows a `process.env.SEED_DATASET` branch (exact precedent: `SEED_DEMO_ONLY`). New `ab-topology` code paths add append-only slugs to the shared `program-seed-ids`/`demo-seed-ids` catalogs; sessions-api gains multi-rotation projection (net-new — the "VARIES modeling gap", `sessions-api/seed.ts:199`).

**Tradeoffs.** Repo change surface: *high in the triad* (net-new code), trivial elsewhere. Determinism: *excellent* — reviewable, schema-tracked, version-controlled. Cross-system safety: *good* if a scenario enforces coherent selection; the shared append-only catalog keeps FKs aligned by construction. Reviewability: *best* (plain code in PRs). Fit: adds one new axis; the compose-time clone is a genuine new primitive but small and localized. This is the right axis for anything **long-lived** — datasets track schema automatically.

### Option B — Snapshot-fixture-per-dataset (named snapshot restored before seeding)

**Flow declaration.** A snapshot field parallel to `perSystem`: `seed: { profile:'full', snapshots:[{system:'scheduling-api', fixtureId:'ab-topology'}, {system:'sessions-api', fixtureId:'ab-topology'}] }`.

**CLI.** No planner change to the *composition* logic — the seam exists. What is missing is purely flow-facing: (a) the schema field naming a snapshot per system; (b) an up/e2e path that runs `restorePlan(--only those systems)` *before* seeding and feeds `restoredServices` into `composeSeedPlan` (today `up.ts:351-355` passes `restored=empty` with a "later" TODO); (c) a `fixtureId ↔ flow` naming/discovery convention (the manifest's `flowId` is written but never read). Gate 2 then auto-skips `db:seed` for the fully-restored services.

**Repo.** *Zero per-repo code.* The dataset is authored once via `fixtures/<name>/create.sh` (mesh-fixture-cli already shipped `demo-small`, `adm-combined` this way) and stored with `ss snapshot store --fixture-id ab-topology --only scheduling-api,sessions-api`.

**Tradeoffs.** Repo change surface: *zero.* Determinism: *poor* — opaque binary archives, not reviewable; and the **behind-drift blind spot** means an old fixture silently restores a stale schema onto new code (no warning). Cross-system safety: *good mechanically* (whole DB-closure restore is internally consistent by construction) but the fixture must be re-captured whenever any triad migration lands, or it rots. Reviewability: *worst.* Fit: strong — this is exactly the shape the `restored`-set architecture was built for. Best for **expensive-to-author, frequently-recaptured** cross-service state, not for a canonical long-lived dataset.

### Option C — Hybrid (recommended shape): code-variant for the coupled core, per-system code/snapshot choice, fixtures dir for data-only systems

A single per-system selection map where each system's dataset resolves to whichever transport fits that system — the architecture already composes these via gate 2.

- **Triad (scheduling+programs+sessions) + iam:** code seed-variant via `SEED_DATASET` (Option A). These are schema-coupled and long-lived — they *must* track schema; snapshots would rot.
- **content, playback:** fixtures dir / added fixture ids (content `fixtures/<name>/`, sds-fixtures more `--slsid`s). Pure data, no id coordination.
- **ads-adm:** no dataset — its A/B attendance is realized by driving the seeded A/B schedule through the real write path (its seed is intentionally `SELECT 1`).
- **Escape hatch:** the same flow field can name a *snapshot* per system (Option B wiring) for expensive-to-author state, since gate 2 skips the code seed when a service is fully restored.

**Tradeoffs.** Repo change surface: *matched to each system's nature* — no wasted work. Determinism/reviewability: *high where it matters* (the coupled core is code), *pragmatic elsewhere*. Cross-system safety: *best* — the coupled core is one reviewable code path over a shared append-only catalog. Fit: uses `perSystem`-parallel authoring, the compose-time clone from A, *and* the `restored`-seam from B — no single mechanism forced to do everything.

---

## 5. Recommendation + open questions

**Recommend Option C (hybrid), with Option A as its default transport for the coupled core.** Reasoning:

1. **The motivating case is schema-coupled and long-lived**, and the decisive `snapshot-alt` finding is that snapshots have a silent behind-drift blind spot. A canonical `ab-topology` used in a permanent A/B test must track schema automatically — that is a code seed-variant, not a snapshot.
2. **`SEED_DATASET` is the lowest-surface transport and is already the house pattern** (`SEED_DEMO_ONLY`, `IAM_API_URL` both branch a single seed file on env). It composes into the existing `inline`/`inline-multi` `SeedEnv` with no new npm scripts and no argv change, so the CLI-side new capability is confined to a single compose-time clone.
3. **A new orthogonal `datasets`/`scenario` axis, not overloading `perSystem`.** Dataset is *identity*; profile is *quantity*. Overloading forces a meaningless `profile` on a pure swap and muddies the model. Keep the axis parallel to `perSystem`/`addOns`, matching the established "orthogonal to profile" ethos.
4. **Author the coupled core as a SCENARIO** so the triad cannot be half-selected — this is the one real cross-system-safety risk the feature introduces, and it is cheap to close at the flow-authoring layer.
5. **Keep the snapshot path available but secondary** — the `restored`-seam is built and unit-tested; reserve it for expensive-to-author, frequently-recaptured state, not the canonical dataset.

**Open questions a decision needs:**

- **Q1 — Union or substitute?** Does selecting `ab-topology` for scheduling/sessions *replace* the default seed (almost certainly yes for A/B) or *layer on top*? This single answer decides whether add-on/`perSystem` framing is even viable. If replace: compose-time step substitution is mandatory.
- **Q2 — Scope of a dataset: `(system)` or `(system, profile)`?** Does `ab-topology` mean the same data at roster and full, or is it profile-conditioned?
- **Q3 — Coexistence:** must two datasets ever live in one DB (→ additive scoped-delete required), or is one-active-dataset-at-a-time (full DB replace) acceptable? A/B suggests the latter.
- **Q4 — Transport per system:** `SEED_DATASET` env (no argv change, repo branches one file) vs `db:seed:<name>` script (CLI-native `SeedStepId`, more build/registry surface) — confirm the env choice for the triad.
- **Q5 — Scenario vs raw per-system map:** does the flow author name a scenario (safer, coherence-enforced) or the raw `{system → dataset}` list (more flexible, foot-gun)?
- **Q6 — Catalog governance:** the shared `program-seed-ids`/`demo-seed-ids` catalogs are *positional* — appending is safe, inserting shifts every downstream id. Who owns the append-only invariant, and how is iam-db's hand-numbered persona UUID block (`a003-*` literals) kept coherent when a dataset adds personas?
- **Q7 — Snapshot naming/discovery:** if the snapshot escape hatch stays, what is the `fixtureId ↔ flow` convention (the `flowId` stamp is currently write-only)?
- **Q8 — `effectiveSeed` merge semantics:** the shallow spread (`resolve.ts:155`) makes a stage's `datasets`/`scenario` *replace* the flow's wholesale. Confirm authors expect replace, not per-system merge.

---

## 6. Motivating case check — the scheduling-topology A/B flow

The concrete target: a flow that seeds an A/B (biweekly A/B day-type, `VARIES_BY_DAY_TYPE`) scheduling topology coherently across programs+scheduling+sessions, so an A/B scenario can be exercised end-to-end. Note: scheduling-api already *encodes* the A/B mechanics as a decoration (`seed.ts:292-387`), but the understanding doc records the slot-scoped differing-treatment case as "fully expressible… but NOT seeded or tested end-to-end anywhere."

**Under Option A (parameterized seed):** the flow declares `scenario:'ab-topology'` → resolves to `{programs, scheduling, sessions} = ab-topology`. `composeSeedPlan` clones those three steps with `SEED_DATASET=ab-topology`. Each repo's seed branches to an `ab-topology` path; programs declares `rotationCount>1`, scheduling mints per-`(period,rotation)` slots, sessions projects per-rotation (the net-new multi-rotation code). All three read the *same* append-only catalog slugs, so FKs align with no DB/network. ads-adm attendance for the A/B case is then produced by driving the seeded schedule through the write path. **Serves the case fully and reviewably; the cost is the sessions-api multi-rotation code and disciplined catalog appends.**

**Under Option B (snapshot):** author `ab-topology` once via `fixtures/ab-topology/create.sh`, `store --only scheduling-api,sessions-api,programs-api`. The flow names the fixture; up runs `restorePlan` before seeding; gate 2 skips those three `db:seed`s; the journey systems take the default seed. **Fastest to stand up and requires no per-repo code** — but the fixture rots the moment any triad migration lands (behind-drift is silent), and the A/B topology is unreviewable binary. Fine as a throwaway to unblock exploration; wrong for a permanent test.

**Under Option C (recommended):** the triad + iam take the Option-A code path (schema-tracked, reviewable, the durable home for a canonical A/B dataset); content/playback (if the flow needs them) take fixture-dir variants; ads-adm rides the write path. If a future expensive cross-service A/B state is cheaper to capture than to author, the same flow field names a snapshot for those systems instead — no planner change. **This is the only option that gives the A/B flow a durable, reviewable, schema-safe home for its hard core while keeping the cheap paths cheap.**

---

*Referenced code (absolute paths): `soa/packages/node/saga-stack-cli/src/core/seed/{types.ts,profiles.ts,compose-seed-plan.ts}`, `.../src/core/flow/{types.ts,resolve.ts}`, `.../src/core/stack-api.ts`, `.../src/commands/stack/{up.ts,seed.ts}`; `program-hub/apps/node/{scheduling-api,programs-api,sessions-api,content-api}/src/prisma/seed.ts`; `rostering/packages/node/iam-db/prisma/seed.ts`; `student-data-system/{apps/node/transcripts-api/src/bin/seed.ts, packages/node/{ledger-db,ads-adm-db}/src/seed.ts}`; snapshot layer `snapshot-store.ts`, `store.ts`, `restore.ts`, `snapshot.ts`, `plan.ts`, `manifest.ts`; `mesh-fixture-cli/fixtures/{demo-small,adm-combined}`.*

<!-- Definitive M8 plan — synthesized by the m8-landing-design ultracode (wf_3ac6dc41-dda), grounded in current code. Supersedes the prior -retire-bash draft (renamed). NON-DESTRUCTIVE. -->

# M8 — Definitive Implementation Plan (saga-stack-cli)

> Supersedes `soa/claude/projects/gh_214/plans/06-m8-cross-repo-landing-and-retire-bash.md`.
> Governing directive (skelly, 2026-07-01): **non-destructive** — bash stays, the CLI is an *additive* entrypoint, no forced transition. The old plan's `-retire-bash` filename is a stale contradiction and is retired with this doc.
> Grounding: coach/bundles/M7/re-sync-audit landed; soak #221 all-green (partial path + e2e closures only).

---

## 0. Framing correction (read first)

The old plan reads as "wait for gates, then do a full native sweep." That framing is wrong now. Two facts change everything:

1. **The differentiated native value already shipped and soaked.** Native defaults are live for: `status`/`verify`/`down` (M2), `snapshot store|list|restore|validate|delete` (M3, soak P4 248→1→248), `stack up --only`/`--with` partial-stack + slot>0 backend sub-stacks (M4/M7), `e2e run` with clamped-date injection (M5), and the `StackApi.seed` runner used by the `--only` path (soak P3/P5). Preconditions the old plan gated on (soak, M7 slots, `--with` bundles) are **SATISFIED**.

2. **`M8 done enough` does not require any native-prep porting or a bare-`up` flip.** The bare full-stack native launch (slot 0, ~27 services) was **never soaked** — soak P1 baseline was bash 27/27; only the partial path (P3) and e2e closures (P5) ran native. Under the non-destructive directive, keeping bare `up`/`reset`/`seed`/`overlay`/`tunnel`/`bootstrap` wrapping up.sh is **correct by design**, not debt.

So M8 = land the cross-repo content that unblocks real e2e + the docs/deprecation coexistence + the manifest parity guard that makes the *already-native* paths trustworthy. The five native-prep runners are a **documented deferred backlog (§C-deferred)**, each gated behind its own dual-run soak, pursued only if wanted inside #214.

The `native-first` design proposal was a stub; this plan synthesizes the two substantive proposals (`value-first`, `minimal-landing`), which agree on sequencing and MVP. Where they differ — whether the manifest re-sync goes first (minimal-landing) or the cross-repo content goes first (value-first) — I resolve it below in §4: **parity guard first** (it guards paths already in daily use), then content.

---

## 1. Scope correction — what §A–§E actually are now

| § | Old-plan intent | Actual status now | M8 action |
|---|---|---|---|
| **§A** flows.json authoring + "spa-registry preference flip" | Flip resolver + author repo files | Resolver **already** prefers repo file over bundled fallback (`e2e-orchestrate.ts:121-146`, `discover.ts:107-114`); "flip" is a **NO-OP**. Repo files still absent (verified). | Drop the code item. Pure **content authoring**: A.1 saga-dash (do), A.2 connectv3 (**defer**, no suite exists), A.3 (doc-only note). |
| **§B** Monday-flake fix | Inject clamped dates + migrate specs | Layer-1 (CLI injects `PLAYWRIGHT_OCCURRENCE_DATE/TERM_START/TERM_END`) **DONE** (`run.ts:130`→`env.ts:114 computeEnv`). Kit shim exists (`e2e-kit.ts`), package **not extracted**, specs **not migrated**. | B.1 extract kit package; B.2 migrate saga-dash specs env-first. Still needed. |
| **§C** native wrapper flips | "Full-stack `stack up` native by default" | Mostly already native (status/verify/down/snapshot/partial-up/e2e). Remainder is **narrow**: native prep/provision/migrate/reset + coach/playback stdin-seed + bare-`up` flip — **all UNSOAKED**. Bare-`up` DoD is the sharpest over-scope. | Re-scope §C to a **narrow deferred backlog** + the manifest re-sync guard (§C-guard, do). **Do NOT flip bare `up`.** |
| **§D** deprecate mesh-fixture-cli | Deprecate-not-delete | Correctly framed, **UNSTARTED** — zero deprecation markers (verified). Superseding surface (snapshot, seed) exists. | Execute: additive notice, leave bins functional. |
| **§E** docs both entrypoints | Document both, don't retire scripts | Correctly framed, **UNSTARTED** — `saga-stack-cli/README.md` still "M0 … no docker yet" (verified); synthetic-dev docs bash-only. | Execute: rewrite both READMEs. |

**What M2–M7 already did native (do not re-do):** status, verify (`--full` delegates), down/down --mesh, all snapshot subcommands, `up --only`/`--with` + slot>0, `e2e run`, the `StackApi.seed` offline→online runner, the repo-absent skip guard in `up.ts`, the manifest consistency unit test, and the flow resolver's repo-file preference.

---

## 2. The true native-prep blocker set (§C-deferred) — exactly what must be built to flip full-stack `up`/`reset`/`seed` to native

These are **deferred** (see §4). They are documented here as the real backlog so §C is concrete, not the pre-coach abstraction. All five runners slot into `StackApi.up` **between `meshUp` and the launch waves** (`stack-api.ts:350-451`), in order **build → provision → migrate**, each behind an injectable Runner seam (IO-only-in-runtime invariant), closure-scoped so `--only` stays cheap. Each flips per-command via dual-run diff vs up.sh, with a `--legacy` escape retained.

| # | Runner | Now | What to build | File / change |
|---|---|---|---|---|
| **1** | Native build/prep pass | ABSENT natively; `--skip-prep` is wrapper-only | New `runtime/` prep module over the closure's repos: `pnpm install` + best-effort workspace build + `db:generate` (rostering/program-hub/sds/saga-dash/qboard/rtsm/coach), idempotent, honoring an SKIP_PREP-equivalent. Wire into `StackApi.up` **before** launch. | port `up.sh:992-1039`; extend `stack-api.ts:350-451`; reuse manifest repo/subpath. **RISK:** fresh/stale-dist native `up` crashes at import (`@saga-ed/coach-db` from dist/) or `vite: not found` before any DB work — hard failure. |
| **2** | Idempotent role+db provision fallback (stale volumes) | ABSENT natively; mesh initdb hook only fires on a truly-fresh PGDATA volume | In the prep runner, before migrate: for each closure `meshProvisioned` DB, `docker exec <pg> psql -U postgres_admin` with `DO $$ IF NOT EXISTS role $$ + CREATE DATABASE OWNER`. **coach_api is the named #221/soa#221 blocker** (new to profile-empty.sql → missing on every existing volume). | mirror `up.sh:1048-1068`; manifest already carries ownerRole/pw/name (`databases.ts:9-11`). **RISK:** coach-pg seed silently degrades to warn today; sessions/content would fail fatally if likewise missing. |
| **3** | Native migrate runner — **THE headline blocker** | ABSENT; manifest has full `MigrateSpec` data but **nothing executes it** (`snapshot-store.ts:206-229` only reads dirs for a schemaRev compare) | Port `migrate_db` into a `runtime/` migrate runner: for each closure DB in canonical manifest order, run `MigrateSpec` (Runner + optional `DATABASE_URL` override) with the three-way branch (managed→`db:deploy` / empty→`db:deploy` / unmanaged→`migrate reset`), probing `_prisma_migrations` via `docker exec psql`; preserve the iam-pii `db push` ordering and the program-hub `db:deploy` mesh-:5432 URL override. Wire between provision and launch. | port `up.sh:738-755` + `up.sh:1040-1073`; `databases.ts:13-16`. Empirically confirm iam-api boot-migrate (that + a prior up.sh run is why "iam came up on fresh volumes" — native provisions via initdb hook but does **not** migrate; program-hub/ads-adm/sis do not self-migrate, so the runner is required regardless). **RISK:** without it, a genuinely fresh native default cannot seed — iam/sessions/programs/scheduling `db:seed` hit missing tables and abort. This is the true gate on the bare-`up` flip. |
| **4** | Native reset | DELEGATED to up.sh (`reset.ts:42-48`, `stack-api.ts:462-472`) | Native reset runner: `docker exec psql` generic `TRUNCATE` (ON_ERROR_STOP loop, preserve `_prisma_migrations`) for `resetMode:'truncate'` DBs; **special-case `ledger_local` → `prisma migrate reset --force`** (`migrate-reset`, decision 2026-06-30, NOT in the truncate list); `mongosh dropDatabase` for connectv3; then dev-user re-seed. Replace the delegate, keep the `--legacy` escape. Playback DBs only under `--with playback`. | port `up.sh:1661-1698`; `databases.ts:118-133`. **RISK:** lower (reset already works via delegation); trap is the ledger special-case + preserving `_prisma_migrations`. |
| **5** | Playback + coach stdin-seed | ABSENT natively | Add a `stdinFile?` (or docker-cp) field to `SeedStep` — needed by both (a) coach curriculum `mongoimport < file` (`profiles.ts:285-292` TODO) and (b) playback provisioning (each `*-db/seed/local-bootstrap.sql` via `docker exec psql` + migrate). Gate native coach `--seed full` and native `--with playback` until landed. | `up.sh:937-951` (playback), `up.sh:1780-1798` (coach mongo); `stack-api.ts:315-347`. **RISK:** coach dashboard renders no curriculum; `--with playback` native fails until provisioned — both opt-in, so neither gates the (deferred) default flip. |

**Not a blocker (done):** the seed *runner* — `composeSeedPlan` (M5) + `StackApi.seed` execute offline→online end-to-end, live-verified in soak P3/P5 after the `iamSeedEnv` inline-env and seed-dev-user warn-not-fatal fixes. Only the two content omissions above remain.

---

## 3. Cross-repo (§A / §B) — flows, PRs, coordination

Four PRs across three repos.

### §A.1 — saga-dash `flows.json` (journey + connect-session) — **DO**
- **Repo/branch:** `saga-dash` (currently `main`), new branch off main (e.g. `e2e/flows-json`).
- **Work:** add `apps/web/dash/e2e/flows.json` by promoting `saga-stack-cli/examples/flows/saga-dash.flows.json` **verbatim** (journey 8 stages + `connect-session`). Verify stage `project`/`spec` names still match `apps/web/dash/playwright.stack.config.ts` (they line up today: stage-1-roster … stage-8-attendance-personas, interactive-connect).
- **No CLI change** — resolver already prefers the repo file.
- **DoD:** `ss e2e list` shows the repo `sourcePath`, not `(bundled example)`; `ss e2e run saga-dash/journey` resolves from the repo file.

### §A.2 — qboard connectv3 `flows.json` (connect-smoke) — **DEFER past #214**
- **Blocked:** verified — `qboard/apps/web/connectv3` has **no e2e dir, no playwright config, no specs**. The bundled `connectv3.flows.json` is an explicit placeholder. This is really "build a connectv3 e2e suite," not "author a manifest" — scope creep. Defer unless a connect smoke suite is independently wanted; if pursued, it's a prerequisite PR (playwright.config.ts + a real `smoke/connect-smoke.e2e.test.ts`) *then* the manifest.

### §A.3 — spa-registry "preference flip" — **NO-OP (doc-only)**
- Already implemented (`discover.ts` builds `[--spa-path, $SAGA_E2E_SPA_PATHS, repo-path]`, loads first that exists, bundled only as fallback). **No `spa-registry.ts` edit.** Only keep the bundled examples framed as "authoring-template + fallback" in the README.

### §B.1 — extract `@saga-ed/saga-stack-e2e-kit` — **DO**
- **Repo/branch:** `soa` (same monorepo), branch `gh_214` or a dedicated follow-up.
- **Work:** create `soa/packages/node/saga-stack-e2e-kit` exporting the pure helpers `{ fmtLocal, mondayOfWeekOf, todayOrNextWeekday, occurrenceDate }` + the `ENV_*` name constants. **One source of truth:** move the helpers into the kit; `saga-stack-cli/src/core/flow/env.ts` re-exports from it (per the existing `e2e-kit.ts:17-24` shim note), so `computeEnv` and the specs share identical clamp math. `saga-stack-cli` takes the kit as a workspace dep.
- **Purity contract (hard):** NO `new Date()`/`Date.now()` inside the kit — callers pass the reference date (`env.ts:18-21`). Wire `@saga-ed` scope/version/build outputs so a **different repo** (saga-dash) can depend on it.

### §B.2 — saga-dash spec migration to env-first — **DO (fast-follow, depends on B.1)**
- **Repo/branch:** `saga-dash`, off main (can piggyback A.1 or stand alone).
- **Work:** make each date spec env-first — `const OCCURRENCE_DATE = process.env.PLAYWRIGHT_OCCURRENCE_DATE ?? fmtLocal(occurrenceDate(new Date()))`, `TERM_START/TERM_END = process.env.PLAYWRIGHT_TERM_START/END ?? …` — importing from `@saga-ed/saga-stack-e2e-kit`; **delete** the inline copies. Targets: `journey/{sessions,attendance,attendance-personas}.e2e.test.ts` (the unclamped `mondayOfCurrentWeek()` = the actual Sat/Sun flake), `journey/schedule.e2e.test.ts`, `interactive/connect-session.e2e.test.ts` (already clamps — switch to env-first + shared helper, keep behavior identical), optionally `telemetry/ping-dosage-harness.mjs`.
- **DoD:** a Sat/Sun `ss e2e run saga-dash/journey` no longer flakes (occurrence = next Monday), and can't regress per-spec (injected env is authoritative).
- **Do NOT overclaim:** the separate **stage-8 `selectOccurrence` Monday timeout** (`today == OCCURRENCE_DATE`, per memory) is a *different* flake — §B does not fix it. Weekday nuance: clamped-today ≠ old `mondayOfCurrentWeek` occurrence; both are live on a Mo–Fr schedule, but re-read any spec that hard-asserts "Monday specifically."

### Coordination with the scheduling-topology-flow effort — **explicit ownership**
That effort (`HANDOFF.md`, tracker soa#221 "New flow #1") is **also** authoring `saga-dash/apps/web/dash/e2e/flows.json` and appending a backend-only `scheduling-topology` flow + a new `scheduling/topology-ab.e2e.test.ts`. The `flows` array is additive, so both flows coexist — the risk is double-creation of the one new file.

**M8 owns vs that effort delivers:**
- **That effort seeds the file** (it is already in-flight in the saga-dash repo per its HANDOFF). It creates `flows.json` and appends `scheduling-topology`.
- **M8 owns confirming** `journey` (8 stages) + `connect-session` are present in that single file (promoted from the bundled template). If the topology effort lands first, M8's A.1 becomes a *verify + top-up* PR, not a create. If M8 lands first, the topology effort appends.
- **Rule:** exactly one owner `git add`s the new file; the other appends to the additive array. Never two PRs create it.
- **Kit dependency:** the topology spec must consume `@saga-ed/saga-stack-e2e-kit` (§B.1) for its Mon/Wed/Fri occurrence dates rather than re-inlining a date helper — so **sequence §B.1 before the topology spec** if practical.

---

## 4. Phasing — smallest shippable increments, low → high risk

Each phase ships and is testable on its own. `#214` is closable at end of Phase 2; Phases 3–4 are named fast-follows/deferred.

### PHASE 0 — Manifest trust / up.sh↔CLI re-sync guard (do FIRST; medium risk, highest leverage)
Every native path **already in daily use** (partial `up --only`, `e2e run`) reads the TS manifest; a stale manifest silently launches drifted env/ports. This is the true prerequisite to trusting anything native, so it precedes even the docs.
- **Work:** diff `gh_214` up.sh against origin/main (materialized at `/home/skelly/.claude/jobs/d71128ac/tmp/upsh-origin-main.sh`); reconcile drifted service/port/launch-env in the TS manifest + `core/flag-map.ts` (header is transcribed flag-for-flag from up.sh — must not drift; one drift already fixed: `VITE_SESSION_MEASURED`, c9aaa76); **re-baseline the M1 golden-parity tests** to pin the reconciled set.
- **Testable:** golden-parity suite green against `upsh-origin-main.sh`.

### PHASE 1 — Coexistence docs + deprecation (zero runtime risk, high onboarding value; §E + §D + meta)
The stale READMEs actively misrepresent a shipped tool — highest-value quick fix.
- **1a §E:** rewrite `saga-stack-cli/README.md` (kill "Status — M0 … no docker yet"; document native `status`/`verify`/`down`/`snapshot`/`e2e`, `stack up --only/--with`, M7 slots, `ss`/`saga-stack` on PATH). Update `tools/synthetic-dev/README.md` (+ getting-started/INTEGRATION/STATUS) with a **both-entrypoints** section: `.sh` = supported bash path, `ss` = recommended-but-optional additive alternative, **no forced transition**.
- **1b §D:** add a deprecation NOTICE to `mesh-fixture-cli/README.md` + `package.json` description pointing at `ss stack snapshot`/`ss stack seed`; optional runtime stderr hint; **leave all bins functional**. Precondition met (snapshot P4 + native seed).
- **1c meta:** retitle/replace the plan doc (drop `-retire-bash`); Preconditions rewritten as SATISFIED with a "what already shipped" preamble.
- **Testable:** docs review; `mesh-fixture-cli` still runs; grep `deprecat` now hits.

### PHASE 2 — One real flow + the kit enabler (cross-repo, low risk; §A.1 + §B.1)
- **2a §A.1:** saga-dash `flows.json` (coordinated single-owner with the topology effort — §3).
- **2b §B.1:** extract `@saga-ed/saga-stack-e2e-kit`; `env.ts` re-exports from it.
- **Testable:** `ss e2e list` shows repo `sourcePath`; kit builds and `saga-stack-cli` unit tests (clamp math) green through the re-export.

**⇒ MVP / "M8 done enough" line is HERE — #214 closable.**

### PHASE 3 — Flake fix (cross-repo fast-follow; §B.2, depends on B.1)
- Migrate saga-dash journey/schedule/connect-session specs env-first, delete inline copies.
- **Testable:** Sat/Sun `ss e2e run saga-dash/journey` no longer flakes.

### PHASE 4 — DEFERRED native-prep porting (the §C-deferred backlog; high risk, each behind its own dual-run soak)
Only if pursued inside #214; else fast-follow. Dependency order: **build (gap 1) → provision incl coach_api (gap 2) → migrate (gap 3, headline) → native reset flip (gap 4) → `SeedStep.stdinFile` for coach curriculum + playback provisioning (gap 5)**. Plus port the `up.ts` repo-absent seed-active-set skip into `e2e-orchestrate.ts` and add the transitive dependent-of-skipped guard. Insert build→provision→migrate into `StackApi.up` between `meshUp` and launch, behind Runner seams, closure-scoped.

### Per-command flip method (for any Phase-4 flip)
For each command: (1) build the native runner behind a seam; (2) **dual-run diff** the native runner's effect vs up.sh (env, DB state, ports) on both fresh and stale volumes; (3) flip the default only when the diff is clean and soaked; (4) **keep a `--legacy` (bash) escape** on the flipped command indefinitely. Never flip a command whose native path is unsoaked.

### MVP vs deferred (explicit)
**MVP (Phase 0–2):** manifest re-synced + golden-parity green; both READMEs current & both-entrypoints documented; mesh-fixture-cli deprecated-not-deleted; saga-dash `flows.json` resolving from repo; `@saga-ed/saga-stack-e2e-kit` extracted. This delivers the *already-soaked* differentiated value (partial `up --only/--with`, `e2e run`, snapshot, verify/status/down) plus the real-e2e unblock, bash fully intact.
**Deferred:** all five native-prep runners; the bare full-stack `up` native flip (UNSOAKED — keep wrapping up.sh by design); §A.2 connectv3; coach/playback stdin-seed; standalone `reset`/`seed` native flips; overlay/tunnel/bootstrap native ports (large, unsoaked — leave wrapped).

---

## 5. Non-destructive coexistence

- **The `.sh` scripts are never touched, shimmed, or deleted** — `up.sh`, `verify.sh`, `tunnel.sh`, `refresh-suite.sh`, `bootstrap.sh`, and the saga-dash e2e `.sh` remain the supported bash path indefinitely. The CLI flips only its **own** defaults, and in the MVP only for paths already native+soaked.
- **Wrapped-by-design (not debt):** bare full-stack `stack up` at slot 0 → `up.ts runWrapped` → up.sh; `stack reset` → up.sh --reset; standalone `stack seed` → up.sh --seed; overlay/tunnel/bootstrap → flag-map ScriptPlan wrappers. Slot 0 stays up.sh-compatible (M7 invariant preserved). Document these as wrapped-by-design, not "to be ported."
- **`--legacy`/bash escape retained** on any command that *is* native.
- **mesh-fixture-cli: deprecate-not-delete** — additive README/`package.json` notice + optional stderr hint, all bins functional; removed only later with owner sign-off.
- **README documents BOTH entrypoints** as equals-with-a-recommendation; developers migrate on their own.
- **Foreground-not-in-background guard:** the one hard invariant kept — never run a foreground-required flow (`connect-session foreground:true`) in the background/detached. Enforced in the e2e-run model. Gated opt-in non-defaults (`--with-playback`/`--record`/connect-AV gates) stay replaced by the `--only`/`--with` sub-stack closure, not bespoke native gates.

---

## 6. Open decisions for skelly

1. **Bare full-stack `up` native flip — confirm deferral.** Recommendation: keep bare `stack up` wrapping up.sh **indefinitely** (the additive CLI is "fully functional" on partial/e2e/snapshot/verify without it). If you ever want the flip, it needs its own dedicated full-stack 27-service dual-run soak. **Approve deferral?**
2. **Phase-4 native-prep in #214 vs fast-follow.** Do you want *any* of the five prep runners inside #214, or is #214 closed at the Phase-2 MVP with all native-prep as a separate tracked effort? (Recommendation: close #214 at MVP; spin native-prep as its own issue.)
3. **saga-dash `flows.json` seed owner.** Confirm the scheduling-topology-flow effort seeds the file and M8/A.1 verifies-and-tops-up (vs M8 seeding and topology appending). Recommendation: topology seeds (it's already in-flight in the saga-dash repo).
4. **`@saga-ed/saga-stack-e2e-kit` publish surface.** Is a workspace-only package sufficient, or does it need to be **published** (registry) for saga-dash to consume across repos? This affects version/build wiring in §B.1.
5. **§A.2 connectv3.** Confirm defer past #214 — unless you independently want a connectv3 smoke e2e suite stood up (that's "build a suite," not "author a manifest").
6. **coach_api provisioning deferral.** It's latent-not-blocking today (coach-pg is `failureMode:'warn'`, coach not cloned), but the first dev who clones coach and runs native `--seed full` on a stale volume gets a Coach dashboard with no curriculum. Accept as a documented backlog item, or pull gap-2 provisioning forward into MVP?

---

**Bottom line:** M8 ships as Phases 0–2 (parity guard → docs/deprecation → one real flow + kit), closing #214 as a documented, trustworthy, additive entrypoint with bash fully intact. Phase 3 (flake fix) is a named fast-follow; Phase 4 (native-prep) and the bare-`up` flip are explicitly deferred behind their own soaks. Nothing destructive; the `-retire-bash` title dies with the old plan.

Relevant paths: `/home/skelly/dev/soa/packages/node/saga-stack-cli/` (README, `src/core/flow/{env,e2e-kit,discover}.ts`, `src/e2e-orchestrate.ts`, `src/core/manifest/databases.ts`, `examples/flows/`), `/home/skelly/dev/soa/packages/node/mesh-fixture-cli/`, `/home/skelly/dev/soa/tools/synthetic-dev/README.md`, `/home/skelly/dev/soa/claude/projects/gh_214/plans/06-m8-cross-repo-landing-and-retire-bash.md`, `/home/skelly/dev/saga-dash/apps/web/dash/e2e/` (specs; `flows.json` to add), `/home/skelly/dev/qboard/apps/web/connectv3/` (no e2e — deferred), `/home/skelly/.claude/jobs/d71128ac/tmp/upsh-origin-main.sh`.

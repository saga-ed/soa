# PLANNING HANDOFF — M13 "worktree sets": parallel dev contexts on `ss` slots

> Copy-paste this whole file as the opening prompt of a fresh session. It is
> self-contained. **Deliverable is a PLAN, not an implementation.**

You are planning a new feature for **saga-stack-cli** (`ss`), the native TypeScript CLI
for the synthetic saga dev stack (soa#214, tracker #221, branch `gh_214` in
`~/dev/soa/packages/node/saga-stack-cli`). Do NOT implement anything — produce the plan
document described under **Deliverable**, commit only that file, and stop.

## The ask (skelly, verbatim intent)

Devs should **routinely work on and test independent git worktrees against synthetic-dev
under `ss`, in parallel** — "opens us up to develop against multiple contexts without
bottlenecking through synthetic dev."

A **worktree set** = a named map of `repo → checkout path` (worktree), bound to a slot.
Sets span **multiple repos and multiple branches**, including same-repo-different-branch
across sets. The canonical scenario to design for:

- **set A:** (saga-dash@A, rostering@A, student-data-system@C) → **slot 1**
- **set B:** (saga-dash@E, rostering@C) → **slot 2**
- **baseline:** clean `main` → e2e as an **additional/control run** (skelly: "run e2e
  against clean main as an additional ask")

Each context runs `ss e2e run` **independently and concurrently**, with each worktree's
own `flows.json` projected in (this exercises the nascent flows-as-data work — the flow
content itself differs per worktree, not just the ports).

### Settled design tenets (do not re-litigate; build the plan on these)
1. Support both different-repos and same-repo-different-branch, multi-repo sets.
2. The worktree-set map is a **first-class `ss` concept** (not a documented flag recipe).
3. This is a **routine feature**, not a one-off validation.
4. **Two-worktrees + clean-main is the canonical shape.** Never share a *hot* primary
   checkout between slots — shared repos must be **clean, pre-built, effectively
   read-only** (a clean-`main` worktree when in doubt; the synthetic-dev README already
   documents that pattern for repo overrides).
5. The clean-main **baseline e2e** is part of the feature: a set run is interpretable
   because the same flow is green on clean main.

## Why this feature is THIN (the architecture already anticipated it)

A worktree set is **pure composition** of proven seams — the plan should be shaped by
this, not fight it:

| Existing seam | Status | File |
|---|---|---|
| Per-repo path overrides (`--saga-dash <path>`, `$SAGA_DASH`, `--dev`) — every resolver (prep, launch, seed, overlay, e2e spec discovery) goes through `resolveRepoRoot` | ✅ | `src/core/scripts.ts` (`REPO_ENV_VAR`/`REPO_DEFAULT_DIR`), `src/runtime/repos.ts` |
| Slots (`--slot N` → project `soa-s<N>`, +N×1000 ports, disjoint volumes/state) | ✅ live-proven, zero cross-talk | `src/core/derive-instance.ts` |
| e2e per-slot (`e2e run --slot N` wires the full instance profile + offset Playwright URLs) | ✅ | `src/e2e-orchestrate.ts` (`buildStackContext`), `src/commands/e2e/run.ts` |
| Native prep builds per **resolved repo root** (install/build/db:generate, co:login 401 retry); pre-built repos are **fresh-skipped** | ✅ | `src/runtime/prep.ts` |
| `flows.json` + Playwright spec discovery ride the resolved SPA repo root — point SAGA_DASH at a worktree and you run **that worktree's flows and specs**, zero extra wiring | ✅ | `src/core/flow/discover.ts`, `resolveAppCwd` in `e2e-orchestrate.ts` |

**Known asymmetry to fix in the plan:** `e2e run` exposes ALL per-repo pin flags
(`--soa --rostering --program-hub --saga-dash --coach --qboard --rtsm --dev`), but
`stack up` exposes only a subset (`--dev --rostering --saga-dash --soa`). The set map
should make per-command flag surface irrelevant (map → env/ctx injection), but decide
and state the story.

So the feature ≈ **a named map + a guard + threading + management commands**.

## The one real hazard (design the guard around this)

Slots isolate **runtime**, not **source**. Two slots pointed at the same checkout share
its `dist`/`node_modules`:
- *Running* a shared pre-built repo from two slots is fine (two processes, same dist,
  per-slot env).
- *Building* the same checkout concurrently races. Fresh-skip protects pre-built shared
  repos, but the plan needs an explicit **build-collision guard**: refuse (or serialize
  via a realpath-keyed lock, e.g. under `/tmp`) when two active slots would *prep-build*
  the same checkout. Also decide: warn or refuse when a set points a *buildable* entry
  at the primary `$DEV/<repo>` checkout (tenet 4 says shared = clean-main worktrees).

## Design questions the plan MUST resolve (recommendations expected, be decisive)

1. **Map file** — location (suggest a durable per-dev dir, e.g. `~/.saga-stack/worktree-sets.json`;
   NOT inside any repo), schema (set name → `{ slot, repos: { <kebab-repo>: <path> }, note? }`),
   kebab repo names (`saga-dash`, `student-data-system`, …) resolved to `RepoKey`s internally.
2. **CLI surface** — a `--set <name>` flag on `up/down/status/verify/reset/seed/snapshot/e2e run`;
   `ss set list|show` (and whether `create/assign/rm` edit the file or MVP = hand-edit);
   precedence: explicit `--<repo>` flag > set map > `$<REPO>` env > default.
3. **Slot binding** — recommend the set OWNS its slot (one name = source + runtime + flows);
   define `--set X --slot N` mismatch behavior; whether slot 0 is reserved for the
   clean-main baseline by convention.
4. **The build-collision guard** — mechanism (realpath-keyed prep lock + an up-front
   cross-slot collision check), failure mode (hard error with a clear message).
5. **Worktree creation scope** — MVP: `ss` records paths, devs run `git worktree add`
   themselves; fast-follow: `ss set create --from-branches saga-dash=feat/x,...`
   (worktree add + install). Recommend and phase it.
6. **Baseline composition** — how "e2e against clean main" runs: primary checkouts on
   slot 0, or a `main` set on its own slot; how results are reported side-by-side.
7. **e2e threading** — `e2e run --set A saga-dash/<flow>`: set → repo env + slot; confirm
   flows.json/spec discovery follows the set's SAGA_DASH automatically.

## Known risks / prerequisites (state them in the plan)

- **slot>0 programs-api rabbitmq cold-start** (OPEN): the last concurrent two-slot e2e
  had slot 0 green (20/20) but slot 1 fail at programs-api stuck in `[MQConnectionManager]
  CONNECTING` on a cold stack. All slot env was verified offset-correct; it's a
  startup-timing/MQ-readiness issue (health window already 120s via
  `$SAGA_STACK_HEALTH_POLL_ATTEMPTS`; open PR soa#232 "recover AMQP channels" may be
  related). **This is a prerequisite for the two-set concurrent validation** — plan it
  as P0 or a called-out dependency.
- connect-api/connect-web excluded at slot>0 (literal-port tokenization pending);
  tunnel/sandbox are slot-0-only. Sets at slot>0 are backend+dash contexts today.
- Journey e2e is green 20/20 incl. weekends (saga-dash PR #345,
  branch `fix/journey-sessions-20-weekend-tolerant` — note: that branch is itself a
  perfect **worktree candidate for the validation scenario**).
- The flow agent's `scheduling-topology` flow lives on saga-dash branch
  `flow/scheduling-topology-ab` — another natural worktree for validation (different
  flows.json content per worktree = the real scenario-projection proof).

## Validation plan the document must include (live, concrete assertions)

- **V1 (stacks):** two real worktree sets (use the branches above) + clean-main, brought
  up concurrently on slots 1/2 (+ baseline). Assert: disjoint containers/volumes/state,
  each slot serves **its own branch's code** (plant a marker or use a known branch diff),
  shared repos never rebuilt (fresh-skip observed), collision guard fires when two sets
  point at the same buildable checkout (negative test).
- **V2 (e2e):** concurrent `e2e run --set A` / `--set B` / baseline — each runs **its
  worktree's flows.json** (different flow/stage lists prove content projection), all
  green, zero cross-slot DB writes (reuse the watchdog pattern: poll both slots' user
  counts during the runs).

## Deliverable

Write **`~/dev/soa/claude/projects/gh_214/plans/10-m13-worktree-sets.md`**: concept +
schema, CLI surface, guard design, phased milestones with effort (S/M/L) and an explicit
"do first" recommendation, the validation plan, and any open questions for skelly.
Ground every claim in the actual code (read the files in the table above first).

- Commit **only that plan file** to branch `gh_214` — `git -C ~/dev/soa add` the single
  path; the working tree may carry other agents' uncommitted work. Push to origin/gh_214.
- Update the WIP fragment per `~/dev/CLAUDE.md` (fragment `~/dev/wip/40-soa214-oclif-cli.md`
  or similar — edit only your effort's fragment, then run `~/dev/wip/build.sh`).
- **PLAN ONLY.** No src changes, no worktree creation, no stack runs.

## Pointers

- CLI: `~/dev/soa/packages/node/saga-stack-cli` (run via `node bin/dev.js …`; 750+ unit tests via `pnpm --filter @saga-ed/saga-stack-cli test`)
- Prior plans for style/precedent: `~/dev/soa/claude/projects/gh_214/plans/` (esp. `04-m7-multi-instance.md` — slots; `09-native-parity-plan.md` — the milestone table format)
- Issues: saga-ed/soa#214 (effort), #221 (findings tracker — the plan summary may be posted there as a comment)
- The synthetic-dev README documents the "point a repo at a clean-main worktree" override pattern: `~/dev/soa/tools/synthetic-dev/README.md`

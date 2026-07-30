# @saga-ed/saga-stack-cli

`saga-stack` (alias **`ss`**) — the unified CLI for bringing up, seeding, verifying,
resetting, snapshotting, and end-to-end testing the **synthetic saga dev stack** across
every repo (soa, rostering, program-hub, saga-dash, sds, qboard, rtsm, coach, fleek).

One OCLIF v4 package, **two topics** (`stack`, `e2e`) over a shared, pure, unit-tested
core (500+ tests). Everything is driven by a single **frozen TypeScript service manifest**
(ports, `dependsOn` graph, launch env, databases, migrate specs, seed steps) as the one
source of truth — so behavior lives in data you can read, not in env-vars and branchy bash
you have to reverse-engineer.

> **New here? → [docs/getting-started.md](./docs/getting-started.md)** — the copy-paste happy
> path (up → status → verify → e2e → down) with the real output of each command, linking out
> to per-feature docs ([sub-stacks](./docs/sub-stacks-and-bundles.md) · [slots](./docs/slots.md) ·
> [verify](./docs/verify.md) · [snapshots](./docs/snapshots.md) · [e2e](./docs/e2e.md) ·
> [develop](./docs/develop.md) · [tunnel](./docs/tunnel.md) · [integration](./docs/integration.md)).

```bash
ss stack up --only scheduling-api,sessions-api   # boot just those + their deps
ss stack status                                  # per-service health
ss e2e run saga-dash/journey --through attendance
```

## Non-destructive by design

This CLI is **additive**. The synthetic-dev bash scripts (`up.sh`, `verify.sh`,
`tunnel.sh`, `bootstrap.sh`, `refresh-suite.sh`) **stay in place and fully supported** —
`ss` is the *recommended, optional* alternative, not a forced migration. Adopt it one
command at a time; every command that has flipped to a native implementation keeps a
`--legacy` escape that routes back to the bash path. It also supersedes
`@saga-ed/mesh-fixture-cli` (folding the snapshot/fixture lifecycle into `stack snapshot`).

## Install

```bash
cd ~/dev/soa/packages/node/saga-stack-cli && pnpm build && pnpm link --global
# `ss` and `saga-stack` are then on PATH, runnable from any directory.
```
Re-run `pnpm build` after code changes. No-build alternative (runs straight from `src` via
tsx): `node <abs>/bin/dev.js …`. Undo with `pnpm uninstall --global @saga-ed/saga-stack-cli`.

Every command supports structured output: `--output-json` (machine-readable) and
`--porcelain` (minimal, scriptable), alongside the default human view. `--help` (and `-h`)
plus tab-completion work at every level.

## `ss stack …` — the stack lifecycle

| Command | What it does |
| --- | --- |
| **`up`** | Bring the stack up. `--only a,b` / `--with <bundle>` boots the minimal dependency **closure** natively (prep → provision → migrate → launch → seed); bare full-stack wraps `up.sh`. `--slot N` runs an isolated concurrent instance. `--dry-run` prints the plan. |
| **`down`** | Stop the stack (`--mesh` also tears the mesh down). Native + slot-safe at `--slot N`. |
| **`status`** | Per-service health, probing manifest-derived endpoints (native, read-only, never exits non-zero). `--only` scopes it. |
| **`verify`** | Native health gate — exits non-zero if a required service is down. `--only` scopes to a closure; `--tolerate` allows named services down; `--full` delegates the deep data + git-posture checks to `verify.sh`. |
| **`reset`** | Truncate the data DBs to an empty baseline (preserving migration history) + re-seed the dev user (native; `--legacy` → `up.sh --reset`). |
| **`seed`** | Seed a running stack (`--with playback\|qtf` add-ons). |
| **`snapshot`** | `store` / `list` / `restore` / `validate` / `delete` native DB fixtures (pg_dump/mongodump, schema-ahead guard, restore-as-owner) — restore a known-good DB state in seconds instead of re-running `db:seed`. |
| **`bundle list`** | Show the `--with` convenience bundles (name → services + seed). |
| **`overlay`** | Overlay your in-flight PRs onto a main-based stack. |
| **`tunnel`** | Expose the local stack via the vms rendezvous (share your stack). |
| **`bootstrap`** | One-command stand-up on `main` (ensure repos → up → verify). |
| **`login`** / **`restart`** | Log in a persona / cleanly bounce the stack (no data wipe). |

### Dependency-aware sub-stacks (N-of-M)

`ss stack up --only scheduling-api,sessions-api` walks the manifest graph, computes the
**minimal dependency closure**, and boots just those services plus what they need — not all
~14. Test two services without paying for the whole stack.

### Bundles — common shapes in one word

`--with dash|connect|coach|playback|qtf|authz` expand to a set of `--only` includes (sugar
over the closure, composable: `--with dash --with coach`). Shared across `up`/`status`/
`verify`/`seed`/`reset`/`snapshot store`. See `ss stack bundle list`.

`--with authz` brings up the OpenFGA authorization stack: the `openfga` mesh unit, iam-api
with `FGA_ENABLED=true`, the `fga-bootstrap` seed (model + canonical tuples), the `authz-sync`
RabbitMQ tuple projector, and **`authz-api`** — the PDP that serves check/require over its own
prisma-migrated `authz_db`, hydrated from the iam.* event projection (:3200, `/health/ready`).

### Slots — multiple stacks on one box

`--slot N` (1–9) brings up an **isolated** `soa-s<N>` stack: ports offset by `N*1000`,
project-keyed docker volumes, its own state + snapshot dirs. Several devs — or parallel
agents — run concurrent stacks with no clobbering. Slot 0 (default) is byte-identical to
the bash path. (Slot >0 is a backend sub-stack today; `connect` is excluded pending
literal-port tokenization.) → [docs/slots.md](./docs/slots.md)

### Worktree sets — parallel dev contexts, one name each

A **worktree set** names a `repo → worktree path` map bound to a slot
(`~/.saga-stack/worktree-sets.json`): `ss e2e run --set my-fix saga-dash/journey` runs
**that worktree's code and that worktree's `flows.json`** on the set's own stack, while
`main` and other sets keep running untouched. `ss set list|show|check` manage/validate;
`up`/`e2e run` re-check implicitly and a realpath-keyed prep lock + primary-checkout
refusal (`--allow-primary` to override) make two contexts building one checkout
impossible. Precedence: typed `--<repo>` flag > set > env > default.
→ [docs/worktree-sets.md](./docs/worktree-sets.md)

### Native prep — a fresh checkout provisions + migrates itself

For the native (`--only`/`--with`/slot) paths, `stack up` runs a faithful port of `up.sh`'s
`prep()` before launch: **install + build + `db:generate`** → **idempotent role/DB
provisioning** (incl. `coach_api`) → **migrate every closure DB** in canonical order, then
launch + seed. Idempotent (a re-up is a fast no-op) and validated byte-identical to
`up.sh`'s resulting schema. `--skip-prep` skips the build pass.

## `ss e2e …` — flows as data

E2e scenarios are **data** (`flows.json`), not hardcoded bash.

| Command | What it does |
| --- | --- |
| **`run`** | `ss e2e run <spa>/<flow>` → discover the flow → compute just the stack it needs → seed → run Playwright. `--through <stage>` runs a prefix of a progressive flow; `--headless`. |
| **`list`** | Discoverable SPAs, their flows, and stages. |
| **`traces`** | List preserved e2e run traces (newest first) with paste-ready show-trace commands. |

Onboarding a new SPA or scenario is a registry row + a `flows.json` entry (progressive
multi-stage journeys, prerequisites, foreground/AV markers, per-stage `requiredSystems`) —
**zero new orchestration code**. A clamped occurrence-date is injected so weekend runs don't
flake.

## `ss develop …` — concierge stacks for hands-on work

Where `e2e` *runs test flows*, `develop` *sets up + hands off* a developable stack: bring up
the closure, reset + seed it, then drop you into a running app to drive by hand.

| Command | What it does |
| --- | --- |
| **`connect`** | Open a live interactive Connect session (1 tutor + 2 students). Migrated from `e2e connect` (the old id still works with a deprecation warning). |
| **`session-adm`** | The live SESSION-attendance ADM demo: 3 staggered Connect students self-report telemetry dosage onto an auto-opened admin attendance dash. |

→ [docs/develop.md](./docs/develop.md)

## Architecture

- **`core/**` — pure, no IO:** the frozen `manifest` (services/databases/mesh), `computeClosure`
  (N-of-M dependency engine), launch-order + launch-env resolution, seed-plan composition,
  bundles, the slot factory (`deriveInstance`), flow resolution. Unit-tested exhaustively.
  The boundary is enforced by an ESLint `no-restricted-imports` rule.
- **`runtime/**` — IO only, behind injectable seams:** docker/pnpm/psql/git runners
  (`Runner`), health prober, snapshot store, native prep/provision/migrate/reset, launcher.
- **`commands/**`** — thin oclif commands over the core + runtime, with `emit()` giving the
  human / `--output-json` / `--porcelain` triple output.

Because the manifest is the single source of truth, native `status`/`verify` cover endpoints
the hand-maintained `verify.sh` list missed, a missing sibling repo is skipped-with-a-warning
(not a red stack), and adding a service is a manifest edit — not code sprawl.

## Plan

Authoritative design, research, decisions, and the elevator pitch:
`soa/claude/projects/gh_214/` (saga-ed/soa#214) — start with `plans/01-saga-stack-cli-plan.md`
and `ELEVATOR-PITCH.md`.

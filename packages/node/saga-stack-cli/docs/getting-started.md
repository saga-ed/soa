# Getting started with `ss`

`ss` (a.k.a. `saga-stack`) brings the **synthetic saga dev stack** up, seeds it, verifies it,
snapshots it, and runs end-to-end flows against it — natively, from one CLI, driven by a
single frozen service manifest. It replaces the synthetic-dev bash scripts (which stay in
place; `ss` is the recommended-but-optional path).

This page is the **happy path** — copy-paste each command and expand the summary to see the
real output. For the detail behind each feature, follow the peer-doc links at the bottom.

> Every output block below is collapsed: the **one-line summary is the headline**; click to
> expand the full output.

---

## 1. Install

Install workspace deps from the monorepo root (once), then build the CLI and put it on your PATH:

```bash
cd ~/dev/soa && pnpm install
cd packages/node/saga-stack-cli && pnpm build && pnpm link --global
```

<details><summary>✓ <code>ss</code> and <code>saga-stack</code> are now on your PATH, runnable from any directory</summary>

```
$ ss --version
@saga-ed/saga-stack-cli/0.0.1 linux-x64 node-v24.12.0
```

`pnpm install` runs at the **monorepo root** — this is a pnpm workspace, so deps for the CLI (and
every sibling package) resolve from there; it only needs re-running when dependencies change. In a
VSCode / Claude Code shell `NODE_ENV=production` is set by default and silently skips
devDependencies — prefix with `NODE_ENV=development pnpm install` there (see `claude/tooling/pnpm.md`).

Re-run `pnpm build` after pulling CLI changes. No-build alternative (runs from `src` via
tsx): `node <abs-path>/bin/dev.js …`. Every command supports `--output-json` and `--porcelain`
for scripting, and `--help` at every level.
</details>

---

## 2. Start from a clean slate (cold start)

Running a tutorial or a demo? Reset the box to the team's **known-good baseline** first, so nothing
from yesterday leaks into the session. **Preview it first — `cold-start` is destructive** (it drops
the local mesh DB volumes):

```bash
ss stack cold-start --dry-run
```

<details><summary>Six phases, all previewed, <b>nothing changed</b>: docker wipe → ensure repos → repos to main → clean build → ensure .env → up + verify</summary>

```
▶ cold-start DRY RUN — nothing will be changed:
    docker: down -v the 'soa' mesh (containers + volumes)
    repos:  7 siblings → clone-if-missing, switch to main, ff to origin
    build:  rm -rf dist → rebuilt by up
    env:    scaffold missing .env from .env.example
    up:     up --reset --seed roster → verify
▶ 1/6 docker wipe … ▶ 2/6 ensure repos … ▶ 3/6 repos → main …
▶ 4/6 clean build … ▶ 5/6 ensure .env … ▶ 6/6 up + verify (SKIPPED — dry run)
✓ cold-start dry run complete — no changes made.
```

Happy with the plan? Drop `--dry-run` to run it for real — it **prompts once** before it destroys
anything (or `--yes` to skip the prompt for CI/agents):

```bash
ss stack cold-start            # scoped mesh wipe + full clean rebuild + up + verify
```

It forces every repo back onto `main` (a repo with **uncommitted changes is left as-is**, never
reset), rebuilds from clean, scaffolds any missing `.env` from its `.env.example`, then stands the
stack up and verifies it. Add `--all-docker` to also `docker system prune` the host, `--reinstall`
to wipe `node_modules`, `--seed full` for the full dataset. See **[cold-start.md](./cold-start.md)**
for every phase, flag, and safety note.
</details>

---

## 3. See what's there

```bash
ss stack --help
```

<details><summary>The <code>stack</code> topic: cold-start · up · down · status · verify · reset · seed · snapshot · overlay · bootstrap · login · restart · tunnel · bundle</summary>

```
Bring the synthetic dev stack up/down, seed, reset, verify, and log in.

  stack bundle     List the --with convenience bundles (name, services, seed).
  stack up         Bring the synthetic dev stack up. --only boots the dependency closure natively.
  stack down       Stop the running stack natively (kill-by-pidfile; --mesh also tears the mesh down).
  stack status     Show per-service health, probing manifest-derived endpoints.
  stack verify     Verify the stack: native health gate (+ --full data + source-posture).
  stack reset      Truncate the data DBs to an empty baseline + re-seed the dev user.
  stack seed       Seed a running stack (--with add-ons; --scenario/--dataset named datasets; --dry-run).
  stack snapshot   Store / restore / list / validate / delete native DB snapshots.
  stack overlay    Overlay your in-flight PRs onto a main-based stack.
  stack bootstrap  Stand the stack up on main (ensure repos → up → seed → verify).
  stack cold-start Clean slate: docker wipe (down -v) → repos to main → clean build → .env → up → verify.
  stack login      Log in a persona against the running stack (native cookie jar; --browser for headful).
  ...
```
</details>

---

## 4. Bring up a sub-stack

You rarely need all ~14 services. `--only` boots the **minimal dependency closure** — just
what you name plus what it needs. Dry-run first to see the plan:

```bash
ss stack up --only scheduling-api,sessions-api --dry-run
```

<details><summary>Closure = 4 services (iam → programs → scheduling → sessions) + 5 DBs + mesh — no docker touched</summary>

```
dry-run closure for: scheduling-api, sessions-api
services (launch order): iam-api -> programs-api -> scheduling-api -> sessions-api
databases: iam_local, iam_pii_local, programs, scheduling, sessions
mesh: postgres, redis, rabbitmq
reasons:
  iam-api: required by scheduling-api (url); required by sessions-api (url); required by programs-api (url)
  programs-api: required by sessions-api (event)
  scheduling-api: requested; required by sessions-api (event)
```
</details>

Drop `--dry-run` to bring it up for real. The native path does the whole job — install/build →
provision DBs → migrate → launch → seed:

```bash
ss stack up --only scheduling-api,sessions-api
```

<details><summary>✓ mesh healthy → migrations applied → services launched → seeded</summary>

```
 Container soa-postgres-1 Healthy
23 migrations found in prisma/migrations
Applying migration `20260415000000_init`
… (provision + migrate the closure DBs) …
native partial-stack up: 4 service(s) launched
launched: iam-api, programs-api, scheduling-api, sessions-api
  Created 30 users with profiles
Seed complete!
seed: OK
```

The whole prep is idempotent — a re-`up` is a fast no-op. See **[sub-stacks-and-bundles.md](./sub-stacks-and-bundles.md)**
for `--with` bundles (`dash`/`connect`/`coach`/`playback`/`qtf`) and how the closure engine works.
</details>

---

## 5. Check health

```bash
ss stack status
```

<details><summary>Per-service health, probing manifest-derived endpoints (read-only; never exits non-zero)</summary>

```
── service health ──
✓ iam-api          http://localhost:3010/health  (200)
✓ sis-api          http://localhost:3100/health  (200)
✓ programs-api     http://localhost:3006/health  (200)
✓ scheduling-api   http://localhost:3008/health  (200)
✓ sessions-api     http://localhost:3007/health  (200)
✗ saga-dash        http://localhost:8900/  (down)      ← not in this sub-stack
✗ connect-api      http://localhost:6106/connectv3/v1/health  (down)
…
```

`status` probes **every** service; the ones you didn't launch show `down`. Scope it to your
closure with `ss stack status --only scheduling-api,sessions-api` to see just what you brought up.
</details>

For a **gating** check (exits non-zero if a required service is down), use `verify`. Scope it to
your sub-stack's closure with `--only` — the gate then passes on just what you launched:

```bash
ss stack verify --only scheduling-api,sessions-api
```

<details><summary>✓ native health gate scoped to the closure — exits 0 only if every required service is up</summary>

```
✓ iam-api          http://localhost:3010/health  (200)
✓ programs-api     http://localhost:3006/health  (200)
✓ scheduling-api   http://localhost:3008/health  (200)
✓ sessions-api     http://localhost:3007/health  (200)
verify: PASS — 4/4 required services up
```

Add **`--full`** for the deep **data (D1–D5)** + **source-posture** checks — but note `--full`
checks the **whole** stack and **ignores `--only`** (it warns if you pass both), so run it against a
full `ss stack up`, not a sub-stack (on a partial stack it fails on the services you never launched):

```bash
ss stack verify --full        # full stack: health gate + data + git-posture
```

```
── service health ──
✓ iam-api … ✓ sis-api … ✓ programs-api … ✓ scheduling-api … ✓ sessions-api …
── data ──
✓ iam roster seeded — users=248   ✓ sis_db migrated   ✓ connect-mongo reachable (:27037)
── source posture ──
· soa on a feature branch (not main) — leaving overlay/feature branch as-is
✓ verify --full: health + data green (N posture warning(s))
```

Posture warnings (wrong branch, behind origin, unmerged pin) **never** fail verify — only a
down service or missing data does. See **[verify.md](./verify.md)**.
</details>

---

## 6. Run an end-to-end flow

E2e scenarios are **data** (`flows.json`), not scripts. Dry-run to see the plan:

```bash
ss e2e run saga-dash/journey --through sessions --dry-run
```

<details><summary>The journey flow: 6 stages, computes just the 6-service stack it needs, resets + seeds</summary>

```
dry-run: saga-dash/journey (lane stack, headed)
stages: roster -> program -> enrollment -> pods -> schedule -> sessions
closure (6): iam-api, sis-api, programs-api, scheduling-api, sessions-api, saga-dash
databases: iam_local, iam_pii_local, programs, scheduling, sessions, sis_db
reset+seed: yes
```
</details>

Run it — `ss` brings up the flow's stack, seeds it, and runs Playwright:

```bash
ss e2e run saga-dash/journey --through sessions --headless
```

<details><summary>✓ 20/20 — the full teacher journey (roster → program → enrollment → pods → schedule → sessions)</summary>

```
  ✓  14 [stage-4-pods]     › Pod membership survives a reload (576ms)
  ✓  15 [stage-5-schedule] › Admin sets a weekly time and term dates for the period (2.2s)
  ✓  16 [stage-5-schedule] › The schedule expands into a real slot joined to every pod (410ms)
  ✓  17 [stage-5-schedule] › The saved schedule survives a reload (549ms)
  ✓  18 [stage-6-sessions] › Sessions appear for a scheduled day (411ms)
  ✓  19 [stage-6-sessions] › A session can be started and ended (admin, via grant) (412ms)
  ✓  20 [stage-6-sessions] › The sessions page loads live session data for the program (578ms)
  20 passed (33.7s)
```

`--through <stage>` runs a prefix of a progressive flow. See **[e2e.md](./e2e.md)** for
authoring flows, `e2e list`, and `e2e connect` (live interactive Connect session).
</details>

---

## 7. Tear it down

```bash
ss stack down
```

<details><summary>✓ services stopped natively (kill-by-pidfile); the mesh stays up for a fast next start</summary>

```
slot 0: stopped 4 service(s) from /tmp/sds-synthetic (native kill-by-pidfile — no host-global pkill)
stopped: iam-api, programs-api, scheduling-api, sessions-api
```

Add `--mesh` to also tear down postgres/redis/rabbitmq/mongo (containers only — the volumes
survive; use **[`cold-start`](./cold-start.md)** for a `down -v` data wipe). `down` is fully native
and slot-safe — it stops exactly the pids *this* stack recorded, never a host-global `pkill`, and
**post-down it audits the slot's port band** and warns loudly about any watch child that survived
(soa#249/#250), so a stale-build server can't linger and serve old code.
</details>

---

## 8. Work in parallel — slots, worktree sets & stage checkpoints

Everything above ran on **slot 0**, the shared baseline. One box hosts up to **10 isolated stacks**
— slots `0`–`9` — each with its own docker project (`soa` / `soa-sN`), port band (offset `N×1000`),
state dir (`/tmp/sds-synthetic[-sN]`) and snapshot store. Slot 0 is the team baseline; **slots 1–9
are your parallel dev contexts.** (`cold-start`, `restart`, `overlay` and `up --tunnel/--sandbox`
are **slot-0 only**; a slot >0 is a backend + `connect-api` sub-stack (connect-api boots there
as of soa#271) — only the playback trio and `connect-web` don't (playback carries literal ports;
connect-web needs slot-0-only single-node livekit AV).)

### 8a. Run a flow on slot 0 — current checkout vs latest main

By default a flow runs against **whatever you have checked out** on slot 0:

```bash
ss e2e run saga-dash/journey --through sessions --headless      # your working trees, slot 0
```

To instead run against **latest `main` across every repo**, rebase the box to main first, then reuse
that stack (`--skip-reset` keeps the seeded state):

```bash
ss stack bootstrap                                              # stand up on main (non-destructive): ensure repos → up → seed → verify
ss e2e run saga-dash/journey --through sessions --skip-reset --headless
```

<details><summary>Why two commands: there is no <code>--main</code> flag — the baseline is a separate step</summary>

`e2e run` has no `--main`/`--latest`/`--pull` flag; it runs against the checkout the repo paths
resolve to. `bootstrap` stands the stack up **on main** non-destructively; for a **guaranteed-clean**
main baseline use the destructive `ss stack cold-start` instead (docker `down -v` → repos to main →
ff origin → clean build → up + seed). Then any `ss e2e run … --skip-reset` exercises that main-based
stack. See **[integration.md](./integration.md)**.
</details>

### 8b. A feature branch on slot 1 — via a worktree set

To run a branch **without disturbing slot 0**, put it in a git worktree and bind it to a slot with a
**worktree set**. `ss set create` is the one-command concierge — it does the `git worktree add` (new
branch here), `pnpm install`s the worktree so the prep fresh-skip guard is happy, and records the set
in `~/.saga-stack/worktree-sets.json` with provenance (`createdBy: ss`), bound to the slot:

```bash
ss set create feat-sched --slot 1 --repo saga-dash \
  --path ~/dev/worktrees/saga-dash-sched --branch feat/sched-tweak
```

<details><summary>What it did — and the manual equivalent</summary>

`--branch` is created if new, **attached** if it already exists; `--base <ref>` sets the start point
(default: the primary checkout's HEAD). Skip the install with `--no-install`. The slot is part of the
set (1–9; slot 0 is the baseline). Equivalent by hand (still fully supported — the file is
hand-editable, and `$SAGA_STACK_SETS` overrides its location):

```bash
git -C ~/dev/saga-dash worktree add ~/dev/worktrees/saga-dash-sched -b feat/sched-tweak
( cd ~/dev/worktrees/saga-dash-sched && pnpm install )
# then add to ~/.saga-stack/worktree-sets.json:
#   { "version": 1, "sets": { "feat-sched": { "slot": 1,
#       "repos": { "saga-dash": "~/dev/worktrees/saga-dash-sched" } } } }
```
</details>

Bring it up and run a flow — all on slot 1, addressed by `--set` (which supplies the slot and pins
the repo to your worktree; the rest of the closure comes from your default checkouts):

```bash
ss set check feat-sched                                         # preflight: paths, build posture, drift
ss stack up --set feat-sched                                    # boots on slot 1 from the worktree
ss e2e run --set feat-sched saga-dash/journey --through schedule --headless
```

<details><summary>Why a set, not <code>ss stack overlay</code> — overlay is a different tool</summary>

`ss stack overlay` stacks **in-flight PR numbers** onto your **slot-0 primary checkouts** (managed
repos: rostering, program-hub, saga-dash); it's slot-0-only and **skips any repo you've pinned to a
worktree**. So "overlay a worktree onto slot 1" isn't a thing — the worktree **set** is the
mechanism for running a branch on its own slot. `--set` plus a conflicting `--slot` is a hard error
(the set owns its slot). See **[worktree-sets.md](./worktree-sets.md)** and
**[integration.md](./integration.md)**.
</details>

### 8c. A second branch on slot 2 — a different worktree, a different flow

Repeat with another worktree bound to **slot 2** (unique slot — two sets can't share one):

```bash
ss set create feat-conn --slot 2 --repo saga-dash \
  --path ~/dev/worktrees/saga-dash-conn --branch feat/connect-polish
ss set check feat-conn
ss stack up --set feat-conn
ss e2e run --set feat-conn saga-dash/connect-session --headless   # a different flow, on slot 2
```

Tear a set down when you're done — `ss set rm feat-conn` drops the set (worktrees left on disk), or
`ss set rm feat-conn --and-worktrees --yes` also `git worktree remove`s the worktrees `ss` created
(a hand-recorded checkout is never touched).

Slot 1 (`feat-sched`) and slot 2 (`feat-conn`) now hold independent stacks on different branches —
different ports, DBs and pidfiles — so `journey` on slot 1 and `connect-session` on slot 2 never
collide.

### 8d. Snapshot a flow and resume from a later stage

A progressive flow can **bake a DB checkpoint after each green stage**, so you can re-enter it
partway instead of replaying from stage 1. Bake once with `--snapshot-stages`:

```bash
ss e2e run saga-dash/journey --snapshot-stages --headless      # checkpoint after every green stage
```

Then start from a later stage — `--from` restores the *predecessor* stage's checkpoint and runs the
rest, so you iterate on stage 6 in seconds without re-driving 1–5:

```bash
ss e2e run saga-dash/journey --from sessions                   # restore stage-5 (schedule), run 6→end
ss e2e run saga-dash/journey --from 6 --through 7              # or just a window: stages 6–7
```

<details><summary>How checkpoints relate to <code>ss stack snapshot</code></summary>

Stage checkpoints are ordinary native snapshots named `flow-<spa>-<flow>-s<phase>-<stageId>`
(e.g. `flow-saga-dash-journey-s5-schedule`), stored in the slot's snapshot root and listed by
`ss stack snapshot list`. `--from` hard-validates the checkpoint (producing stages unchanged,
migration head, matching seed profile, ≤7 days — override the age gate with `--from-stale-ok`) and
**can't** be combined with `--skip-reset` (the restore *is* the state source). You must bake with
`--snapshot-stages` before you can `--from`; there's no implicit mid-flow start.

For hand-managed fixtures, the raw snapshot verbs work on any slot/set:

```bash
ss stack snapshot store --fixture-id my-baseline    # store (name is the --fixture-id FLAG)
ss stack snapshot list                              # what's stored
ss stack snapshot restore my-baseline               # restore (name is a positional here)
```

`store` takes `--fixture-id <name>`; `restore`/`validate`/`delete` take a bare positional. See
**[snapshots.md](./snapshots.md)** and **[e2e.md](./e2e.md)**.
</details>

### 8e. See what's where — sets, branches, slot usage

```bash
ss set list                                                    # every set: name, slot, live?, repos
```

<details><summary>NAME · SLOT · ACTIVE (derived live) · REPOS — one row per set</summary>

```
NAME        SLOT  ACTIVE  REPOS
────────────────────────────────────────────────
feat-sched  1     ● up    saga-dash  (scheduling tweak)
feat-conn   2     —       saga-dash  (connect polish)
```

`ACTIVE` is derived live (pidfiles under `/tmp/sds-synthetic-sN` + running `soa-sN` containers),
never stored. Drill into one set for **branch, dirtiness and how far behind `main`** each worktree
is:

```bash
ss set show feat-sched     # per-repo: branch, clean/dirty, path, provenance, [behind origin/main by N]
ss set check feat-sched    # the preflight up/e2e runs first (exits non-zero on a violation)
```

**Slot usage:** there's no global "which slots are up" view — `ss set list`'s ACTIVE column covers
only slots that have a **defined set**, and `ss stack status --slot N` probes **one** slot's health.
A bare `ss stack up --slot 3` with no set records no provenance. Under the hood, occupancy = pidfiles
in `/tmp/sds-synthetic[-sN]` + `docker ps` filtered by project `soa[-sN]`. See **[slots.md](./slots.md)**
and **[worktree-sets.md](./worktree-sets.md)**.
</details>

---

## The everyday command set

| Command | What it does | Detail |
|---|---|---|
| `ss stack up [--only\|--with] [--slot N]` | Bring up a sub-stack (or full stack), native prep→migrate→launch→seed | [sub-stacks](./sub-stacks-and-bundles.md) · [slots](./slots.md) |
| `ss stack status` / `verify [--full]` | Health (read-only) / gating health + data + posture | [verify](./verify.md) |
| `ss stack seed [--with …] [--scenario …]` / `reset` | Seed a running stack (add-ons + named datasets/scenarios) / truncate to an empty baseline + re-seed | [sub-stacks](./sub-stacks-and-bundles.md) |
| `ss stack snapshot store\|restore\|list` | Save/restore a known-good DB state in seconds | [snapshots](./snapshots.md) |
| `ss e2e run\|list\|connect` | Run/discover data-driven flows; open a live Connect session | [e2e](./e2e.md) |
| `ss set create\|rm\|list\|show\|check` + `--set <name>` | Named worktree sets: create/tear-down a worktree+branch+slot binding, then run `up`/`e2e run`/… against it | [worktree-sets](./worktree-sets.md) |
| `ss stack overlay\|bootstrap\|login\|tunnel` | Integration workflows (in-flight PRs, one-command bring-up, personas, sharing) | [integration](./integration.md) |
| `ss stack cold-start [--dry-run] [--all-docker]` | Clean slate: docker wipe (`down -v`) → repos to main → clean build → `.env` → up → verify (destructive; slot-0) | [cold-start](./cold-start.md) |
| `ss stack down [--mesh] [--slot N]` | Stop the stack natively | [slots](./slots.md) |

---

## Peer docs

- **[sub-stacks-and-bundles.md](./sub-stacks-and-bundles.md)** — `--only` closures, `--with` bundles, seeding
- **[slots.md](./slots.md)** — `--slot N`: multiple isolated stacks on one box
- **[worktree-sets.md](./worktree-sets.md)** — `--set <name>`: named repo→worktree maps on slots (parallel dev contexts, per-worktree flows, build-collision guard)
- **[verify.md](./verify.md)** — the health / data / source-posture checks (and what fails vs warns)
- **[snapshots.md](./snapshots.md)** — store/restore DB fixtures instead of re-seeding
- **[e2e.md](./e2e.md)** — flows-as-data, `e2e run`/`list`/`connect`
- **[e2e-flows.md](./e2e-flows.md)** — the browsable flow worlds (hermetic-flow viewer)
- **[integration.md](./integration.md)** — `overlay` (in-flight PRs), `bootstrap`, `login`, `tunnel`
- **[cold-start.md](./cold-start.md)** — `cold-start`: the destructive clean-slate baseline (docker wipe → repos to main → clean build → `.env` → up)
- **[faq.md](./faq.md)** — "How do I…?" with real output under disclosure triangles

For architecture and the design history, see the package [README](../README.md) and
`soa/claude/projects/gh_214/`.

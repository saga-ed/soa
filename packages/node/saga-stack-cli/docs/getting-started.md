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

```bash
cd ~/dev/soa/packages/node/saga-stack-cli && pnpm build && pnpm link --global
```

<details><summary>✓ <code>ss</code> and <code>saga-stack</code> are now on your PATH, runnable from any directory</summary>

```
$ ss --version
@saga-ed/saga-stack-cli/0.0.1 linux-x64 node-v24.12.0
```

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

For a gating check (exits non-zero if a required service is down) plus deep data + git-posture
checks, use `verify`:

```bash
ss stack verify --full --only scheduling-api,sessions-api
```

<details><summary>✓ native health gate + data checks (D1–D5) + source-posture — all warn-only for posture</summary>

```
── service health ──
✓ iam-api          http://localhost:3010/health  (200)
✓ programs-api     http://localhost:3006/health  (200)
✓ scheduling-api   http://localhost:3008/health  (200)
✓ sessions-api     http://localhost:3007/health  (200)
── data ──
✓ iam_local seeded, sis_db migrated, connect-mongo reachable …
── source posture ──
· soa on gh_214 (not main) — leaving overlay/feature branch as-is
✓ verify: health + data green (N posture warning(s))
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

## The everyday command set

| Command | What it does | Detail |
|---|---|---|
| `ss stack up [--only\|--with] [--slot N]` | Bring up a sub-stack (or full stack), native prep→migrate→launch→seed | [sub-stacks](./sub-stacks-and-bundles.md) · [slots](./slots.md) |
| `ss stack status` / `verify [--full]` | Health (read-only) / gating health + data + posture | [verify](./verify.md) |
| `ss stack seed [--with …] [--scenario …]` / `reset` | Seed a running stack (add-ons + named datasets/scenarios) / truncate to an empty baseline + re-seed | [sub-stacks](./sub-stacks-and-bundles.md) |
| `ss stack snapshot store\|restore\|list` | Save/restore a known-good DB state in seconds | [snapshots](./snapshots.md) |
| `ss e2e run\|list\|connect` | Run/discover data-driven flows; open a live Connect session | [e2e](./e2e.md) |
| `ss set list\|show\|check` + `--set <name>` | Named worktree sets: parallel dev contexts (repo map + slot) for `up`/`e2e run`/… | [worktree-sets](./worktree-sets.md) |
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

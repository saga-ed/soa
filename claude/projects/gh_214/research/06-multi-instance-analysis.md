# Research 06 — concurrent multi-stack support (and how saga-stack-cli changes it)

> Question: what would it take to run 2+ synthetic-dev stacks on one machine, so
> agents on different initiatives stop competing for the single stack? Synthesizes
> the existing `multi-synthetic-dev` prior art, a fresh single-instance hardcoding
> inventory, and a readiness audit of the new `saga-stack-cli`.

## TL;DR

- The problem is fully understood and a sound design already exists: the
  **`multi-synthetic-dev`** track (research + plan, 2026-06-09, **no code yet**)
  specified an **instance-key / `SLOT`** model — one key derives a port offset,
  `COMPOSE_PROJECT_NAME`, `SEED_PROFILE`, `STATE` dir, and git-worktree source
  roots, with `SLOT=0` = today byte-for-byte. **Architecture A (separate mesh per
  instance)** was recommended over shared-mesh-with-suffixed-DBs.
- **The big update:** building it in **bash** (the prior art's target) is now the
  wrong move — we're replacing `up.sh` with `saga-stack-cli`, and that CLI already
  centralizes *exactly* the things an instance key must offset. Multi-instance
  drops from a ~30-call-site bash refactor across 5 scripts to a **small,
  contained CLI feature** (`--instance/--slot` → one derived `LaunchContext`).
- **saga-stack-cli is ~70–80% ready.** Already parameterized: service **ports**
  (`portOverrides`), **state dir** (`--state-dir`), **repo roots** (`--<repo>` →
  worktrees), **mesh container names** (`SAGA_MESH_*_CONTAINER`). The remaining
  gaps are few and concrete (mesh-port offset, `COMPOSE_PROJECT_NAME` passthrough,
  `SEED_PROFILE`/volume isolation, and the derive-from-key glue).
- One **infra fix is shared by both paths**: the postgres volume is keyed on
  `SEED_PROFILE`, *not* on project — so two meshes with different project names but
  the same profile silently share one volume. Must be addressed.

## Why one stack only today (collisions — current evidence)

Every instance-varying resource is a fixed literal. Highlights (full matrix in the
research thread; cites are current `up.sh`/infra lines):

| Layer | Hardcoded | Where | Two stacks collide on |
|---|---|---|---|
| STATE | `/tmp/sds-synthetic` | up.sh:293 | pid/log/cookie/browser races; `--down` kills the wrong stack; global `pkill -f tsup` (up.sh:1830) kills the other's watchers |
| Service ports | 3006-3010, 3100, 5005, 6106/6110/6210, 8900, 6301-6303 | up.sh:182-245, launch lines | `pnpm dev` can't bind |
| Mesh ports | 5432/6379/5672/15672/27037 | up.sh:486, 540-542 | docker can't bind |
| Compose project | `COMPOSE_PROJECT_NAME := soa` | infra/Makefile:29 | containers `soa-*-1` shared; `docker exec` hits the wrong one |
| **PG volume** | `postgres-profile-${SEED_PROFILE}` | postgres/compose.yml | **profile-keyed, NOT project-keyed → silent shared volume** (the sharp edge) |
| Other volumes | `redis-data`, `rabbitmq-data`, `connect-mongo-data` | compose files | cache/event/CRDT corruption |
| In-tree source | `.env.local`, tracked `config.json`, `.vite` caches | up.sh:398-478, 1841-1848 | services run `pnpm dev` in the checkout → can't hold two branches; env files fight; `nuke_vite` clears both |
| DB names | `iam_local`, `programs`, … (shared postgres) | up.sh:190-193, reset_data:1580 | migrate/seed/truncate races |

The only escape today (alternate repo paths + a *separate docker*) doesn't solve
ports or STATE on one host. **There is no clean same-machine concurrency now.**

## The design (from the prior art — still correct)

**Architecture A — separate mesh per instance.** Each instance = own containers,
own volumes, own ports, own branches. Pros: zero crosstalk (postgres/redis/rabbitmq
physically separate — avoids a whole class of cache/event-bus bugs), preserves
`pnpm dev`/HMR. Cons: ~1–1.5 GB RAM per extra mesh + worktree build cost. Beats
Architecture B (shared mesh, suffixed DBs) because B leaves redis/rabbitmq
crosstalking unless you also add vhosts + redis db-indexes — and A needs **no
per-instance DB renaming at all** (each instance's own postgres uses the same DB
names), which is a much better fit for the manifest.

**Instance key → derived values** (the `SLOT` table): `OFFSET = SLOT*100`; every
port = base+OFFSET; `COMPOSE_PROJECT_NAME=soa-$KEY`; `SEED_PROFILE=$KEY`;
`STATE=/tmp/sds-synthetic-$KEY`; `DEV=$HOME/dev/wt/$KEY` (worktree root). `SLOT=0`
reproduces today exactly. Sharp edges: the dash `config.json` ports must match the
instance's services (or the dash silently talks to the wrong iam); the profile-keyed
volume; worktree build cost; ~4 GB RAM/instance.

## How saga-stack-cli changes the calculus (the new finding)

The prior art's thesis was "make the stack a function of one instance key" — but in
bash that means rewriting ~30 call-sites across `up.sh` + threading `KEY` through
verify/refresh/bootstrap. **saga-stack-cli already did the hard part of that
refactor for a different reason:** the M0 manifest + M4 `LaunchContext` centralize
ports, URLs, DB connection strings, container names, and repo roots into pure,
parameterized data. The instance key is now just *inputs to that context*.

### Already parameterized (multi-instance gets these for free)
- **Service ports** — `LaunchContext.ports` + `LaunchContextInputs.portOverrides`
  (`core/launch-plan.ts`). URLs are derived as `http://localhost:${port}` — so an
  offset port *automatically* yields the right URL **on the same machine** (the
  audit's "localhost blocks multi-instance" is a non-issue for one host; localhost
  is correct, only the port must differ, and it does).
- **STATE dir** — `--state-dir` flag (`shared-flags.ts`) + `SAGA_MESH_SNAPSHOTS_DIR`.
- **Repo roots** — `--soa/--rostering/…` flags + env (`runtime/scripts.ts`) →
  point each instance at its own git worktree, no new mechanism needed.
- **Mesh container names** — `SAGA_MESH_<UNIT>_CONTAINER` overrides (`runtime/mesh.ts`).

### The concrete remaining gaps (small, contained)
1. **Mesh-port offset.** `defaultLaunchContext` reads pg/mq/mongo ports from the
   fixed manifest mesh defs, and `runtime/mesh.ts` hardcodes `make up …
   POSTGRES_PORT=… PROFILE=empty`. Add mesh-port overrides to the context + the
   `make up` call (the service-port `portOverrides` plumbing already shows the pattern).
2. **`COMPOSE_PROJECT_NAME` passthrough.** `make up` hardcodes `PROJECT=saga-mesh`
   (singleton). Pass `COMPOSE_PROJECT_NAME=soa-$KEY` so containers are per-instance,
   and auto-set the `SAGA_MESH_*_CONTAINER` overrides to the matching `soa-$KEY-*-1`.
3. **`SEED_PROFILE`/volume isolation.** Pass `SEED_PROFILE=$KEY` (or fix the infra
   volume to be project-keyed) so instances don't share `postgres-profile-empty`.
   *(Shared infra fix — see below.)*
4. **The derive-from-key glue.** A new `--instance <key>`/`--slot <n>` global flag
   that computes the offset + names once and feeds context/mesh/state/repo. This is
   the only genuinely new surface; everything else is wiring existing knobs.
5. **Worktree provisioning** — a `stack new-instance <key>` helper (`git worktree add`
   ×repos + `pnpm install` + write the instance config). Optional but ergonomic.

Net: **DB names need NO change** under Architecture A (each instance has its own
postgres), which is the single biggest simplification the CLI + Arch-A combo buys.

### Shared infra fix (needed by bash OR CLI)
`infra/Makefile` `COMPOSE_PROJECT_NAME := soa` → `?=` (backward-compatible), and
make the postgres (and redis/rabbitmq/mongo) volume names **project-keyed** (or rely
on per-instance `SEED_PROFILE`). Confirm empirically (prior-art Q1) that two project
names with the same profile really do share the volume today.

## Recommendation

1. **Build multi-instance as a saga-stack-cli feature, not a bash refactor.** Treat
   the `multi-synthetic-dev` plan as the *spec*; retarget its implementation from
   `up.sh` to the CLI. Doing it in bash now is throwaway (we're retiring `up.sh`),
   and the CLI makes it dramatically smaller.
2. **It rides on the native path.** Multi-instance lives on the M4 native
   (`stack up --only`/full-native) path — which is exactly the path pending a live
   soak. So sequence it *after/with* the soak: `M7 — multi-instance (--slot)`,
   depending on M4/M6 native bring-up proving out.
3. **Land the shared infra fix now (cheap).** The `Makefile ?=` + volume-keying +
   the empirical volume check is a tiny, standalone soa PR (prior-art Phase 0) that
   helps either path and unblocks two *meshes* immediately.
4. **Immediate relief is limited.** Until M7, the only real same-machine isolation
   is worktrees + a second mesh via the infra fix + manual container overrides —
   but offset *service* ports need the CLI (`up.sh` can't). So the honest near-term
   answer to "agents competing for synthetic-dev" is: prioritize the native-path
   soak → then M7. A stopgap is a simple **lease/lock** (one agent holds the single
   stack at a time) rather than true concurrency.

## Effort / risk (CLI path)

| Piece | Effort | Risk |
|---|---|---|
| infra `Makefile ?=` + volume keying + verify | trivial | low (backward-compatible) |
| `--slot/--instance` derive + thread mesh ports/project/profile | **medium** | medium — contained to context+mesh runtime; `SLOT=0` regression-guards |
| auto-set container overrides per instance | small | low |
| `stack new-instance` worktree helper | small-medium | low |
| validation: dash config ports match instance (the crosstalk trap) | small | medium — must be explicitly tested |

Far smaller than the bash plan's "~30 call-sites across 5 scripts," because the
manifest/context already is the single parameterization point the prior art wanted.

## Cross-references
- `~/dev/soa/claude/projects/multi-synthetic-dev/` — the prior-art spec (inventory +
  SLOT design + phased rollout). This doc retargets its implementation onto the CLI.
- `gh_214/plans/01-saga-stack-cli-plan.md` (manifest §2.2, launch-plan §6.3),
  `02-handoff-and-status.md` (native-path soak gate), `03-soak-plan.md`.

# M7 — multi-instance / concurrent stacks (`--slot`) (#214)

> Plan for running 2+ isolated synthetic-dev stacks on one machine via the CLI, so
> agents on different initiatives stop competing for the single stack. Built on the
> analysis in `../research/06-multi-instance-analysis.md`; retargets the
> `multi-synthetic-dev` bash spec onto saga-stack-cli. Architecture A (separate mesh
> per instance). Depends on the M4 native path soaking (`02-handoff-and-status.md`).

## Context

The synthetic-dev stack assumes one instance per host (fixed ports, `STATE=/tmp/sds-synthetic`,
`COMPOSE_PROJECT_NAME=soa`, profile-keyed postgres volume, in-tree `pnpm dev`). Two
agents → `--reset` wipes each other, ports collide, `--down` kills the wrong stack.
The prior `multi-synthetic-dev` track specced the fix in bash; we build it in the CLI
instead — the manifest + `LaunchContext` already centralize what an instance key must
offset, so this is a small contained feature, not a 30-call-site bash refactor.

## Model: one instance key derives everything (Architecture A)

A single `--slot <n>` (and/or `--instance <key>`) drives a pure derivation. `SLOT=0`
reproduces today byte-for-byte (the regression guard).

| Derived | Formula | SLOT 0 | SLOT 1 |
|---|---|---|---|
| `OFFSET` | `SLOT*100` | 0 | 100 |
| service ports | `base + OFFSET` (saga-dash `8900 + SLOT`) | 3010/3006/…/8900 | 3110/3106/…/8901 |
| mesh ports | `base + OFFSET` | 5432/6379/5672/15672/27037 | 5532/6479/5772/15772/27137 |
| `COMPOSE_PROJECT_NAME` | `soa-s$SLOT` (or `soa-$KEY`) | `soa` | `soa-s1` |
| mesh container names | `${project}-<unit>-1` | `soa-postgres-1` | `soa-s1-postgres-1` |
| `SEED_PROFILE` | `$KEY` (volume isolation) | `empty` (today) | `s1` |
| `STATE` | `/tmp/sds-synthetic[-$KEY]` | `/tmp/sds-synthetic` | `/tmp/sds-synthetic-s1` |
| repo roots (`DEV`) | per-instance git worktrees | `$HOME/dev/<repo>` | `$HOME/dev/wt/s1/<repo>` |

DB **names are unchanged** — each instance has its own postgres (Arch A), so no
manifest DB-renaming. That is the big simplification vs the shared-mesh option.

## What's already there (reuse, no change)

- **service ports** — `LaunchContext.ports` + `LaunchContextInputs.portOverrides` (`core/launch-plan.ts`); URLs derive from the (overridable) port, so an offset flows through on the same host.
- **STATE dir** — `--state-dir` flag (`shared-flags.ts`) + `SAGA_MESH_SNAPSHOTS_DIR`.
- **repo roots** — `--<repo>` flags / env (`runtime/scripts.ts`) → point at worktrees.
- **mesh container names** — `SAGA_MESH_<UNIT>_CONTAINER` overrides (`runtime/mesh.ts`).

## The deltas to build (concrete)

1. **`--slot` / `--instance` global flag + derivation** (`src/shared-flags.ts` + a new
   pure `src/core/instance.ts`): `deriveInstance({slot, key})` → `{ offset, ports,
   meshPorts, project, seedProfile, stateDir, containerNames }`. PURE + unit-tested;
   `SLOT=0` returns today's values exactly.
2. **Mesh-port offset** (`src/core/launch-plan.ts` + `src/runtime/mesh.ts`): thread
   mesh ports through the context (today pg/mq/mongo ports are read fixed from the
   manifest mesh defs); pass the offset ports to `make up POSTGRES_PORT=… REDIS_PORT=…`
   and into the DB/MQ/mongo URL tokens. (Service `portOverrides` already shows the pattern.)
3. **`COMPOSE_PROJECT_NAME` passthrough** (`src/runtime/mesh.ts`): pass
   `COMPOSE_PROJECT_NAME=$project` to `make up` (today hardcodes `PROJECT=saga-mesh`),
   and auto-set the `SAGA_MESH_*_CONTAINER` overrides to the matching `${project}-*-1`
   so snapshot/reset/status target the right containers.
4. **`SEED_PROFILE` per instance** — pass `SEED_PROFILE=$key` to the mesh so volumes
   don't collide (depends on the infra fix below).
5. **State-dir defaulting** — when `--slot/--instance` is set, default `--state-dir`
   to `/tmp/sds-synthetic-$key` unless overridden.
6. **`stack new-instance <key> [--slot n]`** (new command) — provision: `git worktree
   add` each managed repo into `$HOME/dev/wt/$key/<repo>`, `pnpm install` per worktree,
   write an instance config the other commands read. Optional but the ergonomic entry.
7. **`stack ls-instances` / status across instances** (small) — list running instances
   (by STATE dir / compose project) so an agent can see what's up.

## Shared infra fix (land first — helps any path, tiny soa PR)

- `infra/Makefile`: `COMPOSE_PROJECT_NAME := soa` → `?=` (backward-compatible).
- Make the postgres (and redis/rabbitmq/connect-mongo) docker **volume names
  project-keyed**, OR rely on per-instance `SEED_PROFILE`. **Verify empirically**
  (prior-art Q1) that two project names + same profile really share the volume today
  — that is the silent-corruption sharp edge.

## The crosstalk trap to test explicitly

The dash trusts `config.json`/`config.local.json` ports. If a derived service port
and the dash's config disagree, the dash silently talks to the **wrong instance's
iam** — corruption, not a crash. The `sync-dash-local-defaults` prelaunch hook
(already in M4) must write the instance's offset ports. **Add an integration test
asserting the dash config ports == the instance's resolved ports.**

## Tests (vitest, offline — fakes)

- `core/__tests__/instance.unit.test.ts`: `deriveInstance({slot:0})` == today's values
  (byte-for-byte); `{slot:1}` offsets every port +100, saga-dash +1, project `soa-s1`,
  state `/tmp/sds-synthetic-s1`, container `soa-s1-postgres-1`.
- `stack-api` / launch-plan: with a slot-1 context, every service launch env + health
  URL + DB URL + `make up` args carry the offset; no value stays at a base port.
- mesh runtime (mocked): `make up` receives `COMPOSE_PROJECT_NAME=soa-s1` + offset ports.
- the dash-config crosstalk assertion above.

## Sequencing & risk

- **Depends on the M4 native path soaking** (this rides the native launcher/mesh, not
  the up.sh wrapper). Do M7 after/with the soak in `03-soak-plan.md`.
- **Land the infra fix now** (standalone, cheap) — unblocks two *meshes* immediately
  and de-risks the volume question.
- **`SLOT=0` regression guard** keeps the default path identical to today.
- Effort: medium, contained to `core/instance.ts` + the mesh/launch-context threading;
  far smaller than the bash plan's ~30 call-sites across 5 scripts.
- Resource ceiling: ~4 GB RAM + a few cores per instance; document a max (e.g. SLOT 0–4).

## Near-term stopgap (before M7 lands)

True same-machine concurrency needs M7 (up.sh can't offset service ports). Until then,
the cheapest relief is a **lease/lock** so agents take turns on the single stack
(e.g. a flock/PID file checked by `stack up`) rather than clobbering each other — a
tiny addition that prevents the `--reset`-wipes-the-other-agent failure mode today.

## Cross-references
- `../research/06-multi-instance-analysis.md` — the analysis this plan executes.
- `~/dev/soa/claude/projects/multi-synthetic-dev/` — the original bash spec (now retargeted here).
- `01-saga-stack-cli-plan.md` (manifest §2.2, launch-plan §6.3), `02-handoff-and-status.md`, `03-soak-plan.md`.

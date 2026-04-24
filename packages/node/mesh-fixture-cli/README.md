# @saga-ed/mesh-fixture-cli

Cross-repo fixture authoring + snapshot lifecycle for the saga-mesh (rostering + program-hub + student-data-system).

**Status:** Phase 3 D3.1–D3.3 shipped. Built on oclif v4 (ported from commander 2026-04); commands are discovered from `dist/commands/<topic>/<verb>.js` via oclif's pattern strategy.

## Install (local-dev)

```bash
cd ~/dev/soa
pnpm install
pnpm -F @saga-ed/mesh-fixture-cli build
# Then invoke via the bin shim:
node ~/dev/soa/packages/node/mesh-fixture-cli/bin/run.js fixture:list
```

## Command surface

| Command | Status | Purpose |
|---|---|---|
| `fixture:list` | ✅ | List snapshots on disk under `~/.saga-mesh/fixtures/` |
| `fixture:store --fixture-id <id>` | ✅ | `pg_dump` all saga-mesh DBs → `~/.saga-mesh/fixtures/<id>/` + `manifest.json` |
| `fixture:restore --fixture-id <id>` | ✅ | `pg_restore` dumps + `redis-cli FLUSHDB` |
| `fixture:delete --fixture-id <id>` | ✅ | Remove a fixture's directory |
| `iam:create-org` | ✅ | rostering group creation (dedup by sourceId) |
| `iam:create-user` | ✅ | rostering user creation (dedup by username) |
| `iam:add-membership` | ✅ | parent-ordered membership (dedup by "already member") |
| `pgm:create-program` | ✅ | program-hub program creation (dedup by org+name) |
| `pgm:create-period` | ✅ | period under a program (dedup by program+name) |
| `pgm:enroll` | ✅ | school + section enrollment (upsert-shaped) |
| `ads:seed-attendance` | ⏸ deferred | blocked on Seth PR #77 coordination |

### Global flags

All commands accept:

- `--porcelain` — no color, scriptable tab-separated output
- `--output-json` — structured JSON on stdout
- `--iam-url <url>` — override rostering iam-api base URL (default: `http://localhost:3000`; env: `IAM_API_URL`)
- `--programs-url <url>` — program-hub programs-api (default: `:3006`; env: `PROGRAMS_API_URL`)
- `--ads-adm-url <url>` — SDS ads-adm-api (default: `:5005`; env: `ADS_ADM_URL`)

### Storage

Fixture snapshots live under `$SAGA_MESH_FIXTURES_DIR` (default `~/.saga-mesh/fixtures/<fixture-id>/`). Each fixture is a directory containing per-database `*.dump` files plus a `manifest.json`.

## How it fits the mesh

`mesh-fixture` is the next layer above `saga-mesh.sh` (in this same repo's `~/dev/soa/scripts/mesh/saga-mesh.sh`). `saga-mesh.sh` brings the mesh up; `mesh-fixture` seeds and snapshots data onto it.

A full local-dev round-trip:

```bash
saga-mesh.sh setup                           # mesh up
mesh-fixture iam:create-org --fixture-id demo-small --slug demo-small-org ...
# … more create-* commands
mesh-fixture fixture:store --fixture-id demo-small
saga-mesh.sh nuke                            # tear mesh down
saga-mesh.sh setup                           # fresh mesh
mesh-fixture fixture:restore --fixture-id demo-small   # data back, < 2min
```

The `fixture:store` + `fixture:restore` round-trip is Phase 3 D3.3's exit criterion.

## Roadmap

1. **D3.1 (this package)** — ✅ oclif v4 scaffold + all iam/pgm/fixture commands.
2. **D3.2** — add a `FixtureMetadata` Prisma model + `fixture.registry.*` tRPC router to each service. When that's live, the CLI will post a CommandInfo to `fixture.registry.addCommand` after every idempotent create, and a new `fixture:show` / `fixture:validate` pair will query across services.
3. **D3.3** — ✅ pg_dump/pg_restore + FLUSHDB mechanics.
4. **D3.7** — resolve the Phase-2 setup idempotency gaps (workspace rebuilds, scenario `--ignore-workspace` installs, app-local `.env` files).
5. **Coordinate with SDS PR #77** before implementing `ads:seed-attendance`.
6. **D3.4** — `fixtures/demo-small/create.sh` orchestration script (✅ shipped).
7. **D3.6** — port the legacy `adm-combined` fixture.

Tracking: `saga-ed/student-data-system#80` · plan doc: `~/dev/sds-fixture/claude/projects/sds_80/research/06-phased-implementation-plan.md` §Phase 3 + appendix A.5.

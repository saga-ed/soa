# Research 05 — seeding: mesh-fixture-cli vs synthetic-dev (what to keep)

> Code-level comparison to decide what, if anything, mesh-fixture-cli's seeding contributes to **saga-stack-cli** (which supersedes it). Verdict: retire the CLI; carry forward exactly one capability (snapshot round-trip) and one principle (offline determinism, already the live approach).

## The two approaches

| Dimension | mesh-fixture-cli | synthetic-dev (live) |
|---|---|---|
| Seeding method | **HTTP/tRPC to running services** | **Direct Prisma `db:seed` (offline)** |
| Service dependency | requires services up on hardcoded ports | none — pure DB writes |
| DBs known | 6 of 9 (missing sessions, content, sis_db) — `src/lib/postgres.ts:25-32` | all 9 — `up.sh:1575` |
| Service ports | **stale**: iam `:3000` — `src/shared-flags.ts:24-26` | iam `:3010` (current) |
| Determinism | uses `@saga-ed/iam-seed-ids` derive + fixture registry | uses `@saga-ed/{iam,program,demo}-seed-ids`, offline derivation |
| Snapshot | **pg_dump/pg_restore round-trip** → `~/.saga-mesh/snapshots/<id>/` + manifest, profile-gated — `src/lib/postgres.ts:90-166`, `commands/snapshot/store.ts` | none built-in (external S3 restore / manual) |
| Profiles | stores SEED_PROFILE in snapshot, refuses cross-profile restore | `roster` / `full` (+playback/qtf) — `up.sh:1735-1746` |
| Prod-mirror | `iam:/pgm:seed-from-prod-mirror` spawn external `iam-seed`/`pgm-seed` bins | none built-in |
| Fixture registry | records command/args/ts/version post-mutation (`src/lib/registry.ts`) for `snapshot:validate` | none (just `RESTORED_OK` env tracking) |
| Tests | **none** (0 test files) | implicit (daily use) |
| Version / activity | `0.0.1`, dormant since Phase 3-4 (D3.1→D4.1); last touch Apr 29 = incidental infra align | active (synthetic-dev-align d2.1) |
| Services covered | 4 of 10 (iam, programs, scheduling, ads-adm) | 9 of 10 |

## How each actually seeds (evidence)

**mesh-fixture-cli** — HTTP create + spawn external bins:
- `commands/iam/create-org.ts:45-87` → `client.mutation('groups.create', {…})` over tRPC (slug-based dedup).
- `commands/pgm/create-program.ts:70-94` → spawns `pgm-seed` binary, scrapes UUID from stdout.
- `lib/postgres.ts:90-166` → `docker exec` pg_dump/pg_restore per DB.

**synthetic-dev** — offline direct DB:
- `up.sh:1610-1616` `seed_iam()` → `cd rostering/packages/node/iam-db && pnpm db:seed`.
- `iam-db/prisma/seed.ts:29-30` → `deriveGroupId/deriveUserId` (offline), Prisma upsert on stable ids.
- `programs-api/src/prisma/seed.ts:97-146` → tries iam HTTP lookup but **falls back to derived ids** (works offline).

## Verdict per capability

| Capability | Verdict | Why |
|---|---|---|
| `iam:`/`pgm:`/`ads:` HTTP create commands | **DROP** | Superseded by offline `db:seed`; stale ports (iam :3000), 4/10 services, requires running stack, no tests. Reliability inferior to direct DB writes. |
| **Snapshot store/restore (pg_dump round-trip)** | **KEEP (rebuild for 9 DBs)** | The one genuinely valuable, non-duplicated capability. Gives <2min fixture replay; synthetic-dev has no native equivalent (leans on external S3 restore). This is the seed *fast-path*. |
| Fixture registry (command audit) | **MAYBE (low priority)** | Nice for `snapshot:validate` provenance; only wired to 4 services. Re-evaluate after core ships. |
| Prod-mirror extraction | **REBUILD / decouple** | Valuable (anonymized realistic data) but already partly extracted to standalone `iam-seed`/`pgm-seed` bins. saga-stack-cli should *invoke* those, not own the extraction. |
| The CLI as a whole | **RETIRE** | Outdated, incomplete, untested. Don't build new features on it. |

## Implications for saga-stack-cli

**Seeding model = orchestrate, don't reimplement.** The live, correct approach is offline `pnpm db:seed` per service with deterministic seed-ids. saga-stack-cli's `seed` should:
1. **Wrap the per-service `db:seed` scripts** (offline-first, no HTTP), selectable per system / per flow — this is the per-system-seed-per-flow requirement, and it's a *composition* problem, not a rewrite.
2. **Carry forward snapshot round-trip as a first-class fast-path** (`stack snapshot store/restore`), fixed to cover all 9 DBs and profile-gated — the only mesh-fixture-cli code worth porting in spirit.
3. **Invoke** standalone prod-mirror bins where realistic data is needed; don't own extraction.
4. Drop the HTTP create-command model entirely.

**Net:** mesh-fixture-cli contributes a *design idea* (snapshot fast-path) and a *cautionary tale* (don't seed over HTTP, don't hardcode ports/DBs — drive them from the manifest). Almost none of its code transfers; its `base-command.ts` output conventions (JSON/porcelain/human) are still worth mirroring.

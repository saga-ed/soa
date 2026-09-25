# 07 — M8 native-prep core: porting up.sh prep/provision/migrate/reset to TypeScript

> **Directive (skelly, 2026-07-02):** the native TS implementation of up.sh's core
> (build → provision → migrate → reset) is **the core value of the CLI, not a deferred
> backlog** — a CLI that wraps up.sh for the hard parts is a wrapper, not a replacement.
> This plan elaborates the "Phase 4" backlog from `06-m8-non-destructive-landing.md` into a
> realizable, sequenced build. **Non-destructive throughout:** every flipped command keeps a
> `--legacy` bash escape; up.sh is never touched. Parent #214 · tracker #221.

## 0. What "native up.sh core" means

up.sh's `prep()` + `reset_data()` are the ~250 lines of bash that stand a stack up from a
clean checkout: install deps, build, generate Prisma clients, ensure the mesh DBs/roles
exist, migrate every schema, (on reset) truncate + re-seed. Today the CLI's native path
(`StackApi.up`, `stack-api.ts:350-451`) does **mesh → dash-hook → launch** with **none** of
that — it only works because a prior up.sh run (or the mesh initdb hook) left DBs
provisioned+migrated on a persisted volume. The five runners below close that gap so a
**genuinely fresh checkout + fresh volume** comes up natively.

All five slot into `StackApi.up` **between `meshUp` and the launch waves**, in order
**build → provision → migrate → launch → (seed, already native)**; on `reset`, the reset
runner replaces the up.sh delegate. Each is an IO-only `runtime/**` module behind an
injectable Runner seam (preserving the pure-core invariant), **closure-scoped** so
`--only`/slots stay cheap, and driven by the **manifest data that already exists**
(`databases.ts` carries per-DB ownerRole/ownerPw/name, `MigrateSpec{dir,cmd,databaseUrlOverride}`,
`resetMode`, and the canonical migrate-order comment).

## 1. The five runners (dependency-ordered)

### R1 — Native build/prep pass  (`runtime/prep.ts`)
- **up.sh source:** `prep()` build loop, up.sh:992-1039 — `pnpm install` (workspace), workspace build (`build_step`), and `db:generate` (Prisma client) for each repo in the closure (rostering/program-hub/sds/saga-dash/qboard/rtsm/coach).
- **Why required:** services import workspace deps from `dist/`; the `*-db` packages need a generated Prisma client before their tsup build + runtime import; saga-dash needs vite installed or the UI 404s. On a fresh/stale-`dist` checkout, native `up` **crashes at import** (`@saga-ed/coach-db` from `dist/`, or `vite: not found`) before any DB work — a hard failure, not a warn.
- **TS design:** `prepRepos(closureRepos, {skipPrep}, runner)` — over the DISTINCT repos of the closure services, run `pnpm install` (once per repo root, idempotent), a best-effort workspace build, and `pnpm -F <db-pkg> db:generate`. Honor a `SKIP_PREP`-equivalent (`--skip-prep`, already a wrapper flag — make it native too). Reuse manifest `repo`/`subpath`. Cache/skip when `dist/` + `node_modules` are fresh (mtime or a stamp) to keep re-ups fast.
- **Edge/tests:** idempotent re-run is a fast no-op; a repo missing `dist/` triggers a build; `--skip-prep` bypasses; closure-scoped (only closure repos, not all). Unit: the command plan (which repos, which scripts) for a given closure; a `--skip-prep` short-circuit.

### R2 — Idempotent DB provisioning fallback  (`runtime/provision.ts`)  ← includes coach_api (in MVP)
- **up.sh source:** up.sh:1048-1068 — idempotent `CREATE DATABASE` fallbacks for sessions (1048-1052) + content (1055-1059), and `DO $$ CREATE ROLE IF NOT EXISTS $$ + CREATE DATABASE … OWNER` for **coach_api** (1061-1067). These exist because those DBs/roles are **newer than existing volumes** (and newer than gh_214's own `profile-empty.sql`), and Postgres runs `/docker-entrypoint-initdb.d` (profile-empty.sql) **only on a truly-fresh PGDATA volume**.
- **Why required:** on any pre-existing mesh volume, the newest DBs (coach_api today; the next added DB tomorrow) are simply absent → the fatal seed steps hit a missing DB. coach_api is the named #221 blocker; you chose to include it in the MVP.
- **TS design:** `provisionDbs(closureDbs, runner)` — for each closure DB with `meshProvisioned:true`, `docker exec <pgContainer> psql -U postgres_admin` running an idempotent `DO $$ IF NOT EXISTS role → CREATE ROLE LOGIN PASSWORD $$;` then `CREATE DATABASE <name> OWNER <role>` guarded by a `pg_database` existence check (CREATE DATABASE can't run in a DO/txn — separate statements, mirroring the up.sh fix I already hit in the coach soak). Owner/pw/name from `databases.ts`. Runs after mesh is up, before migrate.
- **Edge/tests:** DB already exists → no-op; role exists, DB missing → creates DB only; fresh volume (initdb already ran) → all no-ops. Unit: the psql statements generated per DB; the "role-and-db separate statements" shape. This makes the coach soak's manual `CREATE ROLE/DATABASE` step native.

### R3 — Native migrate runner  (`runtime/migrate.ts`)  ← THE headline
- **up.sh source:** `migrate_db()` up.sh:738-755 (the three-way branch) + the migrate chain up.sh:1040-1073 (canonical order). `profile-empty.sql` leaves every app DB **table-empty** (up.sh:764-767), so with no migrate the fatal seed steps (iam/sessions/programs/scheduling) run against an unmigrated schema and abort.
- **Why required (the true gate on a fresh native `up`):** the manifest carries complete `MigrateSpec` data but **nothing executes it** — the only code touching migrate dirs is `snapshot-store.ts:206-229`, and only to *read* them for a schemaRev compare. iam-api self-migrates at boot (why "iam came up on fresh volumes" in the two-stack test — provisioned by the initdb hook, self-migrated at boot); **program-hub `db:deploy` DBs, ads-adm, sis do NOT self-migrate**, so the runner is required for the general case.
- **TS design:** `migrateClosure(closureDbs, runner)` — for each closure DB **in canonical manifest order**, run its `MigrateSpec` with the three-way branch, probing `_prisma_migrations` via `docker exec psql -tAc "SELECT to_regclass('public._prisma_migrations') IS NOT NULL"`:
  - **migration-managed** (has `_prisma_migrations`) → `pnpm <db-pkg> db:deploy` (apply pending, non-destructive).
  - **empty** (no public tables) → `db:deploy` (replays full history).
  - **unmanaged** (tables, no `_prisma_migrations`) → `prisma migrate reset --force` (up.sh's fallback).
  - Preserve: the **iam-pii `prisma db push`** step + ordering; the **program-hub `db:deploy` `DATABASE_URL` override to force mesh :5432** (`databaseUrlOverride` in the manifest). Each `MigrateSpec.dir` is `<pkg>/src/prisma` per the snapshot-store `src` path fix.
- **Edge/tests:** the three branches (managed/empty/unmanaged) each dispatch the right cmd; canonical order honored; `databaseUrlOverride` sets DATABASE_URL; iam-pii `db push` runs in the right slot. Unit: the per-DB command + env plan for a closure; the branch selection given a probed state (inject the psql probe). **This is the runner that unblocks a fresh full-stack native `up`.**

### R4 — Native reset runner  (`runtime/reset.ts`)  ← flips `stack reset` native
- **up.sh source:** `reset_data()` up.sh:1661-1698 — generic per-DB `TRUNCATE` preserving `_prisma_migrations` over 9 DBs (+3 playback under `--with playback`), Mongo `connectv3` `dropDatabase`, then dev-user re-seed.
- **TS design:** `resetClosure(closureDbs, sel, runner)` — for `resetMode:'truncate'` DBs: `docker exec psql` a generic `ON_ERROR_STOP` `TRUNCATE` loop over public tables **preserving `_prisma_migrations`**; **special-case `ledger_local` → `prisma migrate reset --force`** (`resetMode:'migrate-reset'`, decision 2026-06-30 — it is NOT in up.sh's truncate list); `mongosh dropDatabase` for connectv3; then run the dev-user re-seed step (already a SeedStep). Playback DBs only under `--with playback`. Replace the `stack-api.ts:462-472` delegate + `reset.ts:42-48` wrapper; keep the `--legacy` escape.
- **Edge/tests:** ledger takes migrate-reset not truncate; `_prisma_migrations` survives truncate; connectv3 mongo dropped; playback gated on `--with playback`. Lower risk (reset already works via delegation — this is the parity flip).

### R5 — `SeedStep.stdinFile` (coach curriculum + playback provisioning)  (`core/seed/*` + `runtime`)
- **up.sh source:** coach mongo curriculum `mongoimport < file` (up.sh:1780-1798); playback DB provisioning `docker exec psql < local-bootstrap.sql` + migrate (up.sh:937-951).
- **Why:** the `SeedStep` model (`command:string[]`, no stdin) can't express `< file`; coach curriculum is the TODO at `profiles.ts:285-292`, and the 3 playback DBs (`meshProvisioned:false`) have no native provisioning.
- **TS design:** add an optional `stdinFile?: string` (or docker-cp-then-exec) to `SeedStep`; the seed runner pipes the file to the child's stdin. Model coach-curriculum + the playback bootstrap as steps. Gate native coach `--seed full` + native `--with playback` until landed.
- **Edge/tests:** stdinFile piped to the command; coach/playback steps compose; slot-0 unaffected. (Lower priority — both opt-in; land after R1-R4.)

## 2. Integration + the bare-`up` flip

- **`StackApi.up` wiring:** `meshUp` → `provisionDbs` (R2) → `prepRepos` (R1, or R1 before R2 if build must precede provisioning — build has no DB dep, so R1 can run first/in parallel with mesh) → `migrateClosure` (R3) → dash-hook → launch waves → `seed` (existing). Slot-scoped throughout; slot 0 and slots share the same runners (state/project/ports already threaded by M7).
- **The bare full-stack `up` flip (now IN scope):** once R1-R3 are soaked, `up.ts run()`'s bare full-stack path (currently `runWrapped` → up.sh) flips to `runNative` over the full non-optional closure — the last wrapper flip. Keep `--legacy` (→ up.sh) on `up`. This is the moment the CLI *replaces* up.sh's happy path (bash still available).
- **Untouched (still wrapped, by design or later):** `overlay`/`tunnel`/`bootstrap` (git-overlay / frp-moniker / provision — large, separate ports; leave wrapped with `--legacy`), `login`. Not part of the core prep/migrate value.

## 3. Sequencing (each independently shippable + soaked)

1. **R2 provision** (small, closes the coach_api #221 gap; testable standalone against a stale volume) — MVP-pulled per your call.
2. **R3 migrate** (the headline; unblocks fresh native seed) — the big one.
3. **R1 build/prep** (makes a truly-clean checkout work; heavier, per-repo).
4. **Bare-`up` native flip** (after R1-R3 soak) + **R4 reset flip**.
5. **R5 stdinFile** (coach curriculum + playback) — last, opt-in paths.

R2+R3 together already make a fresh-volume, already-built checkout come up natively — the highest-value core. R1 extends it to a from-scratch checkout.

## 4. Testing — the non-negotiable

Native prep changes real DB/FS state, so unit tests aren't enough:
- **Unit (per runner):** the generated command/env plan for a given closure + probed state (inject the Runner + psql probe). Deterministic, fast, the bulk.
- **Dual-run diff vs up.sh (the flip gate):** for each runner, run the native runner AND up.sh's equivalent on **BOTH a fresh volume AND a stale volume** (the coach_api case only shows on stale), and diff the resulting DB state (schemas present, `_prisma_migrations` rows, seed row counts). Flip a command's default to native **only** when the diff is clean.
- **Live soak:** a full-stack native `up` from a fresh mesh volume → all services healthy + seeded (the bare-`up` flip gate), plus a stale-volume run (coach_api provisioned). Extends the existing soak driver.

## 5. Non-destructive guarantees
- up.sh + all `.sh` untouched; every flipped command keeps `--legacy` → bash indefinitely.
- Slot 0 stays up.sh-compatible until the bare-`up` flip soaks; even then `--legacy` remains.
- Gated opt-in non-defaults still replaced by `--only`/`--with` (no bespoke native gates); foreground-not-in-background invariant kept.

## 6. Open decisions
1. **R1 build/prep scope** — full `pnpm install` + build over closure repos is heavy; do we want native `up` to *assume a built workspace* (skip R1, document "run `pnpm build` first / use `--legacy` for cold checkouts") and only do R2+R3+launch? That makes the native core much lighter and R1 a later nicety. (Recommendation: yes — assume-built for the native core, R1 as a follow-on; most dev loops are already built.)
2. **Where the bare-`up` flip's soak bar sits** — how many clean dual-run + live soaks before flipping the default (vs keeping native opt-in via `--native` and up.sh the default a while longer).
3. **`e2e-kit`** (from the §B thread) — confirm drop the cross-repo package; CLI injects the date, specs read env with a minimal local fallback.

## References
up.sh (materialized main): `/home/skelly/.claude/jobs/d71128ac/tmp/upsh-origin-main.sh` — prep 992-1039, provision 1048-1068, migrate_db 738-755, migrate chain 1040-1073, reset_data 1661-1698, coach mongo 1780-1798, playback 937-951. CLI: `packages/node/saga-stack-cli/src/{stack-api.ts, runtime/*, core/manifest/databases.ts, core/seed/*, commands/stack/{up,reset}.ts}`. Manifest data: `databases.ts` (ownerRole/pw/name, MigrateSpec, resetMode). Governing plan: `06-m8-non-destructive-landing.md`.

# Plan — transition `up.sh` from the scenario runner to `db:seed`

**Status:** DRAFT 2026-06-05 (awaiting review)
**Scope:** `~/dev/soa/tools/synthetic-dev/up.sh` (+ `verify.sh`), seeding path only.
**Prereq landed:** rostering #397 (per-district admin personas) — the d1.1 gate.

## Goal & success criterion

Swap the local stack's **base seed** from the scenario runner (HTTP, against a
running iam-api, non-deterministic UUIDs) to **`db:seed`** (direct-to-DB,
deterministic `@saga-ed/*-seed-ids` IDs) — Seth's PR #152 model — **without
changing the data an engineer sees or the login ergonomics.**

**Acceptance test (user-defined):**

```
./up.sh --reset --seed roster --login
```

must come up **clean** (6 services healthy, `verify.sh` 13/13) with the **same
data** — a **superset** of the scenario's 197 users (db:seed yields **205**: the
identical 190-person roster + the same 6 test personas + the bootstrap dev + 8
deterministic Connect Demo users that preview/CI also have; see
`../decisions/d2.1-user-count-superset.md`) — and a working `dev@saga.org`
session.

## Two hard invariants (do not regress)

1. **Roster/data parity (superset).** db:seed = **205** users (proven against a
   throwaway DB, diffed vs the live mesh): same 190 roster, same 6 test personas
   (renamed), +8 Connect Demo. Invariants that matter: roster `168+22`, all 5
   district admins loginable, `dev@saga.org` = Seed admin. (Was framed as "197";
   resolved to the superset in d2.1.)
2. **JANUS-bypass login stays.** Today `--login` mints the `iam_session` cookie
   via iam-api's `auth.devLogin` (with `JANUS_REQUIRED=false`), bypassing the
   Janus perimeter locally. **This is the LOGIN path and is orthogonal to how we
   seed.** The swap touches only `seed_iam`/`seed_programs`; `login_user()`,
   `browser-login.mjs`, `JANUS_REQUIRED=false`, and `AUTH_DEVUSERID` are
   untouched. Seeding stops *needing* the HTTP-auth plumbing; logging in still
   uses it exactly as now.

## Why parity is real (the 197)

The scenario's roster is **not** ad-hoc — it was mirrored into the shared
catalog on purpose (`iam-seed-ids` commit `24a933d`: *"add canonical
student/tutor roster (168 students, 22 tutors)"*).

| Source | Roster | Named users | Bootstrap dev | Total |
|---|---|---|---|---|
| **Scenario** (`scripts/scenarios/src/program-hub.ts`) | 168 students + 22 tutors inline = **190** | `DEV_USERS` (dev/multi/many/new/frontier/none) | `…beef` dev@example.org | **197** |
| **`db:seed`** (`iam-db/prisma/seed.ts`) | `ROSTER` = **190** (168+22) from `@saga-ed/iam-seed-ids` | `USERS` = 6 | `seed-dev-user.ts` (`…beef`) | **197** |

Same people, same structure. The **only** difference is UUIDs: scenario = random
per run; `db:seed` = `uuidv5(slug)` deterministic. "Same data" means same
roster, not same bytes in the id column — and the deterministic ids are the
whole point (stable across `--reset`, so cookies/fixtures survive).

> Caveat — the **off-by-one**: the `…beef` `dev@example.org` bootstrap user is
> the d1.1 follow-up ("stabilize dev on `userId('dev')`, retire `…beef`"). We
> KEEP it for now so the count stays 197; retiring it (→ 196) is a deliberate,
> separate change, not part of this swap.

### Do we need a NEW / forked catalog to match the scenario? No.

A reasonable question: *"can't we just make a new iam-seed catalog that matches
the scenario data?"* Two reasons we don't:

1. **The scenario data is already in the one canonical catalog.** The 190-person
   roster was mirrored into `@saga-ed/iam-seed-ids` (`roster.ts`, commit
   `24a933d`), and the per-district **admins** — the one true gap — were added to
   `iam-db/prisma/seed.ts` in **#397 (merged)**. Roster lives in the catalog;
   admins live in the seed. Both are now complete, so `db:seed` already produces
   the scenario's people + admins. There is nothing left to port.
2. **A *second* catalog would defeat the purpose.** The value of the converged
   model is that **local == preview == CI** because they all seed from the *same*
   canonical catalog. Forking a "scenario-matching" catalog re-introduces exactly
   the divergence this work removes. The design is intentionally **one** canonical
   catalog; variation that genuinely differs per-run belongs in the scenario
   **journey** layer on top (d1.1 D2), or as an additive extension of the single
   catalog — never a parallel catalog the base seeds from.

So "Seth's flow" isn't really "multi-catalog"; it's "one deterministic catalog,
shared everywhere." With #397 merged, that catalog + seed already match the
scenario. The remaining work is purely **plumbing `up.sh` to call `db:seed`** —
not authoring data.

## What `db:seed` looks like per service (code-grounded)

All deterministic, all **offline** (no running service, no HTTP), all explicit
`pnpm db:seed` scripts (none auto-wired in `prisma.config.ts`):

| Stage | cwd | Command | Required env | Service up? |
|---|---|---|---|---|
| iam roster | `rostering/packages/node/iam-db` | `pnpm db:seed` (`tsx prisma/seed.ts`) | `DATABASE_URL`, `PII_DATABASE_URL`, `PII_DEK_HEX`, `PII_HMAC_KEY_HEX` | **no** |
| programs | `program-hub/apps/node/programs-api` | `pnpm db:seed` (build+run) | `DATABASE_URL` (programs); **omit** `IAM_API_URL` | **no** |
| scheduling | `program-hub/apps/node/scheduling-api` | `pnpm db:seed` | `DATABASE_URL` (scheduling) | **no** |
| content *(future)* | `program-hub/apps/node/content-api` | `pnpm db:seed` | `DATABASE_URL` (content) | **no** |

Notes that shape the implementation:
- **PII env is mandatory for parity.** Without `PII_DEK_HEX`/`PII_HMAC_KEY_HEX`,
  `iam-db` seed *skips* encrypted names/emails → the dash shows blanks. The
  existing `prep()` already loads these from `rostering/.env.local`
  (`env $(grep -v '^#' .env.local | xargs)`); reuse that exact pattern.
- **programs seed: omit `IAM_API_URL`.** With it set, the seed tries a protected
  `groups.findBySourceBulk` over HTTP, 401s in a script context, then falls back
  to derived ids. Omitting it goes straight to the deterministic offline
  derivation that agrees with `iam-db` — cleaner and no 401 noise.
- **Order: programs before scheduling** (scheduling references program/period
  ids). `roster` mode seeds neither beyond iam, so this only matters for `full`.

## Phases

### Phase 0 — Prereq ✅ DONE
rostering #397 merged (per-district admin personas). Every district's catalog
admin is loginable.

### Phase 1 — Scratch-DB parity proof (no `up.sh` change)
Before touching `up.sh`, prove the swap against **throwaway DBs** (never the mesh
`*_local` DBs), same isolation pattern as the #397 verification:
- Spin a throwaway postgres; `migrate deploy` iam-db + programs + scheduling.
- Run each `db:seed` with the env above.
- **Assert:** `SELECT count(*) FROM users == 197`; 5 districts, all with an
  `admin` persona; the named users bound to their district admin; programs/
  periods present; `dev@saga.org` resolvable.
- Static pre-check already passed (190+6+1=197, #397 personas present). Phase 1
  is the empirical confirmation.

### Phase 2 — Swap the seed functions in `up.sh`
Rewrite the two seed producers; keep the public UX (`--seed roster|full`, the
up→reset→seed→login order) identical.

```bash
# roster: iam only (deterministic, direct DB — no iam-api, no JANUS, no cookie)
seed_iam(){
  say "seeding iam roster (db:seed — deterministic seed-ids)…"
  ( cd "$ROSTERING/packages/node/iam-db" \
      && env $(grep -v '^#' "$ROSTERING/.env.local" | xargs) pnpm db:seed >…)
  ok "iam roster seeded (197 users, deterministic ids)"
}
# full adds programs (offline derived ids; omit IAM_API_URL)
seed_programs(){
  say "seeding programs (db:seed)…"
  ( cd "$PROGRAM_HUB/apps/node/programs-api" \
      && env DATABASE_URL=postgresql://saga_user:password123@localhost:5432/programs pnpm db:seed >…)
  ok "programs seeded"
}
```

- The scenario files (`scripts/scenarios/…`) stay in their repos as the future
  **journey** layer; `up.sh` simply stops calling them at base time. Optional
  `--seed-scenario` escape hatch can preserve the old path during transition
  (recommend keeping it one release, then drop).
- `seed_stack`: `roster`→iam; `full`→iam+programs (today's semantics preserved).
  Scheduling/content are Phase 6 additions, not part of the parity swap.

### Phase 3 — `reset_data`
Keep the truncate-to-empty-baseline approach (fast, preserves
`_prisma_migrations`). `db:seed` is **not guaranteed idempotent**; truncating
first guarantees a clean re-seed. Verify a `--reset --seed roster` twice in a row
yields identical 197-user state. Keep the `seed-dev-user` re-seed in `reset_data`
(it's part of the 197).

### Phase 4 — Login / JANUS invariant (explicit no-op + a doc line)
No code change; add a comment band in `up.sh` stating the seed path is now
direct-DB but `--login` still uses `devLogin` + `JANUS_REQUIRED=false`. Drop the
seed-era `SECURITY_RATELIMITMAXREQUESTS=1000000` bump *only if* nothing else
needs it (it existed for the bulk HTTP seed; harmless to leave — low priority).

### Phase 5 — `verify.sh` determinism assertions
Turn parity into a guarded invariant. Add to the data section:
- `iam users == 197` (hard check, not just `> 0`).
- A known deterministic id is present — e.g. `userId('dev')`
  (`1e2ca0d8-…-1186`) and the Seed district group id
  (`71698462-…`).
- Each of the 5 districts has an `admin` persona (the #397 guarantee).

### Phase 6 — Optional richer stages (after parity is locked)
Add scheduling + content `db:seed` behind `full` (or a `--seed full+`/`base`
verb), and a `--seed base` alias per d1.1/d2. Deterministic + offline, so they
compose freely; document the staged map (d1.1 D2 table).

### Phase 7 — Docs + PR
- Update `README.md`, `getting-started.md`, `STATUS.md`; refresh d1.1 status and
  the d2 staged-seed table to reflect "base = db:seed."
- soa blocks direct-to-main → ship as a **soa PR** (worktree-isolated, like
  #124/#125), reviewer per cadence.

## Risk register

| # | Risk | Mitigation |
|---|---|---|
| R1 | `db:seed` not idempotent on a non-empty DB | `reset_data` truncates first; always `--reset` before `--seed` in recipes |
| R2 | Missing PII env → blank names/emails | reuse `prep()`'s `env $(grep -v '^#' .env.local \| xargs)` so `PII_*` reach the seed |
| R3 | programs seed 401s on `IAM_API_URL` HTTP path | omit `IAM_API_URL` → deterministic offline derivation |
| R4 | Count is 197 only with the `…beef` bootstrap user | keep `seed-dev-user`; retiring it (→196) is a separate d1.1 follow-up + a verify update |
| R5 | scheduling depends on program ids | order programs→scheduling; `roster` skips both |
| R6 | Fixtures keyed on scenario's random UUIDs break | none were stable before; deterministic ids are the win — key fixtures on email/slug |
| R7 | Editing live `up.sh` while a workflow runs | n/a now (flow not in use); still develop in a worktree + PR |

## Acceptance checklist (the gate)

- [ ] `./up.sh --reset --seed roster --login` exits clean
- [ ] `verify.sh` → 13/13
- [ ] `iam users == 205` (superset of scenario 197; roster 168+22, +6 personas +1 dev +8 demo)
- [ ] `dev@saga.org` devLogin 200 + cookie jar written + dash opens logged-in
- [ ] re-run is reproducible (same 197, stable ids across `--reset`)
- [ ] `--seed full` adds programs/periods with deterministic ids
- [ ] JANUS bypass unchanged (login works with `JANUS_REQUIRED=false`)

## Related artifacts
- Decision d1.1 (`../decisions/d1.1-base-journey-split.md`) — base/journey + the gate.
- Parity audit (`../research/04-parity-audit.md`).
- Current flow (`../research/02-current-synthetic-dev-flow.md`).
- Code: `up.sh` `seed_iam`/`seed_programs`/`reset_data`/`prep`;
  `iam-db/prisma/seed.ts`; `iam-seed-ids/src/roster.ts` (ROSTER=190);
  `program-hub/apps/node/{programs,scheduling,content}-api` `db:seed`.

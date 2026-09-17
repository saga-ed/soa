# gh_305 — seed-ordering bug blocking `ss develop coach` (recurrence of soa#253)

_Code trace across soa (saga-stack-cli) + rostering (iam-db). No live stack run._

## Symptom

A live `ss develop coach --slot 2` run logs `SEEDED_REGISTRY:permissions=55` **and**
rostering's `seed-dev-user` failing with:

```
seed-dev-user: registry is missing required session permissions
[00000000-0000-4000-a005-000000000053, …054, …055] — run seed:registry first.
Refusing to provision a degraded dev admin grant (would reintroduce saga-dash#209.10/#209.1).
```

The three ids are `sessions:observe/lifecycle_non_hosted/edit_non_hosted`
(rostering `registry.ts` lines 125-127, added by migration
`20260603000000_add_sessions_authz_permissions`).

## Root cause — an ORDERING GAP in `api.reset()`, not the seed profile

**The failure is emitted by the RESET pass, which re-seeds `iam-dev-user` AFTER
truncating the permission catalog but WITHOUT running `iam-registry` first.**

Trace, for the coach `module-playback` flow (`coach/apps/web/coach-web/e2e/flows.json`
→ `"seed": { "profile": "full", "reset": true }`):

1. `develop coach` → `executeResolvedFlow` (soa `src/e2e-orchestrate.ts`). With
   `reset:true` and no `--reuse`, `effectiveReset` is true, so it does — **in this order**:
   - `src/e2e-orchestrate.ts:995` → `const reset = await deps.api.reset(services);`
   - `src/e2e-orchestrate.ts:1000-1001` → `composeSeedPlan(... 'full' ...)` then `await deps.api.seed(plan)`.

2. `api.reset()` (soa `src/stack-api.ts:1015-1060`):
   - `resetClosure()` (soa `src/runtime/reset.ts:151-264`) TRUNCATES every closure pg
     DB, incl. `iam_local`. The DO block (`truncateSql`, `reset.ts:112-119`) truncates
     every `public` table **except `_prisma_migrations`** — so the `permissions` rows
     (053/054/055, inserted by the migration during `db:deploy`) are **wiped**, and a
     truncate never re-migrates, so they are NOT re-inserted.
   - Then, `src/stack-api.ts:1040-1046`, **only** the `iam-dev-user` step is re-run:
     ```js
     if (services.includes('iam-api')) {
       const ran = { offline: [], online: [] };
       const devUser = buildSeedRegistry(manifest)['iam-dev-user'];   // NO iam-registry first
       const ok = await runSeedStep(devUser, 'offline', ran);
       seed = { ok, ran, skipped: [], ...(ok ? {} : { failed: devUser.id }) };
     }
     ```
   - `iam-dev-user` runs `node dist/seed-dev-user.js` → `main()` →
     `applyDevAdminGrant()` (rostering `src/seed-dev-user.ts:135-151`), which does
     `prisma.permission.findMany({ where: { id: { in: ADMIN.permissionIds } } })`
     against the **just-truncated** table, finds 053/054/055 absent, and **throws the
     reported error** (`seed-dev-user.ts:145-151`).

3. `api.seed(plan)` runs AFTERWARD with the `full` plan whose offline order is
   `[iam-registry, iam-dev-user, iam, …]` (`profiles.ts` `PROFILE_STEPS.full` line 45 +
   `SEED_RUN_ORDER` lines 76-99; `composeSeedPlan` walks that order). `iam-registry`
   (`node dist/seed-registry.js`) re-seeds all 55 permissions incl. 053/054/055
   (`SEEDED_REGISTRY:permissions=55`), then `iam-dev-user` succeeds. **This is why the
   error line precedes `SEEDED_REGISTRY:permissions=55` in the log** — error from the
   reset re-seed, registry from the later full seed.

### Why this is a recurrence of soa#253

soa#253 fixed the SEED path: it added `iam-registry` ahead of `iam-dev-user` in
`PROFILE_STEPS` / `SEED_RUN_ORDER` (`profiles.ts:42,45,76-99`) — that path is correct
and the `stack-api.unit.test.ts` order assertion `['iam-registry','iam-dev-user','iam','sessions']`
(lines 427/454/480) confirms it. soa#253 did **not** touch `api.reset()`'s hardcoded
dev-user re-seed (`stack-api.ts:1040-1046`), which still truncates the registry and then
re-seeds `iam-dev-user` alone. That is the gap.

### It is an ORDERING bug, not DB-targeting and not a missing step in the profile

- **Not DB-targeting.** In the reset re-seed AND in the full seed, every iam step uses
  `iamSeedEnv(m)` → identical `DATABASE_URL = postgresql://iam:iam@localhost:${MESH_PG_PORT}/iam_local`
  (`profiles.ts:220-229`, `pgUrl` 173-176). `${MESH_PG_PORT}` is resolved once per
  facade (`stack-api.ts:574-580`) from `runtime.meshOffset`, so registry, dev-user and
  the truncate (`docker exec <pgContainer> …`) all hit the same slot DB. (Note: `develop
  coach` builds its runtime with the DEFAULT slot-0 profile —
  `commands/develop/coach.ts:250` passes `undefined` for `profile` to
  `buildStackContext`, so `--slot 2` is effectively ignored for DB/mesh targeting; that
  is a *separate* concern and does not change the ordering analysis, since reset and seed
  then consistently target slot 0.)
- **Not a missing profile step.** `iam-registry` IS present and correctly ordered in the
  `full` seed plan. The registry is only missing during the *reset* re-seed.

### rostering side is correct — no change needed there

- `seed-registry.ts` / `registry.ts` `seedRegistry()` upserts all 55 `PERMISSIONS`
  (`registry.ts:81-152`) **including** 053/054/055 → `SEEDED_REGISTRY:permissions=55` is
  the current source, and it DOES contain the session perms.
- `seed-dev-user.ts` correctly does **not** self-seed the registry; it validates-first
  and refuses a degraded grant (`applyDevAdminGrant` 135-151). This guard is working as
  designed — it is surfacing the soa-side ordering gap.
- package.json scripts the soa path shells: `seed:registry` → `node dist/seed-registry.js`,
  `seed:dev-user` → `node dist/seed-dev-user.js`, `db:seed` → `npx tsx prisma/seed.ts`.

## Severity / does it block?

`iam-dev-user` is `failureMode:'warn'` (`profiles.ts:282-298`), so `runSeedStep` returns
`true` even on the throw; `api.reset()` returns `code:0` and the subsequent full seed
re-seeds the registry and heals dev's grant. So for the **reset+seed e2e path** the log
line is alarming but self-healing — `develop coach` should still complete. The genuine
hard regression is a **bare `ss stack reset`** (no full seed after): it truncates the
registry, the dev-user re-seed throws before applying the grant, and dev is left with no
admin persona → resolves to `DEFAULT_USER_BUNDLE` (coach-only) → reintroduces
saga-dash#209.10 / #209.1 exactly. Either way the ordering gap is the defect that
produces the reported error and must be fixed. (If the live `develop coach` truly aborted
rather than just logging the error, the abort is downstream of this and unverified from
the trace — but the reset re-seed is unambiguously the source of the quoted message.)

## Fix (soa seed path — preferred, minimal)

In `packages/node/saga-stack-cli/src/stack-api.ts`, `reset()` (the block at 1040-1046),
run `iam-registry` before `iam-dev-user`, mirroring the seed profile's soa#253 invariant:

```js
let seed: SeedResult | undefined;
if (services.includes('iam-api')) {
  const ran: SeedResult['ran'] = { offline: [], online: [] };
  const registry = buildSeedRegistry(manifest);
  // soa#253 recurrence guard: resetClosure() truncated iam_local's permission catalog
  // (incl. session perms 053/054/055), so seed:registry MUST precede the dev-admin grant
  // — else applyDevAdminGrant refuses (missing session perms) and dev regresses to
  // DEFAULT_USER_BUNDLE (saga-dash#209.10/.1). Registry is FATAL; dev-user stays warn.
  const registryStep = registry['iam-registry'];
  const registryOk = await runSeedStep(registryStep, 'offline', ran);
  const devUser = registry['iam-dev-user'];
  const devUserOk = registryOk && (await runSeedStep(devUser, 'offline', ran));
  const ok = registryOk && devUserOk;
  seed = { ok, ran, skipped: [], ...(ok ? {} : { failed: registryOk ? devUser.id : registryStep.id }) };
}
```

Rationale for two hardcoded steps (vs. `composeSeedPlan`): reset must re-seed ONLY the
registry + dev user (up.sh:1695-1696 parity); composing a profile would also pull in the
fatal `iam` roster `db:seed`, which reset deliberately leaves for the *following* full
seed. `iam-registry` is FATAL (a failed registry means the grant can't be provisioned
safely, so the reset should surface it); `iam-dev-user` stays warn.

### Test impact (same file, `src/__tests__/stack-api.unit.test.ts`)

- `native: … re-seeds the dev user` (line 635): still passes (`res.seed?.ok === true`).
  Add an assertion that `iam-registry` runs before `iam-dev-user` in the reset
  (`res.native`/`res.seed.ran.offline` order, or that a `dist/seed-registry.js` run
  precedes the `dist/seed-dev-user.js` run in `fakes.runs`).
- `slot 1: the reset dev-user re-seed also dials the offset mesh port` (line 590): still
  passes — the dev-user run still exists with the offset `DATABASE_URL`. Optionally assert
  the same for the new `seed-registry.js` run.

### Verify

- `pnpm --filter @saga-ed/saga-stack-cli test` (unit — reset ordering).
- Live: `ss stack reset` alone, then check dev resolves to ADMIN (session action buttons
  visible; not `DEFAULT_USER_BUNDLE`); and `ss develop coach` no longer logs the
  `seed-dev-user: registry is missing required session permissions …` line during reset.

### Rostering

No change required. `seed-registry.ts` seeds all 55 perms incl. 053/054/055;
`seed-dev-user.ts` correctly depends on a prior `seed:registry` and its guard is the
detector, not the bug.

## Key file:line refs

- soa `src/e2e-orchestrate.ts:984-1003` — reset-then-seed ordering.
- soa `src/stack-api.ts:1015-1060` — `api.reset()`; **1040-1046** = the dev-user-only
  re-seed (the bug).
- soa `src/runtime/reset.ts:112-119, 151-264` — truncate wipes `permissions` (preserves
  only `_prisma_migrations`).
- soa `src/core/seed/profiles.ts:42,45,76-99,269-298` — correct seed-path ordering
  (soa#253) + `iam-dev-user` warn mode.
- rostering `src/seed-dev-user.ts:135-151` — `applyDevAdminGrant` guard (throw site).
- rostering `src/registry.ts:81-152` — 55 PERMISSIONS incl. 053/054/055.
- rostering `src/prisma/migrations/20260603000000_add_sessions_authz_permissions/migration.sql`
  — inserts 052-055 via `db:deploy`.
- coach `apps/web/coach-web/e2e/flows.json` — `module-playback`: `profile:full, reset:true`.

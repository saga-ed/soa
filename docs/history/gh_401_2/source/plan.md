# Plan — soa#401 & soa#402 (saga-stack-cli e2e local-stack bugs)

> Transferred verbatim from `saga-ed/rostering`, branch
> `claude/soa-401-402-plan-g0ycc0`, file `claude/soa_401_402_plan.md`
> (authored 2026-08-04). Only this provenance note was added.

Two related, agent-authored bugs filed 2026-08-04 against **`saga-ed/soa`**
(`packages/node/saga-stack-cli`). Both block bringing up Connect/qboard e2e on a
local `ss` stack, and **#401 masks #402** — the connectv3 flow dies at the
Playwright spawn (#401) before it can reach the sessions read that fails closed
(#402). Fix order: **#401 first**, then #402 becomes reproducible.

> Both issues explicitly defer a design/policy call to humans (@SethPaul,
> @nerisaurus). This plan recommends, but the marked decisions need sign-off
> before the durable options land.

---

## soa#401 — `playwrightArgv` emits a bare spec after variadic `--project`

**File:** `packages/node/saga-stack-cli/src/e2e-orchestrate.ts`, `function playwrightArgv`.

**Mechanism.** The argv is built as:

```ts
const argv = [ 'exec','playwright','test',
  `--config=${resolved.playwright.config}`,
  '--project', stage?.project ?? resolved.playwright.project ];
if (stage?.noDeps) argv.push('--no-deps');
if (resolved.playwright.grepInvert) argv.push('--grep-invert', resolved.playwright.grepInvert);
if (resolved.playwright.headed) argv.push('--headed');
if (!stage && resolved.playwright.spec) argv.push(resolved.playwright.spec); // ← swallowed
argv.push(...passthrough);
```

Playwright declares `--project <name...>` **variadic**, so a bare token
following the project name is parsed as a *second project* → the run dies
before any test executes:

```
Error: Project(s) "connect-observe-qtf.e2e.test.ts" not found.
```

**Why it stayed hidden.** Only fires when *nothing* sits between the project
name and the bare spec. Two independent optional flags normally fill that slot:
`--grep-invert` (present for any non-`@interactive` terminal stage,
`core/flow/resolve.ts`) and `--headed` (present for any `foreground:true` flow
not forced `--headless`). The failure needs all three at once:
**`@interactive` + forced `--headless` + a single-spawn flow carrying a `spec`.**
connectv3 is the only interactive+foreground flow family, and `--headless`
strips the last shield. Not a regression — this invocation never worked.

**Options (from the issue, verified against source):**

| # | Change | Cost | Residual |
|---|--------|------|----------|
| 1 | `--project=${name}` (equals form) | ~30 assertions key off the bare project token as a standalone argv element → ~12 files, +87/−53, blame noise | none — disarms any future trailing token incl. `passthrough` |
| 2 | Move the `spec` push **ahead** of `--project` | ~5 assertions (exact-array pins + two `--dry-run` strings) | `passthrough` still appended last → `-- somefile.ts` still swallowable |
| 3 | Delete the positional; require each flow's `stages[].project` be `testMatch`-scoped to its spec; fix coach-web's catch-all `chromium` project into per-flow projects | companion change in **`coach`** repo + a new-SPA convention (`docs/e2e-flows.md`) | none — removes the trap at its source |

Plus an **orthogonal unit guard** (cheap, worth doing regardless):

```ts
const i = argv.indexOf('--project');
if (i !== -1) expect(argv[i + 2] ?? '').toMatch(/^-/); // no bare token right after --project
```

**Recommendation.**
1. **Now (unblock):** Option 2 + the unit guard. Smallest safe diff, single
   repo, gets connectv3 e2e running. The guard also fails loudly if the residual
   `passthrough` trap is ever exercised in a test.
2. **Durable follow-up:** Option 3, coordinated with `coach`, to remove the
   variadic hazard for good.
   - *Alternative if we want `passthrough` safe without waiting on `coach`:*
     Option 1 (`--project=` equals) is the most robust **single-repo** fix; the
     only cost is mechanical test-assertion churn (the issue author measured 13
     assertions still red after two passes — fiddly but bounded).

**Test touch-points:** the ~30 assertions that match the project as a standalone
argv token (`args.includes('stage-4-pods')`, `toContain('interactive-connect')`,
`installSeams('stage-1-roster')`-style helpers) + the exact-array pins and two
`--dry-run` prose strings. Under Option 2 only the latter (~5) change.

---

## soa#402 — `saga-stack-cli` manifest has no `authz-api` (every local sessions read → HTTP 408)

**Files:** `packages/node/saga-stack-cli/src/core/manifest/services.ts`
(manifest), `src/core/bundles.ts` (the `authz` bundle).

**Mechanism.** `sessions-api` hard-requires rostering's **`authz-api`** since
program-hub#454 (2026-07-28): `inversify.config.ts` reads
`AUTHZ_API_URL ?? 'http://localhost:3200'` with *"cannot authorize heightened
grants without authz-api reachable"* — no bypass flag. The manifest declares
`authz-**sync**` (port 3111) but the string `authz-api` appears **nowhere** in
the CLI. Nothing listens on `:3200` → the client fails closed →
`SERVICE_UNAVAILABLE` → `trpc.ts` maps it to tRPC `TIMEOUT` → **HTTP 408** on
every sessions read, on a stack that reports all services up. The `--with authz`
bundle is a red herring — `bundles.ts` shows `authz: { services: ['authz-sync'] }`,
a *different* component from the tRPC capabilities service.

**Blast radius (local `ss` stack lane only).** `SessionsAuthzGate` sits on the
whole sessions read pipeline (`sessions-read.service.ts`): saga-dash `journey`
stage 6+, all four `interactive/connect-*` specs, `session-viewer/observations`,
`sessions/overrides-propagation`, `scheduling/periods-ordering`, the shared
`support/day-list.ts` helper, and both qboard connectv3 flows. Invisible in CI
today (`sandbox-e2e.yml` targets deployed compositions, and its journey run
halts at stage 3 on unrelated saga-dash#896).

**Grounding — `@saga-ed/authz-api` exists in `rostering` and is a routine add:**
- `apps/node/authz-api`, name `@saga-ed/authz-api`, standard `dev`/`build`/`start`.
- Port default **3200** (`src/config/schemas.ts:46`; env prefix `AUTHZ_`).
- **Single DB `authz_local`** on the shared rostering postgres
  (`docker/init-authz-db.sql`), read via `AUTHZ_DATABASE_URL`.
- Projects `iam.*` events over RabbitMQ (`event-handlers/iam-projection.ts`) — so
  it needs the `postgres` + `rabbitmq` mesh units and an **event**-kind edge to
  `iam-api`, same shape as `sessions-api`'s async projection deps.
- **Port 3200 % 1000 = 200 is collision-free** across every existing manifest
  port, so it slots cleanly under the `slot*1000` offset scheme (no change to
  `derive-instance`'s no-collision property beyond adding the port).

**Options:**
1. **Onboard `authz-api` into the manifest** (fail-closed-correct). Concrete shape:
   - New `ServiceDef` `authz-api` — `repo: ROSTERING`, `subpath: apps/node/authz-api`,
     `port: 3200`, `portEnvVar: 'PORT'`, `healthPath: '/health'`,
     `databases: ['authz_local']`, `mesh: ['postgres','rabbitmq']`,
     `dependsOn: ['iam-api']` with `depKinds: { 'iam-api': 'event' }`,
     `optional: false`.
   - `launch.env`: `AUTHZ_DATABASE_URL: '${AUTHZ_DB_URL}'`,
     `RABBITMQ_URL: '${MESH_MQ}'`, `PORT/AUTHZ_PORT: '${AUTHZ_PORT}'`, plus the
     JWT-issuer / iam-facing vars authz-api actually reads — **derive the exact
     set from `authz-api`'s `inversify.config.ts` / `config/schemas.ts`** using
     the same "diff resolved env against the launch line" audit the manifest
     docstring prescribes (do not invent vars).
   - **Add `authz-api` to `sessions-api.dependsOn`** as `depKind 'url'`. Because
     the closure is transitive, this pulls `authz-api` into *every* closure that
     contains `sessions-api` automatically — satisfying the issue's "add it to
     every sessions-reading flow" structurally, no per-flow edits.
   - **Wire `sessions-api`'s launch env**: add
     `AUTHZ_API_URL: 'http://localhost:${AUTHZ_PORT}'`. Relying on the `:3200`
     default would dial **slot-0's** authz-api at slot > 0 — exactly the
     cross-slot braid this file is built to prevent (cf. iam-api's
     `DATABASE_URL`/`RABBITMQ_URL` notes, connect-api's `SESSIONS_API_URL`).
   - Register the new `${AUTHZ_PORT}` token in the `LaunchContext` resolution
     (`core/launch-plan.ts` / wherever `${*_PORT}` expand) and add 3200 to the
     `derive-instance` port set.
   - Cookie relay (sessions-api forwards the caller's `iam_session` to authz-api)
     is app behavior — no manifest change.
2. **Let `sessions-api` degrade when authz-api is absent** (documented dev-only
   escape hatch). Cheaper, but weakens a fail-closed authorization control — the
   issue author flags this as *likely the wrong trade*.

**Recommendation:** Option 1. It matches the fail-closed intent, is a routine
manifest addition mirroring `iam-api`/`sis-api`, and unblocks the whole sessions
read pipeline locally.

**⚠️ Decision to confirm before implementing (deferred to @nerisaurus, who authored
the cutover):** should `authz-api` be part of *every* local stack (i.e. a hard
`sessions-api` dep, making it non-optional), and was the `:3200` default meant to
imply "always running locally"? Option 1 assumes **yes** to both.

**Open items to verify while implementing Option 1:**
- Exact `authz-api` launch env (issuer/JWKS, cookie-secret, etc.) from its DI config.
- Whether authz-api needs a **seed / projection-backfill** step for local (its
  projection tables are empty on cold start until `iam.*` events flow) — and
  whether sessions-api's authz checks tolerate that convergence lag, or need a
  verify-time wait like other event-kind deps.
- `verify.sh` health endpoint for authz-api (`/health` assumed).

---

## Sequencing & verification

1. **soa#401 Option 2 + unit guard** — land first; unblocks the Playwright spawn.
2. **soa#402 Option 1** (pending @nerisaurus sign-off) — makes sessions reads pass.
3. **Verify end-to-end:** `ss e2e run connectv3/connect-observe-qtf --skip-reset
   --headless` should now list+run tests (401 fixed) and get past the sessions
   `dayList` read without HTTP 408 (402 fixed). Also re-run saga-dash `journey`
   through stage 6+.
4. **soa#401 Option 3** — durable follow-up, coordinated with the `coach` repo.

**Interim workaround (no code):** drop `--headless` — the flow is
`foreground:true`, so headed is its default and the `--headed` flag shields the
argv bug: `ss e2e run connectv3/connect-observe-qtf --skip-reset`.

# Cross-Repo Consolidation Plan

*Analysis date: 2026-06-25 · Scope: all 11 Saga repos (soa, rostering, iac, qboard, saga-dash, program-hub, student-data-system, fleek, claude-plugins, janus, coach)*

This is an **analysis + plan**, not applied changes. It maps duplicated code across repos and proposes what to hoist into SOA (or other shared homes), plus per-repo within-repo cleanups. Nothing here has been merged.

## How to read this

- **Tier A/B/C** = cross-repo hoists, ranked by ROI (duplication × number of repos × stability of the pattern).
- Each hoist names: what's duplicated, where it lives today, the proposed shared home, rough LOC saved, and the blocker/risk.
- Per-repo sections list **collapse/remove** wins that are local to one repo.
- LOC figures are agent estimates — directional, not audited.

---

## Executive summary

The single biggest theme: **the SOA-backed Express + tRPC + Inversify + Postgres/Mongo service** is re-implemented, nearly identically, in **rostering, student-data-system (SDS), coach, and program-hub** — and partially in qboard's connectv3-api. SOA already owns the *pieces* (`soa-config`, `soa-logger`, `soa-api-core`, `soa-trpc-base`, `soa-postgres`, `soa-db`) but **not the bootstrap that wires them together**. Each service hand-rolls ~1,000–1,600 LOC of container wiring, Express middleware stack, DB init (RDS IAM auth + reconnect loop), tRPC context, and auth middleware. This is the highest-value target by a wide margin.

Three other clusters:
1. **Frontend auth/fetch** — saga-dash's SagaAuth fetch interceptor will be copy-pasted into the janus login app (which is documented to "mirror saga-dash"). Extract before it forks.
2. **Legacy saga_api cookie auth** — inlined in fleek, qboard (connectv3-api), and coach. Two repos already have a `packages/core/iam-auth`. Converge to one (gated on the iam-api migration).
3. **Infra/CI** — ECS+ALB SAM templates, deploy bash scripts, and PR-preview/deploy/cleanup GitHub workflows are 80%+ identical across every backend repo.

---

## Tier A — backend service bootstrap (highest ROI)

These are duplicated across **rostering, SDS, coach, program-hub** (4 repos, several services each). SOA is the right home. Recommend grouping into a small number of new packages rather than one mega-package.

### A1. `@saga-ed/soa-di-bootstrap` — Inversify container factory
- **Duplicated:** config-manager binding, logger binding, DB-provider binding + async resolution, server/controller-loader binding. Domain services stay in-app.
- **Where today:** SDS `inversify.config.ts` ×5 (~1,310 LOC), coach `inversify.config.ts` (~250), program-hub ×4, rostering iam-api/sis-api.
- **Shape:** `createBaseContainer(config)` + `extendContainer(base, { providers, services, sectors })`.
- **Est. saved:** ~800 LOC/repo → ~2,400 LOC across the cluster.
- **Risk:** Medium. Container shapes vary (event consumers, multi-DB). Factory must allow opt-in blocks.

### A2. `@saga-ed/soa-express-bootstrap` — Express app factory
- **Duplicated:** CORS (origin allowlist), helmet CSP, rate-limit, cookie parsing, request-logger, health/readiness mount, graceful shutdown (SIGTERM/SIGINT), Janus perimeter mount. Leaves tRPC/GraphQL wiring to the app.
- **Where today:** SDS `main.ts` ×4 (~1,630 LOC total), program-hub `main.ts` ×4, coach `main.ts` (~300), rostering iam-api (1,045) / sis-api (175).
- **Shape:** `createExpressApp({ cors, helmet, rateLimit, janus, health, middleware })`.
- **Est. saved:** ~300 LOC/repo → ~900–1,200 across cluster.
- **Risk:** Medium. iam-api's main.ts is genuinely feature-rich (SAML, OAuth, JWKS) — it consumes the factory but keeps its domain routes. Don't over-generalize.

### A3. `@saga-ed/soa-postgres` enhancement — DB bootstrap (RDS IAM + reconnect)
- **Duplicated:** connection-string builder, RDS IAM-auth token vs static-password fallback, SSL CA pin, retry/backoff, 30s reconnect health loop, `initDb()` ceremony.
- **Where today:** SDS `*-db` providers ×5 (~535 LOC, ledger-db variant most complete), coach db package, rostering `db-init.ts` (iam-api multi-DB 150 + sis-api single-DB 104, explicitly "analogue").
- **Shape:** extend existing `PostgresProvider` with an `initDb()` helper that adapts single vs multi-DB and IAM vs static. RDS IAM auth becomes an optional strategy.
- **Est. saved:** ~400 LOC/repo → ~1,200 across cluster.
- **Risk:** Low–medium. Pattern is proven and stable; mostly mechanical.

### A4. `@saga-ed/soa-trpc-base` extension — context + protected procedure
- **Duplicated:** `initTRPC.context()` + `enforceAuth` middleware + `protectedProcedure`. (ads-adm-api already uses soa-trpc-base; the others inline it.)
- **Where today:** SDS ledger/transcripts/chat/insights `trpc.ts` ×4 (near-identical), program-hub ×4, coach, rostering.
- **Shape:** export `createProtectedProcedure(contextShape)` + the auth middleware; context object stays app-specific.
- **Est. saved:** ~200 LOC/repo.
- **Risk:** Medium — context shapes differ; share the middleware, not the shape.

### A5. `@saga-ed/soa-config` extension — Zod env helpers + base schemas
- **Duplicated:** `envBoolean` / `envNumber` / `envStringArray` / `emptyStringToUndefined` preprocessors, and the "extend SOA base schema with coercion" pattern.
- **Where today:** every backend repo redefines `envBoolean` (rostering ×2, SDS ×5, coach, program-hub). Coach already tracks this as SOA-4.
- **Shape:** export the preprocessors + pre-extended `ExpressServer`/`Security` schemas from `soa-config`.
- **Est. saved:** ~50 LOC/repo (low LOC, but touches every service → high consistency value).
- **Risk:** Low. Pure utility.

### A6. `@saga-ed/soa-auth-context` — AsyncLocalStorage auth context
- **Duplicated:** `AuthContext` type + `authStore` (AsyncLocalStorage) + `getAuthContext()` + middleware — **identical copies**.
- **Where today:** SDS ×3–4 (transcripts/chat/insights/ledger, 38 LOC each), coach, rostering iam-api (richer variant).
- **Est. saved:** ~300 LOC across cluster.
- **Risk:** Low for the simple variant; iam-api keeps its richer perimeter logic.

### A7. tracing-init / OTel bootstrap — template export
- **Duplicated:** `import 'dotenv/config'` + `initTracing(SERVICE_NAME)`, plus the externalize-OTel build rule.
- **Where today:** program-hub `tracing-init.ts` ×4 (exact copies), rostering ×2, coach, qboard connectv3-api.
- **Shape:** a documented one-liner export from `@saga-ed/soa-observability` + a tsup externalization recipe in shared docs. (Each app keeps its own entry file; this is mostly convention + a helper.)
- **Risk:** Low.

> **Standardize health probes** while doing A2: rostering iam-api, program-hub, and coach use `@saga-ed/soa-health` mounters; SDS sis-api/authz-sync and several others hand-roll `/health`. Move everyone to `soa-health`.

---

## Tier B — frontend + identity clients

### B1. `@saga-ed/saga-fetch` — SagaAuth fetch interceptor (HIGH, time-sensitive)
- **Duplicated / about to be:** the `WWW-Authenticate: SagaAuth` 401 parser + login redirect + iam-session keepalive. Lives in saga-dash `dash-data` (`sagaAuthFetch.ts` 93, `authAwareFetch.ts` 33, `iamRefresh.ts`). The **janus login app is documented to "mirror saga-dash conventions"** and will copy-paste it; coach-web and qboard are likely future consumers.
- **Shape:** browser package = composable fetch wrapper + challenge parser + redirect builder. Could fold into `@saga-ed/janus-client` v0.3 (it already owns the browser SagaAuth signal).
- **Why now:** extracting *before* janus forks it avoids a 3-way divergence. This is the cheapest high-value frontend win.
- **Risk:** Low.

### B2. iam-api 401 emit (server side) — into `@saga-ed/soa-api-util`
- **Duplicated:** the `WWW-Authenticate: SagaAuth realm=…` 401 *response builder*, emitted by iam-api, rostering, program-hub, qboard connectv3-api. Partially in `soa-api-util` already.
- **Shape:** sharpen the existing soa-api-util builder into the one canonical emitter. Pairs with B1 (same contract, both ends).
- **Risk:** Low.

### B3. `@saga-ed/iam-api-client-node` — typed tRPC client + caching
- **Duplicated:** singleton tRPC client factory, S2S token header, per-method TTL caching around iam-api procedures. coach has the most complete version (`services/iam-api/`); program-hub and SDS (ads-adm-api) consume iam-api the same way. rostering is the **host** (publishes `@saga-ed/iam-api-types`).
- **Shape:** publish the client next to the types — `@saga-ed/iam-api-client-node` consuming `IamAppRouter`.
- **Est. saved:** ~150 LOC/consumer.
- **Risk:** Medium — caching policy and auth-header refresh differ slightly per consumer.

### B4. Shared SvelteKit base (janus ↔ saga-dash)
- **Duplicated:** Svelte 5 `vite.config`/`svelte.config`/`tsconfig`, the Vitest browser+server project split (repeated ~14× inside saga-dash alone), CSP setup (hash mode + Datadog `worker-src`), the `soa-rum-util` wrapper pattern, and `amplify-deploy.sh`.
- **Shape:** `@saga-ed/sveltekit-config-base` (config presets + shared Vitest preset) and a shared `amplify-deploy` script/GH action. RUM already shared via `soa-rum-util`; only the thin wrapper repeats.
- **Est. saved:** ~200 LOC within saga-dash + avoids janus duplication.
- **Risk:** Low.

### B5. `@saga-ed/dash-design-tokens`
- **Duplicated/fragmented:** brand tokens split across saga-dash `constellation-bg/tokens.css`, `legacy-styles/_tokens.scss`, and `reports/qtf-variables.css` — none exported as a shared module.
- **Shape:** one package exporting both CSS and Sass, consumed by core-ui + constellation-bg + legacy-styles (+ janus, coach-web if they use saga-red/dark-blue).
- **Risk:** Low.

---

## Tier C — legacy auth, infra, CI

### C1. Converge saga_api cookie auth → one `@saga-ed/iam-auth` (blocked on iam-api migration)
- **Duplicated:** the saga_api `/saga_session` cookie round-trip + role gate is **inlined in fleek (`recordings-api/auth.ts` 198), qboard (`connectv3-api`), and coach**. Both qboard and coach *already* have a `packages/core/iam-auth` package; coach's is explicitly slated for deletion in its iam-api migration.
- **Shape:** one published `@saga-ed/iam-auth` (or just adopt B3's iam-api client once everyone migrates). The three inliners depend on it instead of hand-rolling.
- **Est. saved:** ~600 LOC.
- **Blocker:** all three must migrate to iam-api in lockstep — that migration is the actual gating work (coach#91/#93). Until then this stays duplicated *by design*. **Track, don't force.**

### C2. `@saga-ed/domain-validation` — CORS/origin allowlist
- **Duplicated:** Saga root-domain parsing + CORS origin matching in fleek, qboard connectv3-api, coach (`valid-domains.ts`, ~50 LOC, ×3 — already flagged in code comments).
- **Shape:** tiny shared package, or fold into `soa-api-util` (which already has `buildSagaOriginAllowlist`).
- **Risk:** Low. No blocker.

### C3. Shared ECS+ALB SAM template library
- **Duplicated:** bootstrap/routing/service SAM stacks per service — qboard ×4 (~1.2k LOC), SDS ×4, coach, rostering, plus the canonical generic template in **iac** (`ecs/service/ecs_service_template.yaml`). Several repos' comments literally say "Based on: ledger/infra/…".
- **Shape:** a parameterized SAM macro / template fragment library (shared base: cluster, subnets, SGs, log driver, health check, autoscaling; per-app overrides for env/ports/image). Natural home: iac, or a dedicated infra-templates repo.
- **Est. saved:** ~50% of each service's CFN (~700 LOC/repo).
- **Risk:** Medium — template macros add indirection; do it once iac's generic template is the agreed base.

### C4. Shared deploy scripts (`deploy-common.sh`)
- **Duplicated:** Docker build → ECR push → CF deploy (routing+service) → switchboard register → teardown. qboard ×4 (~1.2k LOC), fleek, others.
- **Shape:** `scripts/lib/deploy-common.sh` (or a small Python CLI). iac's `saga-platform` package is the emerging home for ops tooling — consider publishing it.
- **Risk:** Low–medium.

### C5. Reusable GitHub Actions workflows
- **Duplicated:** PR-preview / deploy / cleanup workflows are 80%+ identical across every backend repo (rostering 22 files, SDS 5, program-hub 4, coach, qboard 6). Common bits: CodeArtifact auth, pnpm+Prisma generate, turbo build/test/lint, ECR push, ALB header routing.
- **Shape:** GitHub **reusable workflows** + composite actions parameterized by service name + cluster. Some repos already have partial `_deploy-*.yml` templates — generalize them.
- **Est. saved:** ~50 LOC/workflow × dozens of workflows.
- **Risk:** Low.

### C6. `@saga-ed/playwright-helpers`
- **Duplicated/at-risk:** iac `playwright_tests/` has a mature harness (base-test fixtures, AWS-Secrets credential fallback, WAF-bypass, auth cache, page-object conventions). saga-dash, janus, and coach each have or will grow Playwright suites that re-implement auth + WAF + fixtures.
- **Shape:** publish the iac harness's reusable core as a package.
- **Risk:** Medium — iac is currently standalone (no `@saga-ed/*` deps); this introduces a publish/consume relationship.

### C7. iac internal CFN dedup (within-repo)
- Not cross-repo, but high local ROI: **12 security-group templates** (~70% boilerplate), **19 GitHub-Actions IAM-role templates** (identical OIDC federation, only policy differs), **159 samconfig.yaml** files. → a base SG template/macro, a parameterized role template, and a samconfig generator.

---

## Per-repo within-repo cleanups (collapse / remove)

**coach** (clearest removal list — mostly migration debris):
- Delete `packages/core/iam-auth/` (legacy saga_api wrapper, ~300 LOC, replaced by iam-api+Janus — coach#93).
- Delete `src/sectors/_temp-saga-test/` (~60 LOC, coach#99).
- Remove/deprecate `src/services/saga-api/` (~200 LOC) once all calls move to iam-api/GraphQL.

**saga-dash:**
- Audit + remove stubbed `dash-data/src/graphql.ts` (32) and `qtf.ts` (59) — they throw/return empty, kept only for page compat.
- Remove parked Playwright e2e config (suite is `testIgnore: ['**/*']` pending Janus fixtures).
- Revisit dashboard/program-config acting as composite shells over other page packages (weakens the independent-page model).

**iac:**
- Delete `playwright_tests/tests_backup/` (old framework, ~9 files).
- Audit `app_config/` POC templates for removal.

**claude-plugins:**
- 11× identical `check-plugin-version.sh` (759 LOC). Canonical already exists at `scripts/check-plugin-version.sh` + a sync script — **wire `sync-plugin-version-hook.sh --check` into CI** to enforce zero-drift. (Reference docs `report-format.md`/`classification.md` differ by design — leave them.)

**rostering:**
- `_load-env.ts` and `db-init.ts` are explicitly copy-pasted between iam-api and sis-api ("Mirrors…", "analogue of…") → first consumers of A3/A5.
- Automate `iam-api-types` (351 LOC, hand-mirrored tRPC subset → drift risk) via generation from the router.

**SDS:**
- Merge the thin `ads-adm-seed` package into `ads-adm-api/src/config/`.
- Consolidate the 5 near-identical `*-db` PostgresProviders onto one base (feeds A3).

**qboard:**
- `cv3-icons` (42 LOC + 96 LOC gen script) is a thin iconify re-export — inline or move into a build step.

**fleek:**
- Duplicate JSON `logger.ts` in recorder + recordings-api → one workspace module (trivial).

**janus:**
- Gate `whoami-handler.ts` reimplements verify + cookie parse that `@saga-ed/janus-client/server` already exports (~50 LOC) — import instead. (Repo is otherwise clean; no soa-auth-token leftovers.)

**program-hub:**
- Dockerfiles (3-stage, ~95% identical ×4) and `docker-entrypoint.sh` (exact copy ×4) → base Dockerfile + `API_NAME`/`WORKSPACE_PKGS` args. Feeds C3/C5.

---

## Recommended sequencing

1. **Quick local wins (no cross-repo coordination):** coach removals, saga-dash dead-code audit, iac backup deletion, claude-plugins hook-sync CI, fleek logger, janus whoami import. Low risk, immediate.
2. **Tier A5 + A3 first** (config helpers, DB bootstrap): lowest-risk hoists, unblock rostering's already-acknowledged copy-paste, and prove the SOA-extension workflow.
3. **Tier B1+B2** (saga-fetch + 401 emit): time-sensitive — do before the janus login app forks saga-dash's interceptor.
4. **Tier A1/A2/A4/A6** (DI + Express + tRPC + auth-context bootstrap): the big LOC win, but needs a careful factory design and one pilot repo (SDS or coach) before rolling to all four.
5. **Tier C** (infra/CI/legacy auth): C2/C5 are easy; C1 waits on the iam-api migration; C3/C4/C6 are larger infra projects to schedule deliberately.

## Risks & cross-cutting notes

- **Version pinning:** SOA packages are consumed via `workspace:*` / exact pins from CodeArtifact; every downstream repo's CLAUDE.md says "match SOA versions exactly." Any new SOA package = a coordinated version bump across consumers. Budget for it.
- **Don't over-hoist.** Sector scaffolding, GraphQL schemas, Fishery factories, event registries, and per-domain config are correctly per-app — agents repeatedly flagged these as **not** consolidation targets. The win is in *bootstrap*, not *domain*.
- **iac is currently standalone** (no `@saga-ed/*` deps). C3/C6 introduce a publish relationship — a real architectural decision, not just a refactor.
- **Two repos already named the same package `@saga-ed/iam-auth`** (qboard core + coach core) for different things. Naming needs deconfliction before C1/B3.

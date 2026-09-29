# saga-stack-cli — Implementation Plan of Record

> Status: plan-of-record. Supersedes the five independent design fragments and folds in the adversarial review's blocker/major corrections and the synthesized judge-panel sequencing. Issue: **saga-ed/soa#214**. Package: `@saga-ed/saga-stack-cli` at `/home/skelly/dev/soa/packages/node/saga-stack-cli/`.

---

## 1. Context

The synthetic-dev developer stack and the saga-dash e2e suite are driven today by **two bodies of bash** that have grown past what bash should carry:

- **The stack body** — `tools/synthetic-dev/{up.sh (~3.4k lines), verify.sh, refresh-suite.sh, tunnel.sh, bootstrap.sh}`. `up.sh` alone encodes the topology of 10 services + 3 optional playback APIs as **parallel arrays** (port literals `182-299`, the `want_service` gate `1048`, the 140-line bespoke per-service env wall in `services_up` `1373-1553`, the migrate order in `prep` `1003-1025`, the `seed_*` family `1610-1714`, the reset truncate list `1575`).
- **The e2e body** — `saga-dash/.../e2e/{check-e2e.sh, run-stack-e2e.sh, connect-session.sh}`. The 8-phase journey, the phase→Playwright-project map, and the stack lifecycle calls (`up.sh --reset --seed roster` → `verify.sh` → `playwright test`) are hardcoded; the weekday date logic is copy-pasted across five specs.

Two new requirements broke the camel's back — **neither is expressible in the current bash**:

1. **N-of-M partial stacks.** `up.sh`'s `--only` is single-service-or-everything (`want_service`, `1048`); there is no dependency closure. The motivating scenario "bring up just `scheduling-api` + `sessions-api` (and whatever they transitively need)" cannot be done without editing arrays by hand.
2. **Per-SPA, per-flow seed selection.** The monolithic `--seed roster|full` (`1735-1746`) cannot express "seed iam at `roster` but programs `empty` for this flow," and there is no path for a second SPA (connectv3) to contribute its own flows without forking the e2e bash.

`@saga-ed/mesh-fixture-cli` is **superseded** by this effort. Its HTTP/tRPC create commands (`iam:`/`pgm:`/`ads:`) are dropped (they conflict with the locked no-HTTP-seeding posture); only its **snapshot fast-path** and **output conventions** (`BaseCommand.emit()`) are carried forward and rebuilt.

The CLI is **one OCLIF package, two topics** (`stack`, `e2e`) over a shared pure core. Binary `saga-stack`, space topic separator (`saga-stack stack up`).

---

## 2. Architecture

### 2.1 Shape: one package, two topics, a pure core

```
src/
  base-command.ts        # ported emit() triple-output (json / porcelain / human)
  shared-flags.ts        # --porcelain --output-json --dev --state-dir + per-repo overrides
  core/                  # PURE. zero IO. no docker/pnpm/curl/git/fs-spawn. unit-tested.
    manifest/            # the linchpin (TS module — see §2.2)
      types.ts services.ts mesh.ts databases.ts index.ts
    closure.ts           # computeClosure() — the N-of-M engine
    launch-order.ts want-service.ts lane.ts workspace.ts restore-map.ts
    seed/                # canonical SeedStep/SeedPlan + profiles + composeSeedPlan
    flow/                # FlowManifest schema (zod) + resolveFlow + verify-plan
    index.ts             # the pure API the command layer + e2e consume
  runtime/               # SIDE-EFFECTING adapters. thin. integration-tested / mocked.
    docker.ts pnpm.ts health.ts git.ts snapshot.ts playwright.ts repos.ts
  stack-api.ts           # in-process facade: up/down/reset/seed/verify/login (§6.3)
  commands/
    stack/ ...           # up down restart status reset seed verify login overlay tunnel  + snapshot/*
    e2e/ run.ts list.ts connect.ts
```

A lint import-boundary rule forbids `core/**` from importing `node:child_process`, `docker`, network, or `fs`-spawn. `runtime/**` is the only place the world is touched. Commands are thin: parse flags → `core` computes a plan → `runtime` executes it → `emit()`.

### 2.2 The service manifest is the linchpin — and it is a **TS module, not JSON**

**Contradiction resolved (review blocker):** the two fragments specified the manifest both as a TS module and as `service-manifest.json` + a zod loader. We ship **exactly one: a frozen TS module** under `core/manifest/`. Rationale: launch env values are *templated functions of lane+ports* (`CORS_ORIGIN="$DASH_URL,$CONNECT_WEB_URL"`, `IAM_BASEURL="$IAM_URL/trpc"`), and `ServiceId`/`DbId` as union types make a typo in `dependsOn` a **compile error** — the closure's correctness rests on well-formed edges. JSON+zod is reserved for the **external** `flows.json` contract (§5), which third-party SPA repos author without depending on the CLI's types.

There is **one** `ServiceId`/`DbId`/`DatabaseDef` source of truth (review minor: enums were triplicated). `core/seed/` **imports** `DatabaseDef` from the manifest rather than redeclaring `MESH_DATABASES`; owner roles, passwords, and `POSTGRES_*` connection tokens live on the manifest's `DatabaseDef`, not hardcoded in the seed registry.

#### Corrected TS schema (key types)

```ts
export type ServiceId =
  | 'iam-api' | 'sis-api' | 'programs-api' | 'scheduling-api' | 'sessions-api'
  | 'content-api' | 'ads-adm-api' | 'saga-dash' | 'connect-api' | 'connect-web'
  | 'rtsm-api'
  | 'transcripts-api' | 'insights-api' | 'chat-api';   // optional: true (--with-playback)

export type MeshId = 'postgres' | 'redis' | 'rabbitmq' | 'connect-mongo';
export type RepoKey = 'SOA'|'ROSTERING'|'PROGRAM_HUB'|'SAGA_DASH'|'SDS'|'QBOARD'|'RTSM'|'FLEEK';
export type Lane = 'stack' | 'sandbox' | 'tunnel';
export type DepKind = 'url' | 's2s' | 'event' | 'browser';
export type Engine = 'postgres' | 'mongo';

export interface DatabaseDef {
  name: string; engine: Engine;
  migrate: MigrateSpec | null;          // null ⇒ no schema (mongo auto-create / rtsm stateless)
  ownerRole: string; ownerPw: string;   // restore-as identity (snapshot invariant #2)
  resettable: boolean;                  // included in `stack reset`
  resetMode: 'truncate' | 'migrate-reset'; // 'truncate' preserves _prisma_migrations; 'migrate-reset' = drop+remigrate (ledger_local — decision 2026-06-29)
  meshProvisioned: boolean;             // created by profile-empty.sql at mesh-up
}
export interface MigrateSpec {
  dir: string;                          // repo-relative dir that OWNS the schema
  cmd: 'db:deploy' | 'prisma migrate deploy' | 'prisma db push';
  databaseUrlOverride?: boolean;        // force mesh :5432 (program-hub apps default :5433)
}

export interface ServiceDef {
  id: ServiceId; repo: RepoKey; subpath: string;
  port: number; portEnvVar?: 'PORT'|'EXPRESS_SERVER_PORT'|null;
  healthPath: string;                   // '/health' | '/' | '/connectv3/v1/health'
  databases: DbId[];
  dependsOn: ServiceId[];
  depKinds: Partial<Record<ServiceId, DepKind>>;
  mesh: MeshId[];
  launch: { cmd: string; env: Record<string,string> };  // tokens resolved at launch by lane()
  seed: SeedStepRef[];                  // canonical SeedStep ids (see §2.2 + §4)
  lane: LaneTemplates;                  // { stack, sandbox, tunnel } URL templates
  tunnelSlug: string;                   // PUBLIC host slug (review major) — see below
  isFrontend: boolean; optional: boolean;
  prelaunchHook?: 'sync-dash-local-defaults';   // review minor — see §3
}
```

**`tunnelSlug` (review major).** `tunnel.sh:55-66` exposes abbreviated host slugs (`iam`, `dash`, `connect`, `ads-adm`, `rtsm`), not `ServiceId`s. Rendering the tunnel lane from `ServiceId` would mint hostnames that don't match the wildcard cert / Caddy site blocks → TLS/404. The manifest now carries `tunnelSlug` per service (default = id with `-api`/`-web` stripped; `saga-dash`→`dash`, `connect-web`→`connect`). The tunnel lane renders from `tunnelSlug` and exposes a **fixed browser-plane set**, not the full closure.

#### Populated manifest — all 10 services + 3 playback + mesh

| id | repo · subpath | port (envVar) | health | tunnelSlug | DBs | dependsOn (kind) | mesh | FE |
|---|---|---|---|---|---|---|---|---|
| `iam-api` | ROSTERING · `apps/node/iam-api` | 3010 (`PORT`) | `/health` | `iam` | iam_local, iam_pii_local | — | pg, redis‡ | n |
| `sis-api` | ROSTERING · `apps/node/sis-api` | 3100 (`PORT`) | `/health` | `sis` | sis_db | iam-api (s2s) | pg | n |
| `programs-api` | PROGRAM_HUB · `apps/node/programs-api` | 3006 (—) | `/health` | `programs` | programs | iam-api (url) | pg, rabbitmq, redis‡ | n |
| `scheduling-api` | PROGRAM_HUB · `apps/node/scheduling-api` | 3008 (—) | `/health` | `scheduling` | scheduling | iam-api (url) | pg, rabbitmq, redis‡ | n |
| `sessions-api` | PROGRAM_HUB · `apps/node/sessions-api` | 3007 (—) | `/health` | `sessions` | sessions | iam-api (url, req), programs-api (event), scheduling-api (event) | pg, rabbitmq, redis‡ | n |
| `content-api` | PROGRAM_HUB · `apps/node/content-api` | 3009 (`PORT`) | `/health` | `content` | content | iam-api (url) | pg, rabbitmq, redis‡ | n |
| `ads-adm-api` | SDS · `apps/node/ads-adm-api` | 5005 (—) | `/health` | `ads-adm` | ads_adm_local, ledger_local | iam-api (url), sessions-api (s2s) | pg, rabbitmq | n |
| `saga-dash` | SAGA_DASH · `apps/web/dash` | 8900 (—) | `/` | `dash` | — | iam-api, **sis-api**, programs-api, scheduling-api, sessions-api, content-api, ads-adm-api (browser) | — | **y** |
| `connect-api` | QBOARD · `apps/node/connectv3-api` | 6106 (`PORT`) | `/connectv3/v1/health` | `connect-api` | connectv3 (mongo) | iam-api (url), sessions-api (url), content-api (url) | connect-mongo | n |
| `connect-web` | QBOARD · `apps/web/connectv3` | 6210 (—) | `/` | `connect` | — | connect-api, rtsm-api, iam-api (browser) | — | **y** |
| `rtsm-api` | RTSM · `apps/node/rtsm-api` | 6110 (`EXPRESS_SERVER_PORT`) | `/health` | `rtsm` | — | — | — | n |
| `transcripts-api`✶ | SDS · `apps/node/transcripts-api` | 6302 (`EXPRESS_SERVER_PORT`) | `/health` | `transcripts` | transcripts_local | — | pg | n |
| `insights-api`✶ | SDS · `apps/node/insights-api` | 6301 (`EXPRESS_SERVER_PORT`) | `/health` | `insights` | insights_local | — | pg | n |
| `chat-api`✶ | SDS · `apps/node/chat-api` | 6303 (`EXPRESS_SERVER_PORT`) | `/health` | `chat` | chat_local | — | pg | n |

✶ = `optional:true`. ‡ redis is modeled **off by default per service** until a config read proves a redis client; mesh is started as a unit (single `make up PROFILE=empty`), so this is non-blocking for v1 (open question §8).

**Two corrected edges (review majors):** `saga-dash.dependsOn` now includes **`sis-api`** (the roster CSV page calls sis from the browser; `apply_fixes` patches the dash config to `:3100`) and `content-api` (content picker). Without `sis-api`, `stack up --only saga-dash` produced a closure that broke the roster flow — the graph, not per-stage patching, is now correct.

#### Databases (corrected against `profile-empty.sql`)

The review **resolved** the stale-research TODOs against `infra/compose/projects/saga-mesh/seed/profile-empty.sql`: `profile-empty.sql` creates **9 app DBs including both `content` AND `ledger_local`**.

| name | engine | owner role / pw | migrate (dir, cmd) | resettable | meshProvisioned |
|---|---|---|---|---|---|
| iam_local | postgres | iam / iam | `packages/node/iam-db`, `prisma migrate deploy` | yes | yes |
| **iam_pii_local** | postgres | iam_pii / iam_pii | **`packages/node/iam-pii-db`, `prisma db push`** | yes | yes |
| programs | postgres | saga_user / password123 | `apps/node/programs-api`, `db:deploy` (url override) | yes | yes |
| scheduling | postgres | saga_user / password123 | `apps/node/scheduling-api`, `db:deploy` (override) | yes | yes |
| sessions | postgres | saga_user / password123 | `apps/node/sessions-api`, `db:deploy` (override) | yes | yes |
| content | postgres | saga_user / password123 | `apps/node/content-api`, `db:deploy` (override) | yes | yes |
| sis_db | postgres | sis / sis | `packages/node/sis-db` | yes | yes |
| ads_adm_local | postgres | ads_adm / ads_adm | `packages/node/ads-adm-db`, `prisma migrate deploy` | yes | yes |
| **ledger_local** | postgres | **ledger / ledger** | (ads-adm-db; lazily populated) | **yes (`migrate-reset`, not truncate)** | **yes** |
| transcripts_local | postgres | transcripts_app / transcripts_app_local_pw | `packages/node/transcripts-db` | yes (playback) | no |
| insights_local | postgres | insights_app / insights_app_local_pw | `packages/node/insights-db` | yes (playback) | no |
| chat_local | postgres | chat_app / chat_app_local_pw | `packages/node/chat-db` | yes (playback) | no |
| connectv3 | mongo | — | null (auto-create) | yes (dropDatabase) | n/a |

**Blocker fix — `iam_pii_local`:** it is owned by a **separate `iam-pii-db` package** applied with **`prisma db push`** (no migration history), a distinct step in `prep`. The previous schema mis-attributed it to `iam-db` and omitted it from the migrate order, so the PII schema would never be applied and iam-api would silently write blank names. **Corrected migrate order:** `iam-db → iam-pii-db (db push) → programs → scheduling → sessions → content → sis-db → ads-adm-db`.

**Major fix — `ledger_local` owner:** `profile-empty.sql` creates a dedicated `ledger` role and `CREATE DATABASE ledger_local OWNER ledger`. Snapshot restore connects **as the DB owner**; the previous `ads_adm` role would fail on `_prisma_migrations` permissions. Owner role is now `ledger`. `ownedByService` stays `ads-adm-api` for the seed-skip logic. **Decision (2026-06-29): `ledger_local` IS reset (`resettable:true`) but via `resetMode:'migrate-reset'` (drop + remigrate, e.g. `prisma migrate reset`) — NOT the blanket `TRUNCATE`-preserving-`_prisma_migrations` used for the other core DBs.** It is mesh-provisioned and was absent from `up.sh:1575`; the reset runner special-cases it so a stale ledger never survives a reset while avoiding `TRUNCATE` on the ledger tables.

#### Mesh

| id | container | port | readiness (timeoutSec) |
|---|---|---|---|
| postgres | `soa-postgres-1` | 5432 | `pg_isready -U postgres_admin` (20) |
| redis | `soa-redis-1` | 6379 | `redis-cli ping` → PONG (20) |
| rabbitmq | `soa-rabbitmq-1` | 5672 (mgmt 15672) | `rabbitmq-diagnostics -q ping` (45 — slowest cold boot) |
| connect-mongo | `soa-connect-mongo-1` | 27037 | `mongosh --eval 'db.runCommand({ping:1}).ok'` (20) |

### 2.3 Dependency closure — algorithm + worked N-of-M example

`core/closure.ts` (pure). BFS transitive closure over `dependsOn`, union the databases + mesh, topo-sort for launch waves. `event`/`browser` edges constrain *order* (producer before consumer) but the launcher may treat `event` deps as non-blocking for health (projections converge async via the rabbitmq outbox).

```ts
export interface Closure {
  services: ServiceId[];               // topo-ordered launch waves
  databases: DbId[];                   // migrate/seed targets
  mesh: MeshId[];
  reasons: Map<ServiceId, string[]>;   // why each pulled-in service is present
}
export function computeClosure(m: Manifest, requested: ServiceId[],
                               opts: { withPlayback?: boolean } = {}): Closure
```

**Worked example — the motivating scenario `--only scheduling-api,sessions-api`:**

```
BFS:  scheduling-api →(url) iam-api ; sessions-api →(url,req) iam-api
      sessions-api →(event) programs-api ; sessions-api →(event) scheduling-api (requested)
      programs-api →(url) iam-api
closure.services (topo) = [ iam-api, programs-api ∥ scheduling-api, sessions-api ]
closure.databases       = iam_local, iam_pii_local, programs, scheduling, sessions   → 5 of 9
   EXCLUDED: sis_db, content, ads_adm_local, ledger_local, connectv3
closure.mesh            = postgres, rabbitmq   (mongo dropped — no connect-api)
```

**4 of 10 services, 5 of 9 DBs, mongo dropped — computed from data, no array editing.** This is impossible under `up.sh`'s `want_service`.

**Corrected `saga-dash` closure (review major).** `depClosure(['saga-dash'])` = **`iam-api, sis-api, programs-api, scheduling-api, sessions-api, content-api, ads-adm-api, saga-dash`** (+ mesh). It does **not** reach `connect-api`/`connect-web`/`rtsm-api` — those are an independent subgraph. The earlier "all 10" assertion was impossible and is removed from the test expectations.

**Corrected `connect-session` closure (review major).** `connect-api →(url) content-api`, so any closure containing `connect-api` **must include `content-api` and its `content` DB**. The connect-session effective closure is `iam, sis, programs, scheduling, sessions, content, connect-api, connect-web, rtsm, saga-dash` (+ mesh). The two fragments now compute identical connect-api closures.

### 2.4 What derives from the one manifest

`launch order`, `stack verify` health probes (closes the **content-api `:3009` probe gap** — `verify.sh` had none), data assertions, mesh readiness, `stack status`, migrate, seed selection, reset truncate set, and lane URL injection all derive from the manifest + `computeClosure()`. Roughly **600+ lines of bash** (`services_up` + `mesh_up` + `prep` migrate + the seed family + the `182-299` literal block) collapse to one frozen TS manifest + ~5 generic, unit-tested consumers.

---

## 3. Command surface

Two topics. All commands extend `BaseCommand` and render through `emit()` (`--output-json` → pretty JSON; `--porcelain` → `key=value`; default → human). Global flags: `--porcelain`, `--output-json`, `--dev <dir>` (default `$DEV ?? $HOME/dev`), `--state-dir <dir>` (default `/tmp/sds-synthetic`), and per-repo overrides `--soa/--rostering/--program-hub/--saga-dash/--sds/--qboard/--rtsm/--fleek`. The mesh-fixture stale `--iam-url :3000` default is **corrected to `:3010`**; the `asFlag`/`sourceFlag`/`fixtureIdFlag` are **dropped** (they belonged to the retired HTTP create commands).

### 3.1 `stack` tree

| Command | Key flags | Maps |
|---|---|---|
| `stack bootstrap` | `--no-refresh`, `--seed <roster\|full>`, `--yes` (NEW non-interactive) | `bootstrap.sh` |
| `stack up` | `--reset`, `--restart`, `--seed [roster\|full]`, `--pull`, `--no-auto-pull`, `--skip-prep`, `--login [email]`, `--record [crdt\|av]`, `--with-playback`, `--with-qtf-demo`, `--tunnel`, **`--only <svc,…>` (comma-list + closure, NEW)**, `--sandbox <name>` (requires `--only`), `--workspace <file.json>` | `up.sh` up-path |
| `stack down` | `--mesh` (NEW — also `make down` infra) | `services_down` |
| `stack restart` | `stack up` flag set minus `--reset` | restart path |
| `stack status` | (read-only; never exits non-zero) | `status()` |
| `stack reset` | `--with-playback`, `--no-reseed-dev-user` | `reset_data` |
| `stack seed` | `--profile <roster\|full>`, `--add playback,qtf`, `--only <svc,…>` (NEW), `--exclude <id,…>` (NEW), `--from-snapshot <id>` (NEW), `--skip-restored` (default on), `--source prod-mirror`, `--dry-run` | `seed_stack` + `seed_*` |
| `stack snapshot {store\|restore\|list\|validate}` | `--fixture-id`, `--only <svc,…>`, `--profile`, `--force`, `--no-flush-redis`, `--deep` | mesh-fixture `snapshot:` (rebuilt) |
| `stack verify` | `--health-only`, `--tolerate <repo>` (NEW, generalizes dash tolerance) | `verify.sh` |
| `stack login` | `[email]` arg, `--jar-only` (NEW headless half) | `login_user` + `open_login_browser` |
| `stack tunnel {up\|down\|status\|moniker\|urls\|aws-profile}` | `--vms-base`; **moniker never a flag** (TTY-interactive) | `tunnel.sh` |
| `stack overlay {apply\|list\|reset\|compose-rest}` | `apply --prs <#s\|branch> <repo…>`; `compose-rest --base/--ttl-hours/--seed-profile/--bypass-header` (**exit code 2 = "spec printed, composed nothing" preserved**) | `refresh-suite.sh` |

**Mesh preflight (review major — `check_ports`).** `up.sh:482-519` runs a host-port preflight over `MESH_PORTS` *before* `make up`, to surface conflicts that otherwise die silently in `mesh.log` under `set -e`. This is added as a **step in the mesh-up runtime adapter**: probe each `MeshDef.port` listener before `docker make up` and surface conflicts. It is not a user flag but a load-bearing internal step that must not be dropped.

**Dash config prelaunch (review minor — `sync_dash_local_defaults`).** `services_up`'s first action writes the dash's `config.local.json` to match the run mode *before* the dash launches. Modeled as `ServiceDef.prelaunchHook: 'sync-dash-local-defaults'` on `saga-dash`, executed by the launcher immediately before that service boots.

### 3.2 `e2e` tree

| Command | Key flags | Maps |
|---|---|---|
| `e2e run` | `--flow <name>` (default `journey`), `--phase <name\|n>` / `--through <phase>`, `--only <svc,…>`, `--lane <stack\|sandbox>`, `--headed`/`--headless`, `--skip-reset`, `--inspect`/`--no-inspect`, `--pause-at-end`, `--inspect-user`, `--stage-only`, `--janus-off`, `--preview-pins`, `-- <pw args>` | `check-e2e.sh` + `run-stack-e2e.sh` |
| `e2e list` | `--flows`, `--phases [--flow]`, `--projects` | `usage()` + `playwright --list` |
| `e2e connect` | `--reuse`/`--skip-build`, `-- <pw args>` (foreground) | `connect-session.sh` |

**Playwright project selection (review nit — reconciled).** For a progressive `--through <phase>` run, pass **only the terminal `--project stage-N`** and rely on Playwright `dependencies` to chain `1..N` (matching `check-e2e.sh:158`). `--stage-only`/`STAGE_ONLY` strips deps and passes the single target stage. This avoids the divergence where the design passed all selected stages.

### 3.3 Capabilities that don't return cleanly

Handled as documented foreground/best-effort, not daemonized: `e2e connect` window hold (`spawn` with `stdio:'inherit'`), `stack login` browser half (`--jar-only` is the deterministic half), `--inspect` post-e2e browser (gated on suite success + health re-check), `--record`/`--with-playback`/`--with-qtf-demo` opt-in side-stacks, tunnel moniker TTY prompt, `compose-rest` exit-2, and AWS/SSM side effects (keep the dev-account assertion; never inline secrets).

### 3.4 Coverage checklist (every bash capability has a home)

Every flag/mode across the six scripts maps to a CLI home — full table omitted for brevity but verified: all `up.sh` verbs/flags, `verify.sh` modes, `refresh-suite.sh` overlay verbs (exit-2 preserved), `tunnel.sh` subcommands, `bootstrap.sh`, `check-e2e.sh` phases + passthrough, `run-stack-e2e.sh` lane/inspect/janus/preview-pins, `connect-session.sh` foreground. **Intentionally dropped:** mesh-fixture `asFlag`/`sourceFlag`/`fixtureIdFlag` and the `iam:`/`pgm:`/`ads:` HTTP create topics (retired with the no-HTTP-seeding decision). **Net-new with no bash antecedent:** `--only` closure, per-system seed, `e2e --flow`/`e2e list`, `stack down --mesh`, `bootstrap --yes`, `verify --tolerate`.

---

## 4. Seeding & snapshot

**Governing principle:** seeding **orchestrates** the existing offline `pnpm db:seed` scripts; it does **not** reimplement them and does **not** seed over HTTP. The one surviving HTTP step (`content`'s `seed-demo-polls.mjs`) is an opaque, self-guarding child script (`failureMode:'warn'`), not a mesh-fixture create command.

### 4.1 Canonical SeedStep / SeedPlan (review major — one contract)

The four divergent seed shapes are unified into **one** `SeedStep` and **one** `SeedPlan`, owned by `core/seed/`. `flows-spa`'s `SeedSelection` *composes into* this; it does not define a parallel shape.

```ts
export interface SeedStep {
  id: string;                       // 'iam' | 'programs' | 'sessions' | 'qtf-demo' | ...
  service: ServiceId;
  databases: DbId[];                // gates the snapshot-skip
  cwd: string; command: string[];   // resolved repo-relative; argv
  env: SeedEnv;                     // dotenv | inline | inline-multi
  requiresServiceUp: ServiceId[];   // non-empty ⇒ online batch (deferred post-launch)
  optionalSteps?: SeedStep[];       // content's demo-polls / legacy-poll, failureMode:'warn'
  failureMode: 'fatal' | 'warn';
}
export interface SeedPlan { offline: SeedStep[]; online: SeedStep[]; skipped: SkipNote[]; }
export function composeSeedPlan(sel: SeedSelection, active: Set<ServiceId>,
                                restored: Set<ServiceId>): SeedPlan;
```

Connection data (`DATABASE_URL`, owner role/pw, `POSTGRES_*`) is **derived from the manifest's `DatabaseDef`** (review minor), not hardcoded in the registry.

**`composeSeedPlan` gates:** (1) drop any step whose `service ∉ active` (partial-stack — the new capability bash lacked); (2) drop any step **all** of whose `databases ∈ restored` (the `restored_db` skip — a service with a partially-restored DB set is **kept**, matching `up.sh:1727`); (3) partition the survivors into `offline`/`online` by `requiresServiceUp`.

**Profiles:** `roster = {iam-dev-user, iam, sessions}`; `full = roster + {programs, content}`; orthogonal add-ons `playback = {transcripts, insights, chat}`, `qtf = {qtf-demo}`. Run order: `iam-dev-user → iam → sessions → qtf → programs → content → playback` (matches `seed_stack`). `qtf` and `content`'s HTTP tail are `online` (need services up); pure `db:seed` steps are `offline`.

### 4.2 Reset (per-system selection aware)

`stack reset` = `reset_data` transcription: truncate the `resettable && resetMode==='truncate'` core postgres DBs (`iam_local, iam_pii_local, programs, scheduling, sessions, content, sis_db, ads_adm_local`), preserving `_prisma_migrations`, run as `postgres_admin`; **`ledger_local` is reset in the same pass but via `resetMode:'migrate-reset'` (drop + remigrate, not `TRUNCATE`) — decision 2026-06-29;** `dropDatabase` connectv3; **always re-seed the dev user** unless `--no-reseed-dev-user`. `--with-playback` also truncates the playback trio (and warns it does not reseed them — chain `seed --add playback`). Container names overridable via `SAGA_MESH_POSTGRES_CONTAINER` / new `SAGA_MESH_MONGO_CONTAINER`.

**Three identities pinned (review minor):** auth bootstrap user `dev@example.org` `DEV_USER_UUID=f0000004-…beef` (the `iam-dev-user` step); the `db:seed` deterministic `userId('dev')=1e2ca0d8-8f6a-5a97-a141-b38d472a1186` (what `verify` asserts); and `DEFAULT_LOGIN_USER=dev@saga.org` (rostered admin, what `login` opens). Docs and the `iam-dev-user` step / verify determinism check must reference the correct one of the three.

### 4.3 Snapshot fast-path (rebuilt 6 → 9 DBs + mongo)

Port `mesh-fixture-cli/src/lib/{postgres.ts, snapshot-store.ts}` wholesale; extend the DB set 6 → **9 pg + connectv3 mongo**. `store`: `pg_dump -F c` per DB + `mongodump --archive` for connectv3; capture per-DB `schemaRev` from `_prisma_migrations` head. `restore`: profile guard (refuse cross-profile unless `--force`), **snapshot-ahead guard** per pg DB (refuse with "run `stack up --pull`" if `schemaRev` not in the local migrations dir; skip for `iam_pii_local` which is `db push`), `pg_restore --clean --if-exists` streamed via stdin, `mongorestore --archive --drop`, `redisFlushdb`. Returns the **set of fully-restored services** → feeds `composeSeedPlan(restored)`. `validate` is **rebuilt offline-structural** (dump exists, `sizeBytes>0`, manifest parses, optional `pg_restore --list` under `--deep`) — the HTTP/tRPC registry validate is **not** ported. Exit-code-as-gate preserved. Prod-mirror **invokes** the standalone `@saga-ed/iam-seed` / `@saga-ed/pgm-seed` bins (spawn, relay exit code, build-hint on missing bin); the `recordCommand` registry write is dropped.

### 4.4 Explicitly NOT ported from mesh-fixture-cli

The `iam:`/`pgm:`/`ads:` HTTP create topics; `lib/registry.ts` + `lib/http.ts` + `TrpcCallError`; the service-URL flags + `clientFor`; the HTTP-based `snapshot:validate`. `snapshot:show` is subsumed by `list --output-json`; `snapshot:delete` is a low-priority keeper (trivial `rm -rf`).

---

## 5. Flows & per-SPA externalization

### 5.1 One `flows.json` schema (review major — converged)

The two incompatible flow schemas are reconciled onto the **richer `flows-spa` shape**: `{ schemaVersion: 1, spa: SpaDescriptor, flows: FlowDef[] }`. The field is `schemaVersion` (not `version`); flows are an **array** (not a map); `SpaDescriptor` (not a bare `repoVar`) carries `{ id, system, repoEnvVar, defaultRepoSubpath, appDir, e2eDir, playwrightConfig }`. `FlowDef` carries `{ name, description, lanes, progressive, stages[], prerequisite?, foreground?, av?, seed? (SeedSelection), env? }`; `StageDef` carries `{ id, phase?, project, spec, requiredSystems[], seed?, tags? }`. The type is published as `@saga-ed/saga-stack-cli/flow-schema` and as a JSON Schema for editor validation; the CLI validates `flows.json` against it with **zod at load** (the one place JSON+zod is used — the manifest itself stays TS).

### 5.2 The two existing flows encoded

`saga-dash/apps/web/dash/e2e/flows.json` ships two flows:

- **`journey`** — progressive, foreground, `seed:{reset:true, profile:'roster'}`, 8 stages: `roster` (`requiredSystems:[sis-api, programs-api]` — closure can't otherwise infer sis, now also on the dash graph) → `program` / `enrollment` / `pods` (`[programs-api]`) → `schedule` (`[scheduling-api, programs-api]`) → `sessions` (`[sessions-api]`) → `attendance` / `attendance-personas` (`[ads-adm-api, sessions-api, iam-api]`).
- **`connect-session`** — non-progressive, foreground, `av:true`, `prerequisite:{flow:'journey', throughStage:'schedule'}`, one `interactive-connect` stage tagged `@interactive` with `requiredSystems:[connect-web, connect-api, rtsm-api, sessions-api]` (closure pulls **content-api** too — §2.3 fix).

Effective closure = union of selected stages' `requiredSystems` ∪ `{spa.system, iam-api, mesh}`, fed to `computeClosure`. "Through phase 4 (pods)" → `iam, sis, programs, saga-dash, mesh`. `content-api` is in **no** journey stage → never launched for the journey (a real N-of-M saving).

### 5.3 Discovery + new-SPA onboarding

`spa-registry.json` (built into the CLI) lists known SPAs; resolution mirrors `up.sh`'s repo-path env vars: `repoRoot = $<repoEnvVar> ?? join($DEV, defaultRepoSubpath)`, then `join(repoRoot, e2eRelDir, 'flows.json')`. Extra ad-hoc paths via `$SAGA_E2E_SPA_PATHS` and `--spa-path`. A repo whose env var is unset and default path is absent is silently skipped. Onboarding connectv3 = **one registry row** + author `flows.json` + specs; **zero CLI code, zero orchestration code in the SPA repo**.

### 5.4 Runner

`e2e run <spa>/<flow>`: resolve flow → (recurse prerequisite, `--headless`, mark `SKIP_RESET`) → `computeClosure` → `StackApi.up({only})` → `reset` + `seed` (unless `SKIP_RESET`) → `verify({tolerate:[spa.system]})` → `computeEnv` → spawn `pnpm exec playwright test --config=<spa.playwrightConfig> --project <terminal stage> [--grep-invert @interactive] [--headed]` in `appDir`. The CLI never parses the SPA's Playwright config — only passes `--config`, `--project`, env.

### 5.5 Centralized Monday-flake fix

Diagnosis: only the interactive spec clamps (`todayOrNextWeekday`); the four journey date-specs use unclamped `mondayOfCurrentWeek()` → on Sat/Sun the target Monday is in the past → empty sessions → flake. **Two layers:** (1) **CLI is authoritative** — `core/flow/env.ts::computeEnv()` computes the clamped date once and injects `PLAYWRIGHT_OCCURRENCE_DATE` / `PLAYWRIGHT_TERM_START` for every flow/SPA; (2) **shared kit** — publish `todayOrNextWeekday`/`mondayOfWeekOf`/`fmtLocal`/`occurrenceDate` from `@saga-ed/saga-stack-e2e-kit`; specs become env-first (`process.env.PLAYWRIGHT_OCCURRENCE_DATE ?? occurrenceDate()`), deleting the per-spec copies. The flake cannot regress per-spec.

---

## 6. Package & testing

### 6.1 Layout & config

`package.json`: `@saga-ed/saga-stack-cli`, `bin: { saga-stack }`, `exports: { "./core", "./stack-api" }`, oclif `topicSeparator: " "`, pattern strategy `./dist/commands`. Deps `@oclif/core ^4`, `@oclif/plugin-help ^6`, `zod 3.25.67`. DevDeps add `vitest`, `tsx`. Dropped `uuid` (no HTTP id-minting). `tsconfig.json` extends `@saga-ed/soa-typescript-config/base.json`, excludes tests from the lib build. **Tests co-locate under `src/**/__tests__/*.unit.test.ts`** (the redis-core/soa convention) so turbo's `test` input globs (`src/**`) cache them with zero `turbo.json` edits. `pnpm-workspace.yaml` already globs `packages/node/*` — no edit. Three invocation modes: built+global-link, `bin/dev.js` (tsx, no build), `pnpm --filter … saga-stack -- …`.

### 6.2 Pure / side-effecting boundary

`test-workspace.sh` already `sed`-extracts six `up.sh` functions and runs them with stub `err/warn/say` + fake repo paths — it **proves** these are pure. We formalize that seam: `wantService`, `parseWorkspace` (+ guards), `laneEnv`/`sandboxEnv`, `restoreDbsForService`, `restoreSourceFor`, `restoredDb` (the iam two-DB both-must-restore rule) all become pure `core` functions. New pure functions: `computeClosure`, `launchOrder` (Kahn waves), `composeSeedPlan`, `resolveFlow`, `healthProbes`. Everything that touches the world (`make -C $SOA/infra up`, `nohup pnpm dev` + pid files, curl health poll, `git fetch/checkout/merge`, `pg_dump`/`pg_restore`, `playwright test`, the `check_ports` preflight) lives in `runtime/`.

### 6.3 Cross-repo in-process contract (e2e → stack)

Per the locked one-package decision, `e2e` calls `stack` **in-process** via `src/stack-api.ts` — no subprocess, no second oclif invocation. **One** `seed()` signature (review major):

```ts
export interface StackApi {
  up(closure: ServiceId[], opts: UpOpts): Promise<UpResult>;
  reset(closure: ServiceId[]): Promise<void>;
  seed(plan: SeedPlan): Promise<SeedResult>;        // ← single canonical SeedPlan
  verify(probes: Probe[], opts?: { tolerate?: RepoKey[] }): Promise<VerifyResult>;
  down(closure: ServiceId[]): Promise<void>;
  login(user?: string): Promise<LoginResult>;
}
export function makeStackApi(m: Manifest, runtime: Runtime): StackApi;
```

Both `stack` commands and `e2e run` are thin wrappers over this same facade. Planning (closure, seed-plan, lane env) is pure `core`; execution is `runtime`. `--dry-run` stops after planning and `emit()`s the `ResolvedFlow` — the cheap smoke + human-readable proof.

### 6.4 Vitest plan

- **Unit (pure core)** — 1:1 port of `test-workspace.sh`: `want-service`, `workspace` (+ guards), `lane` (originate-map vs URL-flip), `restore-map` (iam two-DB rule). Plus new: `closure` (the `{scheduling,sessions}→+iam+programs+mesh` case; **corrected** `saga-dash`→7 services; rejects unknown id), `seed-plan` (partial-stack drop + restored skip; `scheduling-api`→no seed), `flow-resolve`. Hand-built `Manifest` fixtures; no docker/pnpm/network.
- **Integration (commands, runtime mocked)** — `stack-up.int` (closure correct, mesh called once, only the N-of-M `pnpm dev` spawned in topo order, health probed for that subset), `e2e-run.int` (`--dry-run` emits the orchestration sequence).
- **True e2e** — one CI-gated, opt-in smoke that boots a partial stack and runs one Playwright stage; never in default `pnpm test` / turbo.

---

## 7. Migration strategy & milestones

### 7.1 Synthesized Q3 recommendation

All three judge perspectives converge on **incremental-wrap-then-port** as the spine (value-first calls it "hybrid," but agrees the daily-driver is wrapped, not rewritten, and only the two genuinely-new capabilities are built native because bash cannot express them). **A clean rewrite is rejected** — it ports ~600 lines of load-bearing bash before anything works, front-loading the exact divergence risk we want to avoid.

The one genuine disagreement is **ordering**: risk-first and value-first put the **pure manifest/closure core first** (cheap, zero blast radius, de-risks the linchpin); parity-first puts the **wrapped daily-driver first** (fastest adoption). 

**Recommendation: do the pure core first (M0), then the wrap (M1).** Justification: the pure core is a days-scale, zero-IO deliverable that (a) cannot break anything, (b) retires the single biggest unknown — whether the implicit bash topology can be made correct as data — and (c) produces the golden ground-truth the wrap's own parity tests check against. Putting it first costs essentially nothing against parity-first's adoption goal, because the wrap lands immediately after as M1. Where value-first wants the **native partial-stack first** (its M1, deferring the wrap to the end), we **reject that ordering**: the native launch-loop is "the heaviest single piece of work" with the highest divergence risk, and running it before any parity baseline exists means the new path has nothing to validate against. The wrap is cheap, value-neutral, and yields golden tests that protect the later native port — so the wrap precedes the heavy native work.

**Resolved by the user (2026-06-29, §8.1):** keep the parity-protected order — pure core first (M0), wrap next (M1), native partial-stack at M4. The value-first reordering (native partial-stack at ~M3, wrap deferred) was considered and **not** taken.

### 7.2 Milestones

**M0 — Pure core + manifest + closure (the linchpin).** *Crisp deliverables:* scaffold `@saga-ed/saga-stack-cli` (oclif v4, `base-command.ts` + `emit()` ported, vitest, tsconfig, turbo/pnpm-workspace fit); author the TS manifest (`services.ts/mesh.ts/databases.ts/index.ts`) with **all review corrections + user decisions applied** (iam-pii-db `db push` as migrate step 2; `ledger` owner role + `resettable:true, resetMode:'migrate-reset'`; `content` meshProvisioned; `saga-dash.dependsOn` += `sis-api`; `tunnelSlug` per service; single `ServiceId`/`DbId`); `closure.ts` + `launch-order.ts`; the full 1:1 `test-workspace.sh` vitest port + new closure/seed-plan tests (with the **corrected** `saga-dash`→7 and `connect-session`→+content expectations). `stack up --only … --dry-run` prints the computed closure with no docker. *Dependencies:* none. *Risk:* manifest data wrong — caught by the unit port; zero daily-path impact.

**M1 — Wrapped daily-driver (parity spine).** *Crisp deliverables:* `stack up/down/restart/status/verify/seed/reset/login` as thin wrappers that map flags→argv/env and `exec` the unchanged `up.sh`/`verify.sh` (stdio inherited); sibling-repo discovery (`--dev` + per-repo env vars). **Golden tests assert the exact argv/env handed to each script** (the top-named risk across all three panels). Ship to early adopters — behaviorally identical to bash because the same scripts run. *Dependencies:* M0 scaffold. *Risk:* flag/env translation drift — mitigated by golden tests; bash stays directly callable as the escape hatch.

**M2 — Complete the wrap + read-only manifest-derived commands.** Wrap `overlay`/`tunnel`/`bootstrap` and the `e2e run/list/connect` shells (foreground holds preserved); re-implement `stack status`/`stack verify` to derive probes from the **manifest subset** (closing the content-api `:3009` gap), cross-checked against the still-canonical `verify.sh`. Team is fully off direct bash invocation. *Dependencies:* M0 (manifest), M1 (wrap). *Risk:* interactive surfaces (moniker prompt, connect hold, compose-rest exit-2) — spawn with `stdio:inherit`, document as interactive.

**M3 — Native snapshot fast-path (supersede mesh-fixture-cli).** `stack snapshot store/restore/list/validate` rebuilt: port `postgres.ts`/`snapshot-store.ts`, extend 6→9 pg + connectv3 mongo (`assertMongoRunning`, `mongodump`/`mongorestore`), extended manifest (engine/schemaRev/systems/flowId), offline structural validate, profile + snapshot-ahead guards (skip guard for `iam_pii_local`). Retire mesh-fixture-cli. *Dependencies:* M0. *Risk:* restore correctness across 9 DBs + mongo (ownership restore-as the corrected `ledger` role; redis flush) — gate every restore behind offline validate + schema-rev guard with a `db:seed` degrade path. Additive/opt-in; does not touch `up.sh`'s seed/reset.

**M4 — Native partial-stack (payoff #1).** In-process `StackApi` facade with a native `services_up` port: launch only `closure.services` in topo waves with manifest-templated `launch.env`, native health probes, the `check_ports` preflight, and the `sync-dash-local-defaults` prelaunch hook; `composeSeedPlan` with the partial-stack + restored-db gates. `stack up --only scheduling-api,sessions-api` and `--only saga-dash` boot the computed subset for real. **Full-stack `stack up` (no `--only`) still wraps `up.sh`** — only the new N-of-M path runs native, so it has no existing dependents to break, and M1's golden full-stack wrap is the parity baseline. *Dependencies:* M0, M1, M3. *Risk:* faithful transcription of the 140-line env wall (one missing var = misbehaving service); native launch/health divergence — confine to the opt-in path, soak before reliance.

**M5 — e2e topic + flow registry + Monday clamp + per-system seed (payoff #2).** `e2e run <spa>/<flow> [--through phase]` resolving the converged `flows.json` → closure → `StackApi.up/reset/seed/verify` → playwright, via the in-process facade. saga-dash `flows.json` authored (journey + connect-session). Centralized weekday-clamp via `computeEnv` + published `@saga-ed/saga-stack-e2e-kit` (pull the cheap CLI-side clamp injection **forward** so weekend demos don't flake). Per-system seed selection. Ship headless journey first; defer `e2e connect`/AV/inspect foreground polish. *Dependencies:* M4. *Risk:* in-process contract + foreground/AV scope creep — bound by shipping headless journey first.

**M6 — Per-SPA externalization, port internals, retire bash (last).** Flow discovery across SPA repos; onboard **connectv3** (registry row + `flows.json`, zero CLI code) as the proof of "other SPAs"; then port the remaining `up.sh` internals behind the M1/M2 wrappers piece by piece (`mesh_up`→data-driven readiness, migrate, `reset_data`, seed family→SeedStep runner), **flipping each wrapper from shell-out to native only after it has soaked in daily use**, and finally deprecate/remove the `.sh` scripts (never deleting from git history). *Dependencies:* M5. *Risk:* premature retirement reintroduces clean-rewrite risk — mitigated by dual-path-with-bash-fallback and post-soak default flips. Concentrated deliberately last.

### 7.3 Standing cross-milestone risks

- **Manifest fidelity is the single point of failure** — resolve every remaining open question (§8) against `profile-empty.sql` and per-app config **before M4 relies on the closure**; the M0 unit port is the gate.
- **"Stuck at wrap"** — the wrapped CLI being "good enough" could starve the native port. Mitigation: schedule M4/M5 as the explicit unlock for the partial-stack feature people are asking for, and **freeze bash feature work after M2**.
- **Wrap flag/parity drift** — golden argv/env tests per flag combo (esp. `--only` comma-list vs bash single-service, `--with-qtf-demo`-without-seed no-op-warn).
- **Double-maintenance window (M6)** — `up.sh` stays live while ported; pin behavior with M0/M2 manifest parity tests, land each port fast.

---

## 8. Decisions (resolved 2026-06-29) & remaining build-time confirmations

> Items 1–4 and 7 were decided by the user on 2026-06-29; 5–6 remain build-time TODOs owned elsewhere.

1. **Sequencing emphasis (the panel's core disagreement).** **RESOLVED — KEEP the parity-protected order:** M0 pure core → M1 wrap → M2 finish wrap → M3 native snapshot → **M4 native partial-stack** → M5 e2e flows → M6 externalize + retire bash. The "build native partial-stack earlier / defer the wrap" reorder is *not* taken.

2. **`ledger_local` reset semantics.** **RESOLVED — RESET, not TRUNCATE:** `ledger_local` IS cleared by `stack reset` (`resettable:true`) but via `resetMode:'migrate-reset'` (drop + remigrate, e.g. `prisma migrate reset`), never blanket `TRUNCATE`. Reflected in the DatabaseDef schema (§2.2), the DB table (§2.2), and the reset transcription (§4.2).

3. **Per-service redis edges.** **RESOLVED — leave redis off per-service** in the manifest `mesh[]` for v1 (the mesh starts as a unit, so this is non-blocking). Revisit only if/when we start *only* a closure's mesh subset.

4. **`stack verify` repo-path resolution.** **RESOLVED — plan default:** `stack verify` **honors per-repo override env vars** (resolves via manifest `repoVar`), a deliberate improvement over `verify.sh`'s hardcoded `$DEV/<repo>` so worktree/clean-checkout overrides posture-check the right tree.

5. **`flows.json` schema version pin & publication.** Converged on `schemaVersion:1` + `SpaDescriptor` + `FlowDef[]`. **TODO (build-time):** pick/confirm the real JSON-Schema host URL before any SPA authors a `flows.json` (the `https://saga.internal/…` URL is a placeholder).

6. **Prod-mirror `pgm-seed` bin.** The `@saga-ed/iam-seed` pattern is confirmed. **TODO (build-time, program-hub owner):** confirm `@saga-ed/pgm-seed` exists and its exact flag surface (`--fixture-id`/`--source prod-mirror`/`--limit`) so the wrapper mirrors it.

7. **`stack down --mesh` and other net-new flags.** **RESOLVED — CONFIRMED as additions** (`stack down --mesh`, `bootstrap --yes`, `verify --tolerate`, `--only` closure, per-system seed). Defaults still match bash (mesh persists; reset clears as in §4.2).

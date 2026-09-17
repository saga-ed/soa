<!-- Definitive M7 plan — synthesized by the m7-multi-instance-design ultracode (wf_b992c55a-e3b), grounded in current code. Supersedes the prior draft. -->

# M7 — Multi-Instance ("slots") for saga-stack-cli — Definitive Implementation Plan

**Status:** supersedes `plans/04-m7-multi-instance.md`. Grounded in current code (coach/bundles/skip-guard landed). Architecture A (a separate mesh per slot). Slot 0 is byte-identical to today and up.sh-compatible.

**Verified against source** (`/home/skelly/dev/soa/packages/node/saga-stack-cli` + `/home/skelly/dev/soa/infra`): `launch-plan.ts:346-419`, `mesh.ts:107-194`, `up.ts:388-416`, `shared-flags.ts:74-92`, `dash-defaults.ts:100-108`, `probe-plan.ts:57-72`, `preflight.ts:74-91`, `snapshot-store.ts:48-96`, `infra/Makefile:29,49,112,186-188`, and the four `services/*/compose.yml` volume blocks.

---

## 1. Chosen slot model

**Decision: deterministic port-offset (`offset = slot * 1000`) + project-suffixed namespace (`soa-s<slot>`), derived by one pure factory `deriveInstance({ slot })`. Numeric slots for MVP; a name→slot registry is a deferred enhancement, not MVP.**

### Why this synthesis (and not the pure-registry `namespace` proposal)

- **Determinism beats registry for the parallel-dev hot path.** The `namespace` proposal's `allocateSlot` (flock'd `slots.json` + live PortProbe + prune) solves *arbitrary string names* and *foreign-squatter detection* — real problems, but not M7's problem. Two agents running `--slot 1` / `--slot 2` need reproducible, stateless port math they can reason about, not a persisted allocator with a corruption/staleness failure mode. The registry is **strictly additive later**: it can wrap `deriveInstance` (name → stable numeric slot) without changing any downstream seam.
- **But adopt the registry's two best ideas as pure, stateless checks:** (a) **derive generically over every manifest service + mesh unit + token — never a curated port table** (this is why coach/recorder/recordings/connect-web slot for free; the prior plan's hand-maintained table is already stale). (b) **`deriveInstance` asserts full-set port disjointness** (all services + mesh + mgmt + recorder/recordings) before returning — the `validate-then-commit` idea, minus the persistence.
- **Stride 1000, not 100.** Verified collisions at +100: `rtsm-api 6110→6210` == `connect-web` base 6210; `coach-web 8800→8900` == `saga-dash` base 8900. I checked all base ports (3006–3010, 3100, 5005, 5432, 5672, 6105, 6106, 6110, 6210, 6301-6303, 6379, 7890, 8444, 8800, 8900, 15672, 27037): **no two are a multiple of 1000 apart**, so stride 1000 is cross-slot collision-free for any slot count by construction. The disjointness assertion stays anyway as a guard for future services and recorder/recordings.

### Exact slot keying (the contract `deriveInstance` returns)

`deriveInstance({ slot }) → InstanceProfile`. Slot 0 returns today's constants **verbatim** (the regression guard):

| Key | Slot 0 (byte-identical to today) | Slot N (N ≥ 1) | Mechanism / seam |
|---|---|---|---|
| `offset` | `0` | `N * 1000` | applied to every service + mesh port |
| `project` (COMPOSE_PROJECT_NAME) | `soa` | `soa-s<N>` | env into `make up`/`down` — **requires Makefile `?=`** |
| `stateDir` | `/tmp/sds-synthetic` | `/tmp/sds-synthetic-s<N>` | default for `--state-dir` → `getLauncher` |
| `snapshotsDir` | *(unset → `~/.saga-mesh/snapshots`)* | `~/.saga-mesh/snapshots-s<N>` | `SAGA_MESH_SNAPSHOTS_DIR` env |
| `containerEnv` | *(none)* | `SAGA_MESH_{POSTGRES,REDIS,RABBITMQ,MONGO}_CONTAINER = soa-s<N>-<unit>-1` | existing override seam |
| `seedProfile` | `empty` | `empty` (**unchanged — load-bearing**) | `PROFILE=empty` stays |
| volumes | `postgres-profile-empty`, `redis-data`, … (today) | `soa-s<N>_postgres-data`, `soa-s<N>_redis-data`, … | **compose `name:` dropped** → project-prefixed |
| DB names | unchanged | unchanged (Arch A) | no manifest DB rename |
| dash config | `config.local.json` removed (today) | `config.local.json` **written** with offset localhost ports | new stack-lane write branch |

**The mesh.** `PROJECT=saga-mesh` (the compose *file* selector) stays constant across slots — it is not the docker namespace. What varies per slot is `COMPOSE_PROJECT_NAME=soa-s<N>` (the namespace) + the five offset mesh ports + the four `SAGA_MESH_*_CONTAINER` overrides.

**Full port table** (base → slot 1 at stride 1000). `saga-dash` is `8900+offset` like everything else — the prior plan's `8900+slot` special case **dissolves** under a uniform offset.

| unit | base | slot 1 | | unit | base | slot 1 |
|---|---|---|---|---|---|---|
| iam-api | 3010 | 4010 | | connect-api | 6106 | 7106 |
| sis-api | 3100 | 4100 | | connect-web | 6210 | 7210 |
| programs-api | 3006 | 4006 | | rtsm-api | 6110 | 7110 |
| scheduling-api | 3008 | 4008 | | coach-api | 6105 | 7105 |
| sessions-api | 3007 | 4007 | | coach-web | 8800 | 9800 |
| content-api | 3009 | 4009 | | transcripts-api | 6302 | 7302 |
| ads-adm-api | 5005 | 6005 *(excluded slot>0, see §6)* | | insights-api | 6301 | 7301 |
| saga-dash | 8900 | 9900 | | chat-api | 6303 | 7303 |
| recorder(ctrl) | 7890 | 8890 *(AV, deferred)* | | recordings-api | 8444 | 9444 *(AV, deferred)* |
| **mesh** postgres | 5432 | 6432 | | redis | 6379 | 7379 |
| rabbitmq | 5672 | 6672 | | rabbitmq-mgmt | 15672 | 16672 |
| connect-mongo | 27037 | 28037 | | | | |

**Mesh, snapshot dir, tunnel monikers:** mesh keyed by `soa-s<N>` project + offset ports; snapshot dir per-slot `~/.saga-mesh/snapshots-s<N>` (independent of `--state-dir`, so it must be set explicitly, else slot-1 `snapshot store fixtureX` overwrites slot-0's and restores into whichever container the env last pointed at); **tunnel monikers are out of scope for M7** — the tunnel lane keys isolation by domain/cookie, not port, so the offset model buys nothing there. Slot>0 is **stack-lane only**.

---

## 2. The single CLI seam

**One flag + one pure factory + one injection site. No call site ever hardcodes a port again.**

- **Flag:** add `slot` to `baseFlags` (`shared-flags.ts:74-92`), `Flags.integer({ default: 0, min: 0 })`. (`--instance <name>` is deferred; when it lands it resolves a name→slot via the registry and feeds the same factory.)
- **Pure factory (NEW):** `deriveInstance({ slot }): InstanceProfile` in `core/` next to `launch-plan.ts`. No IO. Returns `{ offset, project, stateDir, snapshotsDir, containerEnv, seedProfile, portOverrides, meshOffset }`. Computes `portOverrides` generically: `for (id of Object.keys(m.services)) portOverrides[id] = getService(id).port + offset`. Runs the **disjointness assertion** over the fully-resolved service+mesh+mgmt+recorder/recordings set and throws on any collision. `deriveInstance({slot:0})` must return today's constants exactly — this is the unit-tested regression guard.
- **Injection site (the ONLY one):** `StackUp.buildRuntime` (`commands/stack/up.ts:388-416`), where `defaultLaunchContext` + `getLauncher(state-dir)` + the mesh seams already converge. Wire the profile into the five existing seams:
  1. `defaultLaunchContext({ …, portOverrides: profile.portOverrides, meshOffset: profile.offset })` — **`LaunchContextInputs` gains a NEW `meshOffset` field** (`launch-plan.ts:304-326`), applied to `pgPort/mqPort/mongoPort` at `:353-355` so `MESH_MQ`/`CONNECT_MONGO_URI`/`*_DB_URL` (`:387-394`) offset in lockstep with the mesh's published ports.
  2. Mesh: **`MeshContext` gains `project` + `meshOffset` + `containerNames`** (`mesh.ts:57-77`). `meshMakeArgs(m, { project, offset })` (`mesh.ts:107-123`) emits `COMPOSE_PROJECT_NAME=<project>` + offset `POSTGRES_PORT/REDIS_PORT/…`. `meshUp` (`mesh.ts:169-194`) passes `COMPOSE_PROJECT_NAME` via `env:`. `meshDownArgs({ project })` (`mesh.ts:147-149`) passes the per-slot project — **critical**, else `make down` tears down the wrong (default) project.
  3. Container resolvers: set `profile.containerEnv` so `meshContainer` (`mesh.ts:99-102`) and `postgres/mongo/redisContainer` (`snapshot-store.ts:57-69`) + `meshOwnedContainers` (`preflight.ts:86-88`) all target `soa-s<N>-<unit>-1`. (Cleaner long-term: thread a resolved container map through `MeshContext`; for MVP the env seam is sufficient and already wired.)
  4. `getLauncher(flags['state-dir'] ?? profile.stateDir)` — default `--state-dir` from the slot when the user didn't pass one.
  5. `healthProbes` (`probe-plan.ts:57-72`) must take the resolved `ctx.ports`/offset instead of `svc.lane.stack` — else `stack status`/`stack verify` probe base ports and report the wrong instance.
- **Also thread the offset into `meshPortSpecs`** (`preflight.ts:74-83`) so the check_ports preflight probes the slot's ports, not base.
- **Dash:** extend `syncDashLocalDefaults` (`dash-defaults.ts:100-108`) with a **third mode**: stack-lane + slot>0 ⇒ WRITE `config.local.json` with the slot's offset localhost ports (today it only removes-in-stack / writes-domain-in-tunnel).

Files to change: `shared-flags.ts`, `core/deriveInstance.ts` (new), `core/launch-plan.ts`, `runtime/mesh.ts`, `runtime/preflight.ts`, `runtime/snapshot-store.ts` (env-driven, mostly no change), `core/probe-plan.ts`, `runtime/dash-defaults.ts`, `commands/stack/up.ts`, `commands/stack/down.ts`, `stack-api.ts` (thread profile into `meshUp`/`meshDown`/`down`).

---

## 3. The infra prerequisite (shared with M8) — hard gate

Two changes in `~/dev/soa/infra`. **Nothing multi-instance is correct until both land.**

**(a) Project-name override.** `infra/Makefile:29`:
```make
export COMPOSE_PROJECT_NAME := soa      →      export COMPOSE_PROJECT_NAME ?= soa
```
A `:=` assignment beats an environment value (but not a `make VAR=` CLI arg). The CLI passes overrides via child `env:` (as it does `EXTRA_POSTGRES_SEED_DIR`, `mesh.ts:192`), so `?=` is **required** for env passthrough. Still defaults to `soa` at slot 0 → backward compatible. `check-ports` self-skip (`:49`) and status filter (`:112`, `name=soa-`) follow `COMPOSE_PROJECT_NAME` automatically — though note `:112` filters `name=soa-` which still *matches* `soa-s1-*` as a prefix (harmless; status may show sibling slots — acceptable, optionally tighten later).

**(b) Project-key the four data volumes** — the load-bearing isolation fix (bigger than the plan's one-liner). Drop the explicit global `name:` so compose prefixes each with the project:

- `services/postgres/compose.yml:47` — remove `name: postgres-profile-${SEED_PROFILE:-small}` → becomes `<project>_postgres-data`.
- `services/redis/compose.yml:23` — remove `name: redis-data`.
- `services/rabbitmq/compose.yml:27` — remove `name: rabbitmq-data`.
- `services/connect-mongo/compose.yml:41` — remove `name: connect-mongo-data`.

`SEED_PROFILE` **stays `empty`** — it double-duties as the seed-*file* selector (`init-and-seed.sh:18` resolves `profile-${SEED_PROFILE}.sql`, and only `profile-empty.sql` exists; `s1` would provision zero DBs). Isolation comes from the project prefix, not the profile.

**Follow-on the coupling map missed:** `Makefile:186-188` (`clean-all`) removes `redis-data`/`rabbitmq-data`/`postgres-profile-$(PROFILE)` by their *old fixed names*. Once the names are project-prefixed, `clean-all` must remove `$(COMPOSE_PROJECT_NAME)_redis-data` etc. (or `docker compose down -v`). Include this in the infra PR or `clean-all` silently no-ops and leaks volumes.

Backward-compat note: dropping the postgres `name:` **renames** the slot-0 volume from `postgres-profile-empty` to `soa_postgres-data`, so the first post-change `up` re-seeds from empty. That's fine for the empty-profile mesh (seeded on boot), but call it out in the PR.

---

## 4. Phasing (smallest shippable, low→high risk)

Each phase is independently testable and leaves the tree shippable.

**Phase 0 — infra PR (blocking, shared with M8).** §3 (a)+(b) + `clean-all` fix. Testable in isolation: `make up COMPOSE_PROJECT_NAME=soa-s1 POSTGRES_PORT=6432 …` brings up `soa-s1-*` containers on offset ports with `soa-s1_*` volumes, concurrent with a running `soa` stack, no volume sharing (`docker volume ls`). **No CLI change ships until this merges.**

**Phase 1 — pure factory + flag, slot 0 only (zero behavior change).** Add `--slot` (default 0), `deriveInstance`, the disjointness assertion, and the `meshOffset` input to `defaultLaunchContext`. Wire into `buildRuntime` but only exercise slot 0. Ship behind the guarantee that `deriveInstance(0)` === today. Fully unit-testable; live behavior unchanged. This is the regression-guard checkpoint.

**Phase 2 — MVP: two stacks, native `up`, slot>0 (stack/CRDT lane).** Thread project + mesh offset + container env through `meshUp`/`meshMakeArgs`; offset service+mesh ports; per-slot state dir + snapshots dir; dash config write branch; `probe-plan`/`meshPortSpecs` use resolved ports. **Exclude** ads-adm-api + playback trio (literal ports, §6) and AV/record from the slot>0 closure. **This is the MVP:** `stack up --slot 1` + a live `soa` stack, both healthy, no clobber.

**Phase 3 — native slot-safe `down`.** `stack down` currently delegates to `up.sh --down` (`down.ts` → `runScript(flagMap.down())`), which runs host-global `pkill -f tsup` + `nuke_vite`. For slot>0, route `down` through the **native** `stopServices` (kill-by-pidfile in the slot's state dir, already isolation-safe) + native `meshDown({ project })`. Without this, `stack down --slot 1` kills slot 0's watchers. Slot 0 keeps the up.sh wrapper.

**Deferred (post-M7, documented as slot-0-only until done):**
- `reset`/`restart`/`overlay`/`bootstrap`/`seed` — still up.sh wrappers with host-global teardown. **Slot-0-only** until native-ized. Gate this in the command layer (reject `--slot>0` with a clear error, not a silent global kill).
- Literal-port tokenization (ads-adm-api, playback trio, connect-web AV) → unlocks those services for slot>0.
- AV/record per-slot (qboard/fleek composes need their own project-keying + offset).
- Tunnel-per-slot (per-slot moniker).
- `stack new-instance <key>` worktree helper + name→slot registry.

---

## 5. Test strategy

**Unit (pure, fast, the bulk of confidence):**
- `deriveInstance(0)` deep-equals today's constants (project `soa`, offset 0, state `/tmp/sds-synthetic`, no container env, seed `empty`, no dash write) — the byte-compat guard.
- `deriveInstance(N)` for N∈{1,2,3}: correct offset, project `soa-s<N>`, state/snapshot dirs, container env map.
- **No-collision property test:** for N slots (say 0..8), assert the union of all resolved ports (every service + mesh + mgmt + recorder/recordings) has no duplicates — catches any future service whose base is a multiple of the stride from another.
- `meshMakeArgs`/`meshDownArgs` emit `COMPOSE_PROJECT_NAME=soa-s<N>` + offset ports (assert argv, no real make).
- `defaultLaunchContext` with `meshOffset`: `MESH_MQ`/`CONNECT_MONGO_URI`/`*_DB_URL` ports match the offset mesh ports (the split-brain guard).
- `healthProbes` builds URLs off resolved ports, not `lane.stack`.
- `syncDashLocalDefaults` stack-lane+slot>0 writes `config.local.json` with offset ports; slot 0 still removes.

**Live validation (cannot be unit-tested — the whole point of M7):**
1. `stack up` (slot 0, up.sh-style) running; then `stack up --slot 1` concurrently.
2. `stack verify --slot 0` and `--slot 1` both green.
3. `docker ps` shows disjoint `soa-*` and `soa-s1-*` container sets; `docker volume ls` shows disjoint `soa_*` / `soa-s1_*` volumes (no shared `redis-data`/`rabbitmq-data`/`connect-mongo-data`).
4. **Clobber test:** write a row to slot 1's postgres + a key to slot 1's redis; confirm slot 0 does NOT see them (the silent-corruption regression).
5. Dash: slot 1's dash (`:9900`) resolves iam at `:4010`, not `:3010` (config.local.json assertion — the crosstalk trap).
6. `stack down --slot 1` (Phase 3): slot 0's tsup watchers and vite caches survive (`pgrep`/cache mtime before/after).

---

## 6. Risks + up.sh coexistence

**Collision / leak matrix (slot N vs live up.sh `soa` stack):**

| Surface | Safe? | Why / condition |
|---|---|---|
| Host ports | ✅ | offset (stride 1000, disjointness-asserted); up.sh's fixed-port `fuser -k` can't reach offset ports |
| Container names | ✅ | distinct project `soa-s<N>`; `make down COMPOSE_PROJECT_NAME=soa-s<N>` only tears down that slot |
| STATE (pid/log) | ✅ | distinct dir; native kill-by-pidfile can't cross-kill |
| **Data volumes** | ⛔→✅ | **BLOCKED until §3(b) lands** — redis/rabbitmq/connect-mongo bare global names + postgres profile-keyed-on-`empty` are silently shared (corruption, not crash). Project-prefix fixes it. |
| Mesh DB URLs | ⚠️ | split-brain if `meshOffset` reaches `meshMakeArgs` but not `defaultLaunchContext` (or vice-versa) — single offset feeds both; unit-guarded |
| Literal-port services | ⚠️ | ads-adm-api (`@localhost:5432`, sessions `:3007`, iam `:3010`, CORS `:8900`), playback trio (`POSTGRES_PORT '5432'`, `EXPRESS_SERVER_PORT 6301-6303`), connect-web (`livekit ws://:7880`, sessions `:3007`) bypass all token offsets → hit slot 0. **Excluded from slot>0 closure** until tokenized |
| Dash config | ⚠️→✅ | stack-lane REMOVES config today → slot dash hits base-port iam. New write branch fixes |
| Wrapper lifecycle (reset/restart/…) | ⛔ | host-global `pkill tsup` + `nuke_vite` (up.sh:2001/2012) clobbers all slots. **Slot-0-only** until native-ized |
| Snapshot store | ⚠️→✅ | global root independent of `--state-dir`; must set `SAGA_MESH_SNAPSHOTS_DIR-s<N>` + container env together |
| AV/record | ⛔ | qboard/fleek fixed project + `:7880/:6380/:7890/:8444` — single-owner. Slot>0 CRDT-only |
| Tunnel | ⛔ | keyed by moniker/cookie-domain, not port. Stack-lane only |

**bash + slotted CLI coexistence:** a live up.sh `soa` stack **is** slot 0 (byte-identical). A CLI `--slot 1` stack is a peer project — safe on ports/names/state, safe on volumes *after* §3(b), and it must never run a wrapper lifecycle command (`reset`/etc.) at slot>0 until those go native. The `?=` fix keeps `soa` as the default so up.sh's `make up` is unaffected.

**Skip-guard hazard:** worktrees are **mandatory** for slot>0 (in-tree `pnpm dev` + tracked `config.json`/`.env.local` can't hold two branches). The repo-absent skip-guard (`stack-api.ts:349-365`) silently masks a mis-provisioned worktree as "repo not cloned" → a quietly partial slot. Either the future `stack new-instance` guarantees every managed worktree exists, or the guard needs a slot-aware "expected-but-missing = error" distinction. Flag for the deferred worktree-helper phase.

---

## 7. Open decisions for skelly

1. **Stride size.** Recommend **1000** (verified collision-free for all base ports; +100 has real rtsm↔connect-web and coach-web↔saga-dash collisions). Alternative: validated disjoint bands. Any objection to 1000, or do you want headroom for a service base that could push a high slot's mongo (27037 + N·1000) toward the ephemeral range? (Practically fine for N ≤ ~30.)
2. **Max slots.** Cap `--slot` at some N (e.g. 8) so the disjointness assertion and docker footprint stay bounded? Or leave uncapped with only the assertion guarding?
3. **Numeric vs named slots for the shipped surface.** MVP is numeric (`--slot 1`). Do you want `--instance <name>` (name→stable slot) in M7, or is the registry genuinely deferrable? (My recommendation: defer — numeric covers the two-agent case and keeps M7 stateless.)
4. **`ads-adm-api` + playback trio at slot>0.** Confirm it's acceptable to **exclude** them from slot>0 for M7 (they'd corrupt slot 0 otherwise) and tokenize as a fast follow — vs. blocking M7 on tokenizing them now.
5. **Wrapper lifecycle at slot>0.** Confirm `reset`/`restart`/`overlay`/`bootstrap`/`seed` should **hard-error** at slot>0 in M7 (rather than silently clobber), accepting they're slot-0-only until native-ized.
6. **Snapshot library:** per-slot snapshot root (isolated, chosen here) vs. a shared library with slot-tagged fixture ids? Per-slot is safer; shared is more convenient for promoting a fixture across slots. Which do you want as the default?

---

**Net:** one flag + one pure `deriveInstance` factory + threading in ~8 files, plus a ~two-lines-per-volume + one-line-Makefile infra PR (Phase 0, shared with M8), yields two isolated CRDT stacks running concurrently (Phase 2 MVP). Native slot-safe `down` is Phase 3. Everything cut (tunnel, AV/record, literal-port services, wrapper lifecycle, name registry, worktree helper) is documented as slot-0-only or excluded-from-closure — **never silently broken**. Slot 0 is the byte-identical, up.sh-compatible regression guard throughout.

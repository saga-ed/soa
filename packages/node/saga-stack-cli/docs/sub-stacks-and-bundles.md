# Sub-stacks & bundles

← [Getting started](./getting-started.md)

You rarely need the whole stack. `ss stack up` boots a **minimal dependency closure** — the
services you name plus exactly what they transitively require — so you can test two services
without paying for fourteen.

## `--only` — the dependency closure (N-of-M)

Name the services you want; `ss` walks the manifest graph and adds their dependencies.

```bash
ss stack up --only scheduling-api,sessions-api --dry-run
```

<details><summary>4 services boot (you asked for 2) — iam + programs are pulled in as deps</summary>

```
dry-run closure for: scheduling-api, sessions-api
services (launch order): iam-api -> programs-api -> scheduling-api -> sessions-api
databases: iam_local, iam_pii_local, programs, scheduling, sessions
mesh: postgres, redis, rabbitmq
reasons:
  iam-api: required by scheduling-api (url); required by sessions-api (url); required by programs-api (url)
  programs-api: required by sessions-api (event)
  scheduling-api: requested; required by sessions-api (event)
```

The `reasons` block shows *why* each service is in the closure — `url` (a hard runtime
dependency) vs `event` (async projection over the mesh). A missing sibling repo is
skipped-with-a-warning, not a hard failure.
</details>

## `--with` — convenience bundles

Common shapes have a one-word alias that expands to a set of `--only` includes. They compose.

```bash
ss stack bundle list
```

<details><summary>dash · connect · coach · playback · qtf — sugar over the closure engine</summary>

```
Convenience bundles (use with `stack up --with <name>`):

  NAME      SERVICES                                 SEED      DESCRIPTION
  ────────────────────────────────────────────────────────────────────────
  dash      saga-dash                                —         saga-dash teacher SPA + its full journey backend (closure).
  connect   connect-api, connect-web                 —         Connect live-session SPA + API (pulls in iam/sessions/content).
  coach     coach-api, coach-web                     —         Coach tutor-PD SPA + API (+ the coach_api DB).
  playback  transcripts-api, insights-api, chat-api  playback  Optional playback/observability APIs + their seed.
  qtf       seed-only                                qtf       Seed-only: QTF observation-notes demo (no extra services).

  Compose them: `stack up --with dash --with playback`. Also honoured by stack status / verify.
```
</details>

```bash
# The teacher SPA + its whole journey backend, plus the playback APIs:
ss stack up --with dash --with playback
```

`--with` is shared across `up` / `status` / `verify` / `seed` / `reset` / `snapshot store`.

## Woot Math adaptive practice

`--with wootmath` selects the independent student app, teacher dashboard, and
AP API. It uses local synthetic identity; IAM, Redis, MongoDB, and other Saga
applications are not dependencies of this bundle.

```bash
ss stack up --with wootmath --wootmath ~/dev/wootmath --dry-run
ss stack up --with wootmath --wootmath ~/dev/wootmath
ss stack status --with wootmath --wootmath ~/dev/wootmath
```

The default checkout is `$DEV/wootmath-adaptive-practice`; `--wootmath` or
`WOOTMATH` overrides it. The checkout needs the AP workspace and staged
curriculum assets. Normal prep installs dependencies and builds that checkout;
use `--skip-prep` only when it is already prepared. Add `--no-auto-pull` to keep
repo revisions pinned during investigation.

| Component | Slot 0 URL/port |
|---|---|
| Student app | http://127.0.0.1:5174/ |
| Teacher dashboard | http://127.0.0.1:5180/ |
| AP API health | http://127.0.0.1:4310/health |
| PostgreSQL / database | localhost:5432 / `ap` |
| RabbitMQ AMQP / management | localhost:5672 / localhost:15672 |

`--slot N` adds `N * 1000` to these ports and uses that slot's PostgreSQL and
RabbitMQ volumes. Origins, frontend proxy targets and sign-in redirects follow
the same slot. For example, slot 6 uses student :11174, teacher :11180, API
:10310, PostgreSQL :11432, RabbitMQ :11672 and management :21672.

Startup provisions the `ap` role/database, runs the application's idempotent
`db:migrate`, and invokes its additive `db:seed` for Brent, Krista, Tom and Jeff
in Woot Math Founders. Synthetic accounts use `<name>@founders.example.test`
and the local fixture password `Founders-local-2026!`; they have student and
teacher memberships. Existing passwords, attempts and progress are preserved
by that seed. `--no-seed` skips it. This bundle does not exercise external
Saga/OIDC login, and `ss stack login` is still the Saga/IAM login helper; use
Woot Math's sign-in screen.

This starts a separate database from the standalone `synthetic:up` launcher;
existing standalone progress is not automatically moved. Choose an unused
slot when both launchers are running. Partial startup adds only the required
infrastructure; it does not stop unrelated containers already running in the
chosen slot. PostgreSQL's existing initializer still runs, and may create
baseline Saga databases on fresh volumes, but no other application services
are launched.

For an explicitly scoped Founders reseed or snapshot:

```bash
ss stack seed --with wootmath --only ap-api --wootmath ~/dev/wootmath
ss stack snapshot store --with wootmath --only ap-api --fixture-id founders --wootmath ~/dev/wootmath
```

### Infrastructure selection

All native partial-stack launches now pass their mesh closure to Compose,
including `postgres_init` when PostgreSQL is selected. Host-port checks cover
only selected units. A service with no mesh dependencies starts no containers.
The shared Makefile retains full-project behavior when `SERVICES` is omitted.

## Seeding

`up` seeds automatically. To (re)seed a **running** stack without a full bring-up:

```bash
ss stack seed                 # default roster
ss stack seed --with playback # + the playback fixtures
```

**Named datasets & scenarios** (multi-seed, #221): `profile` says *how much* to seed;
a **dataset** names *which* fixture a system seeds (`SEED_DATASET=<name>` reaches that
system's `db:seed`). A **scenario** is a named, coupled set of per-system datasets that
must apply together — e.g. `ab-topology` stamps the programs/scheduling/sessions triad.
A scenario that cannot apply coherently (a member inactive, restored, or not selected
by the profile) is an **error**, never a silent partial seed.

```bash
ss stack seed full --scenario ab-topology            # coupled cross-system dataset
ss stack seed full --dataset sessions-api=alt        # one system's named dataset
ss stack seed full --scenario ab-topology --dry-run  # print the stamped plan, seed nothing
```

Flows can carry the same keys in their `flows.json` seed block
(`"seed": { "profile": "full", "scenario": "ab-topology" }`).

<details><summary>Seeds in place — profile + add-ons, offline steps first, then online</summary>

```
  Created 30 users with profiles
  Created 218 roster users (190 students, 28 tutors) with 436 memberships
Seed complete!
seed: OK
```

`reset` truncates the data DBs to an empty baseline (preserving migration history) and
re-seeds the dev user — a from-scratch reset in seconds:

```bash
ss stack reset
```
</details>

## The bare full stack

`ss stack up` with no `--only`/`--with` boots the full non-optional closure natively
(prep → provision → migrate → launch → seed). Add `--record`/`--sandbox`/`--tunnel`/`--workspace`
for the fleet/recording/tunnel/workspace modes.

← [Getting started](./getting-started.md) · [slots →](./slots.md)

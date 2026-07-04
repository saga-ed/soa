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

## Seeding

`up` seeds automatically. To (re)seed a **running** stack without a full bring-up:

```bash
ss stack seed                 # default roster
ss stack seed --with playback # + the playback fixtures
```

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

# Snapshots — save & restore DB state

← [Getting started](./getting-started.md)

Re-seeding from scratch is slow. A **snapshot** captures the DB state (pg_dump + mongodump)
so you can restore a known-good baseline in seconds instead of re-running `db:seed`. This
supersedes the old `mesh-fixture-cli` (now deprecated).

## Store a snapshot

Bring your stack to the state you want, then:

```bash
ss stack snapshot store --fixture-id my-baseline
```

<details><summary>✓ dumps every closure DB (pg) + connectv3 (mongo) into a named fixture</summary>

```
snapshot 'my-baseline' — storing …
  ✓ iam_local        (pg_dump)
  ✓ iam_pii_local    (pg_dump)
  ✓ programs         (pg_dump)
  ✓ scheduling       (pg_dump)
  ✓ sessions         (pg_dump)
  ✓ connectv3        (mongodump)
stored: ~/.saga/snapshots/my-baseline  (schema-tagged)
```

Scope which DBs with `--only`/`--with`. Each dump is tagged with the current schema so a
restore onto drifted migrations is caught, not silently applied.
</details>

## List / restore / validate / delete

```bash
ss stack snapshot list
ss stack snapshot restore my-baseline
ss stack snapshot validate my-baseline
ss stack snapshot delete my-baseline
```

<details><summary>restore = drop-in the saved state, as the DB owner, with a schema-ahead guard</summary>

```
$ ss stack snapshot restore my-baseline
snapshot 'my-baseline' — restoring …
  ✓ schema check: fixture matches current migrations
  ✓ restored iam_local, iam_pii_local, programs, scheduling, sessions (as owner)
  ✓ restored connectv3 (mongo)
restored: my-baseline
```

**Schema-ahead guard:** if the fixture was taken on an *older* schema than your current code,
restore refuses rather than silently loading a stale shape — the one blind spot re-running
`db:seed` doesn't have. Restore-as-owner means row-level ownership/grants survive the round-trip.
</details>

## Known issue: restore races DB-polling services

Restores run `pg_restore --clean --if-exists` **with services left running** — that's the
speed premise, and it applies to e2e `--from` checkpoint restores too. Anything polling the
DB on a tight loop can catch a table mid drop→recreate: program-hub's OutboxRelay polls
~500ms, and a tick landing in that window gets 42P01
(`relation "outbox_event" does not exist`); its fatal-error path throws an unhandled
rejection and the **service process dies**. Observed live 2026-07-09 on programs-api;
intermittent — an immediate retry of the same run restored green 2/2 in seconds.

Recovery is one command — relaunch the dead service:

```bash
ss stack up --only programs-api --skip-prep
```

The coverage guard, by contrast, behaves well: restoring beyond the baked closure fails
fast with a `re-bake with a wider --through` error instead of half-restoring.

## When to use which

- **`snapshot restore`** — you want a *specific captured* state back fast (a fixture, a repro).
- **`reset` + `seed`** — you want a *fresh* deterministic baseline from the seed definitions.
- **`up` (idempotent)** — you just want the stack running; it seeds if empty.
- **e2e stage checkpoints** — mid-flow e2e state (`flow-<spa>-<flow>-s<N>-<stage>` fixtures,
  baked by `e2e run --snapshot-stages`, restored by `--from`); `snapshot list` shows their
  flow provenance as a sub-line. See [e2e → Stage checkpoints](./e2e.md#stage-checkpoints--skip-the-replay-m14).
- **tunnel-mode bridge** — build launchable state under localhost, snapshot, then restore it under
  the tunnel cookie domain (`ss stack snapshot` covers all 10 pg DBs + `connectv3` mongo, so
  sessions survive the bridge; the legacy `mesh-fixture-cli` omitted `sessions`). See
  [tunnel.md → the snapshot bridge](./tunnel.md#seed-launchable-connect-sessions--the-snapshot-bridge).

← [verify](./verify.md) · [e2e →](./e2e.md) · [tunnel →](./tunnel.md)

## Porting legacy mesh-fixture fixtures (e.g. `iam-small`, soa#194)

`mesh-fixture-cli` fixtures are authoring scripts (its `iam:*` verbs) plus a
captured dump. `ss` deliberately does not re-implement the authoring verbs —
the native recipe composes what already exists:

1. Bring up just the scope: `ss stack up --only iam-api --reset`.
2. Seed the canonical registry base (permissions/policies), then author the
   fixture entities — today that is still the legacy script
   (`packages/node/mesh-fixture-cli/fixtures/<name>/create.sh`), which works
   fine against a native `ss` stack.
3. Capture natively: `ss stack snapshot store --fixture-id <name> --only iam-api` — the
   manifest records profile + schema revisions, and the restore guards
   (profile-mismatch, snapshot-ahead) apply.
4. Restore anywhere: `ss stack snapshot restore <name>` (slot-aware).

When per-user roles/personas land (rostering#667), re-author on the same base
and re-store — the snapshot supersedes the script as the distributable
artifact.

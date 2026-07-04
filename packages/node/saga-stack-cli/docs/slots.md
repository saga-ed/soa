# Slots — many stacks on one box

← [Getting started](./getting-started.md)

`--slot N` (1–9) brings up an **isolated** `soa-s<N>` stack next to the default one: ports
offset by `N × 1000`, project-keyed docker volumes, its own state + snapshot dirs. Two
developers — or two parallel agents — run concurrent stacks with zero clobbering. Slot 0
(the default) is byte-identical to the base setup.

## Bring up a second stack

```bash
# terminal A — the default stack (slot 0)
ss stack up --only iam-api,scheduling-api,sessions-api

# terminal B — an isolated second stack (slot 1)
ss stack up --only iam-api,scheduling-api,sessions-api --slot 1
```

<details><summary>Slot 1 boots on offset ports (iam :4010, scheduling :4008+1000…) under project <code>soa-s1</code>, disjoint volumes</summary>

```
# slot 0: iam :3010, sis :3100, scheduling :3008, sessions :3007   (project soa)
# slot 1: iam :4010, sis :4100, scheduling :5008, sessions :5007   (project soa-s1)

soa_postgres-data        soa-s1_postgres-data       ← disjoint volumes
soa-postgres-1           soa-s1-postgres-1          ← disjoint containers
/tmp/sds-synthetic       /tmp/sds-synthetic-s1      ← disjoint state dirs
```

Every offset flows in lockstep — the mesh (postgres/redis/rabbitmq/mongo), each service's
listen port, its DB URLs, and its inter-service URLs — so a slot-1 stack never talks to slot 0's
data. Validated: two concurrent stacks show **zero DB/redis cross-talk**.
</details>

## What's isolated

| | slot 0 | slot 1 |
|---|---|---|
| docker project | `soa` | `soa-s1` |
| ports | base (iam 3010, dash 8900…) | `+1000` (iam 4010…) |
| volumes | `soa_*` | `soa-s1_*` |
| state / pids | `/tmp/sds-synthetic` | `/tmp/sds-synthetic-s1` |
| snapshots | base dir | per-slot dir |

## Tear down just one slot

`down` is slot-safe — it stops exactly the pids *that* slot recorded, never a host-global kill:

```bash
ss stack down --slot 1          # stops only slot 1's services
ss stack down --slot 1 --mesh   # + slot 1's mesh
```

<details><summary>✓ slot 1 stopped; slot 0 untouched</summary>

```
slot 1: stopped 3 service(s) from /tmp/sds-synthetic-s1 (native kill-by-pidfile — no host-global pkill)
stopped: iam-api, scheduling-api, sessions-api
```
</details>

## Notes

- `--slot N` works on `up` / `status` / `verify` / `down` / `reset` / `seed` / `snapshot` / `e2e run`.
- Slot ceiling is **9** (slot 10 would collide the rabbitmq-management port with slot 0).
- Slot > 0 is a backend sub-stack today; `connect` is excluded pending literal-port tokenization.
- Cloud/tunnel modes (`--sandbox`/`--tunnel`) are slot-0 only (they front fixed ports).

← [sub-stacks](./sub-stacks-and-bundles.md) · [Getting started](./getting-started.md)

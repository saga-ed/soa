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

<details><summary>Slot 1 boots on offset ports (iam :4010, scheduling :4008…) under project <code>soa-s1</code>, disjoint volumes</summary>

```
# slot 0: iam :3010, sis :3100, scheduling :3008, sessions :3007   (project soa)
# slot 1: iam :4010, sis :4100, scheduling :4008, sessions :4007   (project soa-s1)

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

## Wiping a slot pristine

`down` *stops* a slot (volumes, state dir, and snapshots all survive for the next `up`).
When you want the slot **gone** — handed back as if it had never been used — `wipe` is the
per-slot sledgehammer: it stops the slot's services natively, removes the `soa-s<N>`
compose project's containers **and volumes** (`docker compose -p soa-s<N> down -v`), and
`rm -rf`s the slot's state dir (pids, logs, cookies, `claim.json`), so the slot vanishes
from `ss stack slots`. Snapshots are **kept** unless you add `--snapshots`.

```bash
ss stack wipe --slot 3              # prompts, enumerating exactly what dies
ss stack wipe --set journey-fix --yes   # non-interactive; the set's slot
ss stack wipe --slot 3 --dry-run    # the same enumeration; changes nothing
ss stack wipe --slot 3 --snapshots --yes  # also remove ~/.saga-mesh/snapshots-s3
ss stack wipe --slot all --dry-run  # enumerate EVERY non-empty slot 1..9
ss stack wipe --slot all --yes      # wipe them all in one sweep
```

<details><summary>✓ slot 3 wiped — containers + volumes + state dir gone; snapshots and worktrees kept</summary>

```
▶ wipe slot 3 — this will remove:
    containers + volumes: docker compose -p soa-s3 down -v (project soa-s3)
    state dir:            /tmp/sds-synthetic-s3  (pids, logs, cookies, claim.json)
    snapshots:            KEPT — ~/.saga-mesh/snapshots-s3 (pass --snapshots to remove)

  This DESTROYS slot 3's containers, volumes, and state. Continue? [y/N] y
✓ services stopped (2 from /tmp/sds-synthetic-s3)
✓ containers + volumes removed (soa-s3)
✓ state dir removed (/tmp/sds-synthetic-s3)
✓ slot 3 wiped — `ss stack slots` now reports it unused
```
</details>

Notes:

- **An explicit `--slot 1..9` (or `--set`) is required.** Slot 0 is refused — the shared
  baseline's clean-slate reset is [`ss stack cold-start`](./cold-start.md), which also
  re-bases the checkouts; `wipe` is the isolated per-slot counterpart.
- **Source is never touched.** `wipe` runs **no git operations** — a set-bound slot's
  worktrees survive (the confirmation says so explicitly); removing worktrees stays
  `ss set rm --and-worktrees`.
- **Live-claim guard.** If the slot's claim is live (another driver's `ss` process is
  still running), `wipe` refuses; `--yes` overrides. A stale claim never blocks.
- `--dry-run` prints the same enumeration and exits 0 without writing a claim;
  `--output-json` reports `{slot, project, stateDir, stopped, volumesRemoved,
  stateDirRemoved, snapshotsRemoved}`.
- **`--slot all` sweeps slots 1–9.** A slot is a candidate iff it left something behind:
  its state dir exists, it is live (pids/containers), or — only under `--snapshots` —
  its snapshot root exists. Slot 0 is never a candidate. A **live-claimed** candidate is
  *skipped with a warning* instead of aborting the sweep; `--yes` includes it. `--set`
  and `--state-dir` are ambiguous with `all` and rejected. One confirmation covers the
  whole sweep, and each wiped slot gets its own advisory claim (a failed wipe still
  records who attempted it). `--output-json` reports `{mode: "all", wiped: [...per-slot
  records], skipped: [...slot numbers]}`.

## Who's on what slot — `ss stack slots` and claim files

With several humans and agents multiplexing one box, `ss stack slots` is the one-glance
answer to "who is on what slot". It always sweeps **all slots 0–9** (`--slot` is accepted
but never narrows the report) and is strictly read-only:

```bash
ss stack slots                   # human table
ss stack slots --porcelain       # one TSV line per row-worthy slot (active, claimed, or set-bound): slot  active  set  actor  live|stale  at
ss stack slots --output-json     # full claim + per-repo posture detail
```

<details><summary>Columns SLOT · ACTIVE · SET · ACTOR · LAST DRIVEN (relative age), per-repo posture under active slots, unused slots collapsed</summary>

```
SLOT  ACTIVE  SET          ACTOR                        LAST DRIVEN
───────────────────────────────────────────────────────────────────
0     ● up    —            skelly@devbox:pts/4          2h ago
      soa          @ main   clean
      saga-dash    @ main   dirty  behind by 2

1     ● up    journey-fix  claude:41234                 45m ago
      saga-dash    @ feat/journey-weekends   clean  ⚠ drifted since launch

2     —       —            coach-aug3-training (stale)  1d ago

slots 3-9: unused
```

A slot earns a row when it's **active, claimed, or set-bound**; the rest collapse into one
dim line. Posture (branch / dirty / behind / drift) is gathered for **active** slots only:
a set-bound slot reads its set's worktrees, slot 0 reads the shared checkouts, and an
active slot > 0 without a set just notes `shared checkouts (see slot 0)` — no git spawns.
</details>

**The claim file.** Every command that *drives* a slot's stack — `up` / `down` / `reset` /
`restart` / `seed` / `login` / `cold-start` / `bootstrap` / `tunnel` /
`snapshot store|restore|delete` / `e2e run` / `develop coach|connect` / mutating `overlay`
verbs — writes `<stateDir>/claim.json` on entry (slot 1: `/tmp/sds-synthetic-s1/claim.json`),
recording **who last drove this slot**:

```jsonc
{
  "version": 1,
  "actor": "claude:41234",           // resolved identity — see order below
  "actorSource": "claude",           // "env" | "claude" | "fallback"
  "pid": 52110,                      // the ss process; liveness is checked at READ time
  "command": "ss stack:up --slot 1 --only iam-api",
  "at": "2026-07-16T10:02:07.331Z",  // ISO-8601 write time
  "cwd": "/home/skelly/dev/soa",
  "slot": 1,
  "set": "journey-fix",              // only when the run was --set-driven
  "sourceAtLaunch": {                // per repo that existed on disk at launch:
    "saga-dash": { "branch": "feat/journey-weekends", "headSha": "6b1e0c9…", "dirty": false }
  }
}
```

**Actor resolution order** — first match wins:

1. `$SS_ACTOR` (non-empty) → `actorSource: "env"`.
2. A `claude` process anywhere up the ppid chain → `claude:<pid>`, `actorSource: "claude"`.
3. `<user>@<host>[:<tty>]` (e.g. `skelly@devbox:pts/4`) → `actorSource: "fallback"`.

Agents: put **`SS_ACTOR=<task-name>`** in your environment *before* running mutating
commands — the claude-ancestry fallback only identifies *a* Claude; `SS_ACTOR` says which
task is driving.

**Staleness is read-time, and stale is normal.** A stack deliberately outlives the `ss`
process that launched it, so the claim's pid is usually dead by the time anyone looks —
that is exactly what "**last driven by**" means. `stack slots` probes pid-liveness when it
*reads*: a live pid renders plain, a dead one gets the dim `(stale)` suffix. **Nothing
ever deletes `claim.json` in the normal lifecycle** — a stale claim on an inactive slot is
ordinary history, not an error. (The one exception is [`stack wipe`](#wiping-a-slot-pristine),
which removes the slot's whole state dir — claim included — precisely so the slot vanishes
from this report.)

**Advisory, not exclusive.** A claim never blocks anything: two actors can drive one slot
back-to-back and the file simply records the most recent driver. It's a coordination
courtesy between humans and agents, not a lock (the realpath-keyed prep lock in
[worktree sets](./worktree-sets.md) is the actual mutual exclusion — and it guards
*builds*, not slots).

**Drift.** `sourceAtLaunch` freezes each repo's branch + HEAD at claim time; when a repo's
current HEAD no longer matches, the posture line flags `⚠ drifted since launch` — the
running stack was built from code its checkout has since moved past.

## Notes

- `--slot N` works on `up` / `status` / `verify` / `down` / `reset` / `seed` / `snapshot` / `e2e run` —
  and on `wipe`, where it is *required* (slots 1–9 only; slot 0's reset is `cold-start`).
- Slot ceiling is **9** (slot 10 would collide the rabbitmq-management port with slot 0).
- Slot > 0 is a backend + saga-dash/coach + **full Connect** (`connect-api` + `connect-web`) sub-stack (soa#271); only the literal-port playback trio (transcripts/insights/chat, optional) stays excluded. AV is SHARED — a slot's Connect session opens its own rooms on the single slot-0 livekit (keyed by session id), and its browser CRDT dials the slot's own rtsm via a per-slot fleet file.
- Cloud/tunnel modes (`--sandbox`/`--tunnel`) are slot-0 only (they front fixed ports).
- Want a slot to also mean *different source*? Name a repo→worktree map bound to a slot —
  a **[worktree set](./worktree-sets.md)** — and drive everything with `--set <name>`.

← [sub-stacks](./sub-stacks-and-bundles.md) · [worktree sets](./worktree-sets.md) · [Getting started](./getting-started.md)

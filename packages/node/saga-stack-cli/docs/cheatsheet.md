# `ss` cheatsheet

← [Getting started](./getting-started.md) — the narrated happy path. This page is the dense
one-liner reference: copy a line, adjust, go. Flags: `--slot N` (0 = baseline, 1–9 parallel),
`--set <name>` (worktree set, supplies its own slot), `--only`/`--with` (sub-stack), `--dry-run`
on almost everything, `--output-json`/`--porcelain` for scripting, `--help` at every level.

---

## Stack is down? Start here

Bring the stack up on **slot 0**, then run the full `journey` flow **in the background**, leaving a
**logged-in browser held open** at the end:

```bash
ss stack up --slot 0 && \
  nohup ss e2e run saga-dash/journey --headless --hold >/tmp/ss-journey.log 2>&1 &
```

- `ss stack up --slot 0` stands up the baseline stack (prep → migrate → launch → seed) and must go
  green before the flow runs — that's the `&&`.
- `nohup … &` detaches the flow so your terminal is free while it drives Playwright (~30s); tail it
  with `tail -f /tmp/ss-journey.log`.
- `--headless` runs the flow without popping browsers per stage; **`--hold`** then mints the
  dev-persona cookie jar and opens **one logged-in browser** at saga-dash's slot-0 URL and exits 0.
  The stack stays up.

> Prefer to watch the whole thing run headed instead? Drop `--headless` (and `nohup … &`) and run it
> in the foreground: `ss e2e run saga-dash/journey --hold`.

Want a **guaranteed-clean** main baseline first (destructive — docker `down -v`)? Prefix with
`ss stack cold-start --yes`. See [cold-start](./cold-start.md).

---

## Stack lifecycle

```bash
ss stack up                          # full stack, slot 0 (prep → migrate → launch → seed)
ss stack up --only scheduling-api,sessions-api   # minimal dependency closure only
ss stack up --with dash              # a convenience bundle (dash/connect/coach/playback/qtf)
ss stack up --slot 1                 # an isolated parallel stack (slots 1–9)
ss stack up --set feat-sched         # boot from a worktree set (owns its slot)
ss stack status                      # per-service health, read-only (never exits non-zero)
ss stack verify --only <svc,…>       # gating health check, scoped to a closure (exits non-zero if down)
ss stack verify --full               # whole-stack health + data (D1–D5) + source posture
ss stack down                        # stop services natively (kill-by-pidfile); mesh stays up
ss stack down --mesh                 # also stop postgres/redis/rabbitmq/mongo (volumes survive)
ss stack down --slot 1               # stop a specific slot   (--set <name> for a set)
```

## Clean slate & baselines (slot-0 only)

```bash
ss stack cold-start --dry-run        # preview the 6-phase destructive reset
ss stack cold-start                  # docker down -v → repos to main → clean build → .env → up → verify (prompts once)
ss stack cold-start --yes            # …skip the prompt (CI/agents)
ss stack cold-start --reinstall --seed full   # also wipe node_modules; seed the full dataset
ss stack bootstrap                   # non-destructive stand-up on main (ensure repos → up → seed → verify)
```

## Seed / reset / snapshot

```bash
ss stack reset                       # truncate data DBs to empty baseline + re-seed dev user
ss stack seed --with <add-on>        # seed a running stack with add-ons
ss stack seed --scenario <name>      # a named dataset/scenario  (--dry-run to preview)
ss stack snapshot store --fixture-id my-baseline   # store  (name is the --fixture-id FLAG)
ss stack snapshot list               # what's stored
ss stack snapshot restore my-baseline              # restore (name is a bare positional)
ss stack snapshot validate|delete <name>
```

## E2e flows

```bash
ss e2e list                          # discover SPAs, flows, stages, prerequisites
ss e2e run saga-dash/journey --through sessions --dry-run   # show the plan (closure, DBs, reset+seed)
ss e2e run saga-dash/journey --through sessions --headless  # run a prefix of a progressive flow
ss e2e run saga-dash/journey                     # headed (omit --headless)
ss e2e run saga-dash/journey --hold              # after green: open a logged-in browser, exit 0
ss e2e run saga-dash/journey --to pods --hold    # run UP TO (not including) a stage, then hold
ss e2e run --set feat-sched saga-dash/journey    # run a flow against a worktree set (its slot)
ss e2e run saga-dash/journey --slot 1            # run on an isolated slot
ss e2e connect                       # live interactive 1-tutor + 2-student Connect session
```

`--through <stage>` = inclusive window end; `--to <stage>` = exclusive (leaves the stack at that
stage's entry state). Both take a name, number, or stage id. `--hold` composes with any run.

### Stage checkpoints — skip the replay

```bash
ss e2e run saga-dash/journey --snapshot-stages --headless   # bake a checkpoint after each green stage
ss e2e run saga-dash/journey --from sessions                # restore predecessor ckpt, run 6→end
ss e2e run saga-dash/journey --from 6 --through 7           # restore + run just stages 6–7
ss e2e run saga-dash/journey --from schedule --to schedule --hold   # empty window: restore + hold, run nothing
```

`--from` validates the checkpoint hard (unchanged producing stages, at migration head, matching seed
profile, ≤7 days — `--from-stale-ok` overrides the age gate); it can't combine with `--skip-reset`.
Bake with `--snapshot-stages` before you can `--from`.

## Worktree sets (parallel dev contexts)

```bash
ss set create feat-sched --slot 1 --repo saga-dash \
  --path ~/dev/worktrees/saga-dash-sched --branch feat/sched-tweak   # worktree + branch + slot binding
ss set check feat-sched              # preflight: paths, build posture, drift (exits non-zero on violation)
ss set list                          # every set: name, slot, live?, repos
ss set show feat-sched               # per-repo: branch, clean/dirty, path, provenance, behind-main
ss set rm feat-sched                 # drop the set (worktrees left on disk)
ss set rm feat-sched --and-worktrees --yes         # also remove ss-created worktrees
```

A set owns its slot (1–9) — `--set` + a conflicting `--slot` is a hard error. `--set` supplies the
slot and pins its repo to your worktree; the rest of the closure comes from your default checkouts.

## Integration workflows (slot-0)

```bash
ss stack overlay list                        # what's currently overlaid on slot-0 checkouts
ss stack overlay apply --prs 165 saga-dash   # overlay in-flight PR(s) onto named repo(s)
ss stack overlay reset saga-dash             # drop the overlay, back to main
ss stack login teacher@saga.org              # mint a persona cookie jar (defaults to dev@saga.org)
ss stack login --browser                     # …also open an auto-logged-in Chromium
ss stack tunnel                              # share the running stack
```

---

## Slots at a glance

| | Slot 0 | Slots 1–9 |
|---|---|---|
| Role | shared team baseline | your parallel dev contexts |
| Docker project | `soa` | `soa-sN` |
| Port band | base | base + `N×1000` |
| State dir | `/tmp/sds-synthetic` | `/tmp/sds-synthetic-sN` |
| `cold-start`/`restart`/`overlay`/`--tunnel` | ✓ | ✗ (backend sub-stack only) |

There's no global "which slots are up" view: `ss set list` (ACTIVE column) covers slots with a
defined set; `ss stack status --slot N` probes one slot.

---

## Peer docs

[sub-stacks](./sub-stacks-and-bundles.md) · [slots](./slots.md) · [worktree-sets](./worktree-sets.md) ·
[verify](./verify.md) · [snapshots](./snapshots.md) · [e2e](./e2e.md) · [e2e-flows](./e2e-flows.md) ·
[integration](./integration.md) · [cold-start](./cold-start.md) · [faq](./faq.md)
</content>
</invoke>

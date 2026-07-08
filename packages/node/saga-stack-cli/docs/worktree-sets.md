# Worktree sets — parallel dev contexts, one name each

← [Slots](./slots.md) · [Getting started](./getting-started.md)

A **worktree set** is a named map of `repo → checkout path` bound to a [slot](./slots.md).
One name selects *source + runtime + flows*: `ss e2e run --set my-fix …` runs **that
worktree's code and that worktree's `flows.json`** on the set's own isolated stack, while
your primary checkouts (and other sets) keep running untouched. Two features in one:

- **different code** — every `--<repo>`-aware path (launch cwd, prep, seed, e2e specs)
  resolves inside the set's worktrees;
- **different flows** — `flows.json` lives in the SPA repo, so each worktree *authors its
  own scenarios* and `e2e run --set` executes exactly those.

## The sets file

`$SAGA_STACK_SETS ?? ~/.saga-stack/worktree-sets.json` — hand-editing is fully supported
(re-validated on every read):

```jsonc
{
  "version": 1,
  "sets": {
    "journey-fix": {
      "slot": 1,                                   // REQUIRED, 1..9, unique per set
      "repos": {
        "saga-dash": "~/dev/worktrees/saga-dash-journey",
        "rostering": {                             // object form records provenance
          "path": "~/dev/worktrees/rostering-a",
          "createdFrom": "feat/a"                  // branch-drift WARNINGS key off this
        }
      },
      "note": "PR #345 weekend-tolerant journey"
    },
    "topology": { "slot": 2, "repos": { "saga-dash": "~/dev/worktrees/saga-dash-topology" } }
  }
}
```

Repo keys are the CLI flag names (`soa`, `rostering`, `program-hub`, `saga-dash`, `coach`,
`sds`, `qboard`, `rtsm`, `fleek`) — a typo gets a did-you-mean. `~` expands; relative paths
resolve against the file's directory. **Slot 0 is rejected**: it's reserved for the
primary-checkout baseline, so a plain no-`--set` run stays exactly what it is today.

## Using a set

`--set <name>` is accepted by `up / down / status / verify / reset / seed / snapshot* /
e2e run|list`. It does exactly two things: supplies the slot, and pins each of the set's
repos **unless you typed that `--<repo>` flag yourself**:

```
explicit --<repo> flag   >   set map   >   $<REPO> env   >   $DEV/<repo> default
```

```bash
ss set list                      # NAME SLOT ACTIVE(live-derived) REPOS
ss set show journey-fix          # per-repo branch + dirty + provenance
ss set check journey-fix         # validate (exit 1 on violations — see below)

ss stack up   --set journey-fix  # the set's repos on the set's slot
ss e2e list   --set journey-fix  # THAT worktree's flows.json
ss e2e run    --set journey-fix saga-dash/journey
ss stack down --set journey-fix
```

The set *owns* its slot: `--set journey-fix --slot 2` is a hard error (drop `--slot` or
edit the file), so "which set is on slot N" always has one answer.

## The build-collision guard

Slots isolate *runtime*, not *source*. Two slots **running** one pre-built checkout is
fine (fresh-skip makes prep a no-op); two slots **building** one checkout races. Three
layers keep this safe, all exercised by `up --set` / `e2e run --set` automatically:

1. **Implicit preflight** (also `ss set check`): paths exist and are real git checkouts,
   branch-drift vs `createdFrom` (warn-only — worktrees are workspaces), cross-set
   collision dry-check (two sets sharing a BUILDABLE checkout is a violation, sharpened
   with live is-that-slot-ACTIVE detection), and **primary-checkout posture**: a
   buildable entry pointing at your primary `$DEV/<repo>` is refused — prep would build
   your live working copy. `--allow-primary` (on `up`) is the explicit escape hatch.
2. **Realpath-keyed prep lock**: even two racing invocations can never `pnpm
   install`/`build` one tree concurrently — the second fails fast with who-holds-it.
3. **Fresh-skip stays legal**: pre-built shared checkouts are never rebuilt, so pointing
   several sets at one clean, built worktree is a supported pattern.

## The canonical shape: two sets + a baseline

This exact scenario is validated live (see PR soa#236): parallel feature contexts, each
with its own flows, interpretable against a clean-main control.

```bash
# ss set create (M13-C) does the worktree add + pnpm install + records the set:
ss set create a --slot 1 --repo saga-dash --path ~/dev/worktrees/saga-dash-a --branch feat/x
ss set create b --slot 2 --repo saga-dash --path ~/dev/worktrees/saga-dash-b --branch flow/topology
# …author each worktree's apps/web/dash/e2e/flows.json, then:

ss e2e run saga-dash/journey --through schedule      # baseline: main, slot 0
ss e2e run --set a saga-dash/my-flow-a &             # concurrently…
ss e2e run --set b saga-dash/my-flow-b &             # …on slots 1 and 2
```

Tear a set down with `ss set rm <name>` (drops the set) or `ss set rm <name> --and-worktrees --yes`
(also `git worktree remove`s the worktrees `ss` created — `createdBy: ss`; hand-recorded paths are
never touched). The set file stays hand-editable, and `$SAGA_STACK_SETS` overrides its location.

Each run's Playwright output shows its own worktree (spec paths + flow/stage lists come
from that worktree's `flows.json`); containers/volumes/state/DBs stay disjoint per slot.

## Notes

- Sets inherit every slot caveat: **backend + saga-dash/coach + full Connect contexts**
  (`connect-api` + `connect-web` are slottable as of soa#271, sharing the one slot-0 livekit;
  only the literal-port playback trio stays on slot 0), slot ceiling 9, `--tunnel`/`--sandbox`
  slot-0 only.
- A set doesn't have to pin every repo — unpinned repos fall through to env/`$DEV`
  primaries. Sharing primaries is fine when they're **pre-built** (running is safe;
  building is what the guard refuses).
- ACTIVE in `ss set list` is **derived live** (state-dir pids + compose containers) —
  there is no recorded state to go stale.
- `ss set create` / `set rm [--and-worktrees]` (M13-C) are now shipped (above). Remaining
  fast-follow: an `e2e run --baseline` clean-main preflight (M13-D). Plan of record:
  `soa/claude/projects/gh_214/plans/10-m13-worktree-sets.md`.

← [Slots](./slots.md) · [e2e](./e2e.md)

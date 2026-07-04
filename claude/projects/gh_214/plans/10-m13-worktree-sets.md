# M13 — Worktree Sets: parallel dev contexts on `ss` slots (soa#214, tracker #221)

A **worktree set** is a named, first-class map of `repo → checkout path` bound to a slot,
so devs routinely bring up and e2e-test independent multi-repo/multi-branch contexts
against synthetic-dev **concurrently** — without bottlenecking through the primary
checkouts. Canonical shape: two worktree sets on slots 1/2 plus a clean-main baseline on
slot 0.

All design decisions below were settled with skelly (2026-07-04 session); tenets from the
handoff (multi-repo + same-repo-different-branch, first-class concept, routine feature,
never share a *hot* checkout, baseline is part of the feature) are taken as given.

**Status of the "flag asymmetry"**: the handoff flagged that `e2e run` exposed all
per-repo pins while `stack up` exposed a subset. This is already resolved on `gh_214`:
`repoFlags` is spread into `baseFlags` (`src/shared-flags.ts:35,125`) and every command
spreads `baseFlags` (`src/base-command.ts:134`). Every command therefore already accepts
every `--<repo>` pin; the set map layers on top of a uniform surface.

---

## 1. Concept & schema

### 1.1 The file

`~/.saga-stack/worktree-sets.json` — a durable per-dev dir **outside any repo** (survives
checkout churn, naturally per-developer, room for sibling files like locks later).

```json
{
    "version": 1,
    "sets": {
        "journey-fix": {
            "slot": 1,
            "repos": {
                "saga-dash": "~/wt/saga-dash-journey",
                "rostering": "~/wt/rostering-a",
                "sds": "~/wt/sds-clean-main"
            },
            "note": "PR #345 weekend-tolerant journey"
        },
        "topology": {
            "slot": 2,
            "repos": {
                "saga-dash": "~/wt/saga-dash-topology",
                "rostering": "~/wt/rostering-c"
            }
        }
    }
}
```

### 1.2 Schema rules

- **Keys are the CLI flag names** (`RepoKey` in `src/runtime/repos.ts:29` — kebab,
  `sds` not `student-data-system`). One vocabulary everywhere: flag = env mapping =
  set key. Unknown keys are a hard parse error with a did-you-mean suggestion
  (levenshtein over the 9 known keys).
- `slot` **required**, integer 1..9 (the existing slot ceiling — `src/shared-flags.ts`
  caps at 9 because slot 10's rabbitmq would collide with slot 0's rabbitmq-mgmt).
  Slot 0 is **rejected** in a set: slot 0 = primary checkouts / baseline by convention.
- Two sets declaring the same slot: parse-time hard error (slot ownership is the point).
- Paths: `~` expanded, relative paths resolved against the file's dir (discouraged),
  stored verbatim. Existence is checked by `set check` and at `up`-time, not at parse.
- `version` field for forward-compat; unknown top-level keys tolerated.
- Zod schema in `src/core/set/` (pure parse/validate, no fs — mirrors the
  `core`-pure / `runtime`-io split used everywhere else); a thin `runtime/set-store.ts`
  does the read (missing file ⇒ empty store, same tolerance as `runtime/flows.ts`).

---

## 2. CLI surface & precedence

### 2.1 `--set <name>`

On the lifecycle + e2e commands: `up / down / status / verify / reset / seed / snapshot /
e2e run`. Mechanically `--set` joins `baseFlags` (like `--slot`), with a central guard in
`BaseCommand.parse` mirroring the existing `slotAware()` pattern: commands that can't
thread a set (e.g. `restart`, which is slot-0-only by design; `tunnel`, slot-0-only)
reject it fast.

**Work item:** `seed` and `snapshot` are not `slotAware()` today (only
up/down/status/verify/reset/login/e2e-run opt in). Making `--set` real on them means
making them slot-aware first — scoped into M13-A below, since a set without per-slot
seed/snapshot is half a context.

### 2.2 What `--set` does

Exactly two things, both through existing seams:

1. **Repos**: injects the set's `repos` map into the `ScriptContext.repoRoots` that
   `scriptContextFromFlags` builds (`src/base-command.ts:485-510`), after which the
   existing `resolveRepoRoot` chain (`src/runtime/scripts.ts:71`) does everything —
   launch cwd placement, prep targets, seed, overlay, e2e spec discovery all already
   flow through it.
2. **Slot**: supplies the slot to `deriveInstance({ slot })`
   (`src/core/derive-instance.ts`) as if `--slot <set.slot>` had been passed.

### 2.3 Precedence

```
explicit --<repo> flag  >  set map  >  $<REPO> env  >  $DEV/<repo> default
```

**Implementation subtlety (the one real wrinkle):** `repoFlags` *default to the env
vars* (`default: process.env.SAGA_DASH`, `src/shared-flags.ts:35ff`), so a parsed flag
value alone can't distinguish "user typed `--saga-dash`" from "defaulted from env". Use
oclif's parse metadata (`metadata.flags[name].setFromDefault`) to classify: user-typed
flag wins over the set; env-defaulted flag *loses* to the set. One helper, unit-tested
against all four precedence rungs.

### 2.4 `ss set` topic

MVP ships **read + create** (create was promoted into MVP by skelly — see §2.5):

- `ss set list` — table: name, slot, repos, note.
- `ss set show <name>` — full entry + per-repo resolved branch (`git -C <path> branch
  --show-current`) and dirty flag.
- `ss set check <name>` — validation: paths exist, repos buildable-vs-prebuilt, branch
  report, **cross-set build-collision dry-check** (§4), primary-checkout detection.
  Exit 1 on hard violations. Also run implicitly at `up --set` time.
- `ss set create <name> --slot N --from-branches saga-dash=feat/x,rostering=feat/y
  [--wt-root <dir>]` — creates worktrees (`git -C <primary> worktree add <wt-root>/<repo>-<name> <branch>`),
  runs the existing prep pass (install/build via `src/runtime/prep.ts` — reuse, not
  reimplement), writes the set entry. `--repo saga-dash=/existing/path` form records an
  existing path without creating anything (mix-and-match with `--from-branches`).
- `ss set rm <name>` — removes the entry; `--and-worktrees` also `git worktree remove`s
  paths that `ss` itself created (tracked via a `createdBy: "ss"` marker per repo entry);
  never touches paths it merely recorded.
- Hand-editing the JSON remains fully supported (the store re-validates on every read).

`assign`/`edit` verbs: fast-follow, not MVP (hand-edit covers it).

### 2.5 Worktree creation is MVP (skelly's call)

Decision: `set create --from-branches` ships in the MVP, not as a fast-follow. Risk
containment so it doesn't destabilize the core:

- Creation **only ever adds** worktrees (never checkout/branch mutation in the primary);
  the primary checkout is read-only to `ss` except `git worktree add`.
- Failure mid-create: report per-repo results, keep successfully created worktrees,
  write **no** set entry unless all repos succeeded (no half-sets).
- Default worktree root `~/wt/` (open question §9.1 for skelly to confirm).

---

## 3. Slot binding

- **The set owns its slot.** One name = source + runtime + flows. All commands derive
  the slot from the set.
- `--set X --slot N` with `N ≠ X.slot`: **hard error** ("set 'X' is bound to slot 1;
  drop --slot or edit the set"). `--set X --slot <X.slot>` (redundant but consistent) is
  accepted.
- **Slot 0 is reserved** for the primary-checkout / clean-main baseline by convention:
  sets must bind 1..9 (schema-enforced, §1.2), and plain slot-0 usage is untouched.
- Slot uniqueness across sets is enforced at parse (§1.2), so "which set is on slot 2"
  is always answerable — this is what makes the collision guard and `status` output
  coherent.

---

## 4. The build-collision guard

Slots isolate runtime, not source: two slots *running* one pre-built checkout is fine
(fresh-skip keeps prep a no-op — `src/runtime/prep.ts` skips any repo whose
`node_modules` + `dist` exist); two slots *building* one checkout races. Two layers plus
a posture rule:

1. **Up-front cross-slot check** (at `up --set` and in `set check`): compute this set's
   *buildable* repo set (repos in the launch closure that fresh-skip would NOT skip),
   realpath each, and intersect with every *active* slot's resolved repo map. Overlap ⇒
   hard error naming both sets, the path, and the fix ("shared repos must be clean &
   pre-built, or use distinct worktrees"). Active-slot detection: a slot is active if
   its state dir (`/tmp/sds-synthetic-s<N>`) holds live pids or its compose project
   `soa-s<N>` has running containers — reuse the existing status probes; open question
   §9.2 records the active-set map (see below).
2. **Realpath-keyed prep lock** (race-proof backstop): before prep builds a repo root,
   take an exclusive flock on `/tmp/saga-stack-prep-<sha1(realpath)>.lock`; held ⇒ fail
   fast with who-holds-it (pid + slot written into the lock file), not silently wait.
   This catches the window the up-front check can't (two `up`s racing) and also guards
   set-vs-set-create and set-vs-plain-`up` collisions the map can't see.
3. **Primary-checkout posture**: a set entry pointing a *buildable* repo at the primary
   `$DEV/<repo>` checkout is **refused** (tenet 4: shared = clean, pre-built,
   effectively read-only worktrees), with `--allow-primary` as the explicit escape
   hatch. Pre-built primary entries (fresh-skip would no-op) get a warning, not an
   error, since running is safe — but the message still nudges toward a worktree.

The lock needs a tiny new runtime seam (`runtime/lock.ts`, ~flock via `proper-lockfile`
or O_EXCL + stale-pid detection); everything else composes existing probes.

---

## 5. Baseline & e2e threading

### 5.1 Baseline (clean-main control run)

Baseline = **slot 0 + primary checkouts + a cleanliness preflight**. No new machinery:
it is today's plain no-set run, plus `--baseline` on `e2e run`:

- `ss e2e run --baseline saga-dash/journey` ⇒ slot 0, primary checkouts, and a
  preflight over the participating repos: on the default branch, clean tree. Violation
  ⇒ warn (or error with `--strict`). Implemented on the M10 git seam
  (`runtime/git.ts` status/branch probes — already planned/landed for auto-pull).
- Rationale: consistent with slot-0-reserved (§3), zero extra worktrees/builds, and the
  preflight restores the "clean main" guarantee that makes a set run interpretable.
  A dev whose primaries are dirty can still hand-author a `main` set of clean-main
  worktrees on a spare slot — document the pattern, build nothing for it.
- Side-by-side reporting: MVP = each run's existing summary (they already print per-slot
  context); a `ss e2e report` aggregator over recent runs is a fast-follow, not MVP.

### 5.2 e2e threading (confirmation, not construction)

`ss e2e run --set A saga-dash/<flow>` needs only the §2.2 injection; everything
downstream already follows:

- `resolveAppCwd` (`src/e2e-orchestrate.ts:301`) resolves the SPA cwd from the
  overlaid repo env — point `SAGA_DASH` at the worktree and Playwright runs **that
  worktree's specs**.
- Flow discovery is pure path resolution off the same repo root
  (`src/core/flow/discover.ts`): the worktree's own `flows.json` is what loads — the
  per-worktree *content* projection (different flows/stages per branch) is exactly the
  flows-as-data scenario this feature exercises. `--spa-path` stays as the highest-
  priority manual override.
- Slot threading (`e2e run --slot N` → full instance profile + offset Playwright URLs
  via `buildStackContext`) is live-proven; the set just supplies N.

The plan's only e2e *work* is the `--set`/`--baseline` flag wiring + tests asserting the
resolved cwd/flows path lands in the set's worktree.

---

## 6. Milestones

Format follows `09-native-parity-plan.md`. MVP = M13-A + M13-B + M13-C (creation was
promoted into MVP; §2.5).

### M13-A — Set store + threading (do first) — **M**

| Item | Effort | Notes |
|---|---|---|
| `core/set/` schema + validation (zod, slot 1..9, unique slots, kebab keys + did-you-mean) | S | pure, heavy unit coverage |
| `runtime/set-store.ts` read + tolerant-missing | S | mirrors `runtime/flows.ts` posture |
| `--set` on baseFlags + central guard (mirror `slotAware()`), slot-mismatch error | S | |
| Injection into `scriptContextFromFlags` + precedence via oclif `setFromDefault` metadata | M | the one subtle bit — §2.3 |
| `seed` + `snapshot` slot-awareness (prereq for `--set` on them) | S–M | audit their state-dir/DB targeting against `InstanceProfile`; they already take `--slot` via baseFlags, they just reject >0 today |
| `ss set list / show / check` (check = paths + branches + collision dry-check + primary posture) | S–M | |

**Why first:** after M13-A alone, the canonical scenario is already runnable end-to-end
(hand-created worktrees + hand-edited JSON), which de-risks V1/V2 validation before the
guard and creation land.

### M13-B — Collision guard — **M**

| Item | Effort | Notes |
|---|---|---|
| Buildable-set computation (closure ∩ ¬fresh-skip) + realpath intersect vs active slots | M | reuses status/compose probes for "active" |
| `runtime/lock.ts` realpath-keyed prep lock + stale detection | S–M | new seam, small |
| Primary-checkout refusal + `--allow-primary` | S | |
| Negative tests (two sets on one buildable path; racing `up`s vs the lock) | S | |

### M13-C — `set create --from-branches` / `rm` — **M**

| Item | Effort | Notes |
|---|---|---|
| `git worktree add` runner (per-repo cwd, add-only, no primary mutation) | S–M | extends the M10 `runtime/git.ts` seam |
| Prep pass over new worktrees (reuse `runtime/prep.ts`) | S | reuse, not new |
| All-or-nothing set entry write + per-repo failure reporting + `createdBy` marker | S | |
| `rm [--and-worktrees]` (only removes ss-created worktrees) | S | |

### M13-D — Baseline + reporting polish — **S**

| Item | Effort | Notes |
|---|---|---|
| `e2e run --baseline` preflight (clean/default-branch, `--strict`) | S | on M10 git probes |
| Docs: canonical two-sets+baseline runbook in the CLI README | S | |
| Fast-follow (not MVP): `ss e2e report` side-by-side aggregator; `set assign/edit` | — | |

### P0 prerequisite (independent of M13 code, blocks V2)

**slot>0 programs-api rabbitmq cold-start** (OPEN): last concurrent two-slot e2e had
slot 0 green 20/20, slot 1 stuck at `[MQConnectionManager] CONNECTING` on a cold stack;
env verified offset-correct; health window already 120s. Possibly related: open PR
soa#232 "recover AMQP channels". **Treat as P0**: the two-set concurrent validation (V2)
cannot be signed off while a cold slot>0 stack can wedge on MQ. Track it as its own
work item (repro on a cold `up --slot 1`, then either fix in programs-api MQ init or
gate bring-up on an MQ-readiness probe before service launch).

---

## 7. Known risks & constraints (carried into the design)

- **Slot>0 is a backend + saga-dash/coach sub-stack** (`SLOT_EXCLUDED_SERVICES`,
  `src/core/derive-instance.ts`): connect-api/connect-web excluded pending literal-port
  tokenization; tunnel/sandbox slot-0-only; `restart` slot-0-only. Sets are
  backend+dash contexts today — `set check` should say so when a set's closure would
  want an excluded service.
- **Slot ceiling 9** bounds concurrent sets at 9 (plus baseline); fine for the routine
  2-3 context case.
- **Disk/build cost**: each worktree carries its own `node_modules`/`dist`. `set create`
  should print a size hint; nothing to engineer.
- **Config drift**: the JSON references absolute paths; a deleted worktree leaves a
  dangling entry. `set check`/`up`-time existence errors cover it; `rm` prunes.

---

## 8. Validation plan (live, concrete)

Use the two real branches already in flight as the worktree material:

- saga-dash `fix/journey-sessions-20-weekend-tolerant` (PR #345, journey e2e green
  20/20 incl. weekends) → **set A** (`journey-fix`, slot 1).
- saga-dash `flow/scheduling-topology-ab` (the flow agent's `scheduling-topology` flow —
  *different flows.json content*, the real projection proof) → **set B** (`topology`,
  slot 2).

**V1 (stacks):** bring up set A + set B concurrently (+ baseline slot 0). Assert:
- disjoint containers/volumes/state (`docker ps` project prefixes `soa`, `soa-s1`,
  `soa-s2`; distinct state dirs);
- each slot serves **its own branch's code** — use a known branch diff (the topology
  branch's flow list differs) or plant a marker string per worktree and curl it;
- shared pre-built repos are never rebuilt (prep summary reports them in `freshRepos`);
- **negative test**: point both sets' `rostering` at one *buildable* (dist-less)
  worktree ⇒ the guard fires (up-front check), and a racing second `up` hits the prep
  lock.

**V2 (e2e):** concurrent `e2e run --set journey-fix saga-dash/journey`,
`e2e run --set topology saga-dash/scheduling-topology`, and
`e2e run --baseline saga-dash/journey`. Assert:
- each run's resolved flows.json path is inside its set's saga-dash worktree, and the
  flow/stage lists differ per context (content projection, not just ports);
- all green;
- zero cross-slot DB writes — reuse the watchdog pattern: poll each slot's user counts
  during the runs and assert no cross-slot drift.

**Gate:** V2 is blocked on the P0 MQ cold-start item (§6) being fixed or reliably
mitigated (warm-up pass).

---

## 9. Open questions for skelly

1. **Default worktree root** for `set create`: `~/wt/` (short paths) vs
   `~/dev/worktrees/` (near the repos)? Plan assumes `~/wt/`, `--wt-root` overrides.
2. **Active-set visibility**: is "derive active slots from state dirs + compose
   projects" enough, or should `up --set` also record `name → slot` into
   `~/.saga-stack/active.json` so `ss set list` can show a live ACTIVE column? (Plan
   assumes derive-only for MVP; the file adds a write path + staleness risk.)
3. **`set check` strictness on branch drift**: should `check` warn when a worktree's
   current branch no longer matches what `--from-branches` created it from (someone
   switched branches inside the worktree)? Cheap to add via the branch probe; default
   assumed *warn*.
4. **`$SAGA_STACK_SETS` env override** for the sets-file path (CI / tests will want it;
   assumed yes, trivially).

---

## 10. Summary of settled decisions (for the record)

| Question | Decision |
|---|---|
| Map file | `~/.saga-stack/worktree-sets.json`, `version` + `sets{name → {slot, repos, note?}}`, kebab flag-name keys (`sds`) |
| CLI surface | `--set` on up/down/status/verify/reset/seed/snapshot/e2e-run; `ss set list/show/check/create/rm`; hand-edit supported; precedence flag > set > env > default |
| Slot binding | Set owns slot (1..9, unique); `--set X --slot N` mismatch = hard error; slot 0 reserved for baseline |
| Build guard | Up-front cross-slot buildable-realpath check (hard error) + realpath-keyed prep lock; buildable-at-primary refused, `--allow-primary` escape |
| Worktree creation | **In MVP** (`set create --from-branches`: worktree add + install/build + entry write; add-only, all-or-nothing) |
| Baseline | Slot 0 + primary checkouts + `e2e run --baseline` clean/main preflight (`--strict` to error); clean-main set on a spare slot documented as a pattern |
| e2e threading | Pure injection: set → repo env + slot; flows.json/spec discovery already follows the set's SAGA_DASH (`resolveAppCwd`, `core/flow/discover.ts`) |

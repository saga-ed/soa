# E2E Flows — a first-time user's runbook

Everything here uses the `ss` CLI (already on your PATH; `node bin/dev.js` from
`~/dev/soa/packages/node/saga-stack-cli` is the equivalent if it isn't). Every
command is copy-pasteable. Nothing here requires up.sh.

**Reviewing or debugging a run** (watch/step-through/hold/iterate/review —
the technique ladder, plus `--capture` / `ss e2e traces`):
[e2e-review.md](e2e-review.md).

**See what exists at any moment:**

```bash
ss e2e list          # every SPA, flow, and stage — plus checkpoint freshness
```

## The five flows at a glance

| Flow | What it verifies | Runnable? |
|---|---|---|
| `saga-dash/journey` | The 8-stage trunk: roster upload → program → enrollment → pods → schedule → sessions → attendance (→ personas, currently skipped upstream) | ✅ |
| `saga-dash/ads-adm-attendance` | Period-based attendance **persists**: survives reload AND is served back by ads-adm-api | ✅ |
| `saga-dash/scheduling-topology` | A non-trivial A/B rotation topology **realizes the correct schedule** (dates, slots, treatment switches, per-pod isolation) | ✅ |
| `saga-dash/connect-session` | A live Connect tutoring room (1 tutor + 2 students, AV) | 🎤 manual (needs mic/cam) |
| `connectv3/connect-smoke` | connect-web smoke | ❌ not yet — see ToDo |

## Concepts in 60 seconds

- A **flow** is data (`flows.json` in the SPA's repo), not bash: an ordered list
  of **stages**, each mapping to a Playwright project.
- A **progressive** flow (journey) runs stages 1..N in order; each stage builds
  real DB state the next one uses.
- A **checkpoint** is a DB snapshot baked after a stage goes green. Later runs
  can `--from <stage>` — restore the snapshot and skip the replay. Checkpoints
  know when they're stale (`ss e2e list` shows `[checkpoint: re-bake]`).
- A **prerequisite** flow (ads-adm, connect) needs journey state first — it
  restores journey's checkpoint automatically instead of replaying it.
- An **additive seed** lets a prerequisite flow (`reset: false`) that *also*
  declares a `seed` run that seed ON TOP of the restored journey state — e.g.
  `connect-content` / `connect-nav-lock` publishing their poll into content-api,
  which journey itself never seeds. Skipped under `--skip-reset`, and never on a
  `--from` checkpoint (the restore is the state source).
- A **slot** is an isolated stack instance (`--slot 1..9`, offset ports).
  Slot 0 is your default stack. You never need a slot for a first run.

---

## Running each flow

### 1. journey — the trunk

```bash
# BACKGROUND (headless — the normal way; brings the stack up, resets + seeds):
ss e2e run saga-dash/journey --headless

# ...or only part of it (stages 1..4):
ss e2e run saga-dash/journey --through pods --headless

# FOREGROUND (watch the browser do it):
ss e2e run saga-dash/journey --through pods --headed

# FIRST RUN TIP: add --snapshot-stages once — it bakes a checkpoint after each
# green stage, which unlocks all the fast iteration below:
ss e2e run saga-dash/journey --snapshot-stages --headless
```

What you'll see per stage: `==> playwright: journey — … --project stage-N-…`
then a pass count. Stage 8 currently reports `2 skipped` (its describe is
skipped upstream in saga-dash — expected).

### 2. ads-adm-attendance — persistence scenario

```bash
ss e2e run saga-dash/ads-adm-attendance --headless    # background
ss e2e run saga-dash/ads-adm-attendance --headed      # foreground
```

Watch the log: `==> restore: flow-saga-dash-journey-s5-schedule …` then
`prerequisite: journey@schedule restored from checkpoint (replay skipped)` —
that's the checkpoint machinery saving you ~a minute of journey replay. (If no
valid checkpoint exists it transparently replays journey instead — slower,
same result.)

### 3. scheduling-topology — realization scenario

```bash
ss e2e run saga-dash/scheduling-topology --headless   # background
ss e2e run saga-dash/scheduling-topology --headed     # foreground
```

Self-seeds from the stock roster profile (no prerequisite). The single stage
configures a 2-rotation topology through the API and asserts the realized
sessions day-by-day.

**Manually inspect the world it built** — the flow seeds a browsable admin
inside its (otherwise invisible) Empty Org world, so after a green run:

```bash
ss stack login ab-topology-admin@saga.org --slot <N> --browser
# → auto-logged-in Chromium; pick "Empty Org" — the AB Topology program's
#   A/B sessions land on next week's Mon/Wed/Fri.
```

Don't reach for `dev@saga.org` here — the dash scopes program browsing to the
signed-in user's own districts (no org switcher), and dev@ only carries Seed
District, so the flow's world is invisible to it. See
[the FAQ entry](./faq.md#how-do-i-manually-inspect-a-hermetic-flows-world-in-the-browser)
for the general pattern.

### 4. connect-session — manual/AV only

```bash
ss develop connect              # RESTORES the journey@schedule checkpoint (when baked),
                            # else replays journey headless, then opens the headed
                            # interactive room (holds via page.pause)
ss develop connect --reuse      # skip the state rebuild; use the current stack
ss develop connect --refresh-snapshot   # re-bake journey@schedule FRESH, then open the room
```

`ss develop connect` restores the `flow-saga-dash-journey-s5-schedule` checkpoint
instead of replaying journey 1..5 headless — the big accelerant — falling back to
the full replay when nothing is baked (`--no-prereq-from-snapshot` forces the
replay). Bake it once with `ss e2e run saga-dash/journey --through schedule
--snapshot-stages --headless`, or let `--refresh-snapshot` do it inline: it bakes
the journey checkpoints fresh (headless, `--snapshot-stages`) **then** opens the
room — the one-command reseed for when the checkpoint has gone stale (>7 days) or
the journey stages changed. `--refresh-snapshot` requires the default
`--prereq-from-snapshot` and is mutually exclusive with `--reuse`.

Needs a real mic/cam and your terminal (the AV hold owns the TTY). There is no
headless version — by design.

### 5. connectv3/connect-smoke — not runnable yet

The stack half works (`ss` brings up the 8-service closure green), but qboard's
connectv3 app has **no Playwright harness** (no config, no dependency, no
`e2e/` dir). See the ToDo section.

---

## Fast iteration with snapshot data

The loop you want when working on stage K of journey:

```bash
# 1. Once: bake checkpoints (full run, ~1 min):
ss e2e run saga-dash/journey --snapshot-stages --headless

# 2. Iterate on ONE stage in seconds — restore the state before it, run only it:
ss e2e run saga-dash/journey --from schedule --through schedule --headless

# 3. Edit the spec / app code, re-run step 2. Each iteration is ~5-10s instead
#    of a full replay.
```

Notes:
- `--from <stage>` restores the **previous** stage's checkpoint, then runs from
  `<stage>`. Baked dates are reused so date-sensitive stages stay coherent.
- Checkpoints go stale when the flow definition changes or after 7 days —
  `ss e2e list` shows `[checkpoint: re-bake]`; re-run step 1 to refresh.
- Scenario flows get this for free: their journey prerequisite restores from
  checkpoint automatically (`--no-prereq-from-snapshot` opts out).

## Pausing for manual testing

**Pause BEFORE a stage** (the state is built, the stage hasn't run — you drive
it by hand in a logged-in browser):

```bash
ss e2e run saga-dash/journey --to program --hold
# = build roster state, STOP, mint a dev@saga.org session, open a logged-in
#   browser. The stack stays up; the banner tells you how to tear down.
```

**Pause AFTER a stage** (see what the flow produced):

```bash
ss e2e run saga-dash/journey --through pods --hold
```

**Instant pause at any boundary** (once checkpoints are baked — this is the
one to remember):

```bash
ss e2e run saga-dash/journey --from schedule --to schedule --hold
# restore checkpoint, run NOTHING, logged-in browser at schedule's doorstep
# in ~6 seconds.
```

**Pause at EVERY stage in one run:** not supported as a single command. The
equivalent walk (each step is seconds after baking):

```bash
for s in roster program enrollment pods schedule sessions attendance; do
  ss e2e run saga-dash/journey --from $s --to $s --hold
  # poke around, close the browser, press on
done
```

**Debug a stage inside Playwright** (inspector, step through the spec):

```bash
ss e2e run saga-dash/journey --from schedule --through schedule -- --debug
```

Anything after `--` passes straight to Playwright (`--ui`, `--debug`, a grep).

## Narrow-closure runs stop out-of-closure services

A partial run computes the closure of just the stages it will execute — and **stops
services outside it** (clean SIGTERM). Running e.g.

```bash
ss e2e run saga-dash/journey --through pods --headless
```

on a previously-full stack SIGTERMs the services pods doesn't need (observed live
2026-07-09: sessions-api stopping cleanly). Two practical consequences:

- **The full stack is now partially down.** Bring a stopped service back without a
  full re-up:

  ```bash
  ss stack up --only sessions-api --skip-prep
  ```

- **saga-dash caveat, not an ss bug:** saga-dash's stack-lane stage-0-coherence smoke
  probes sessions-api **unconditionally** (`pinnedOrStack` short-circuits when
  `LANE === 'stack'` — see
  `apps/web/dash/e2e/sandbox/composition-coherence.e2e.smoke.test.ts:113`). So a
  narrow `--through` run below sessions can fail stage 0 against a service ss itself
  just stopped. `--from` runs skip stage 0 (`--no-deps`), so they don't hit this.

## Assessing the flows (background + foreground sweep)

A compact assessment session, in order:

```bash
ss e2e run saga-dash/journey --snapshot-stages --headless   # 1. trunk + bake
ss e2e run saga-dash/ads-adm-attendance --headless          # 2. persistence
ss e2e run saga-dash/scheduling-topology --headless         # 3. realization
ss e2e run saga-dash/journey --through pods --headed        # 4. watch one headed
ss e2e run saga-dash/journey --from schedule --to schedule --hold   # 5. drive one by hand
ss develop connect                                              # 6. live room (mic/cam)
ss stack down                                               # 7. tidy up
```

(Last full sweep: 2026-07-05 — steps 1-3 all green on main: 22 + 1 + 1 passed.)

## Remaining work — connect flows & connectv3

1. **Connect realtime session-based attendance flow** — phase 2 of the ADS/ADM
   initiative (period-based shipped 2026-07-05). Shape: prerequisite
   `journey@sessions` via checkpoint → record attendance through the Connect
   realtime path → the same persistence assertions (reload + API-direct).
2. **connect-session headless smoke (optional)** — a variant that stops short
   of the AV hold so CI can exercise the room-join path.
3. **connectv3 adoption** — author a repo `flows.json` in qboard (retiring the
   last bundled-example SPA) AND add the Playwright harness to the connectv3
   app (config + dependency + `e2e/` dir). The stack closure already comes up
   green; only the harness is missing.

## If something goes wrong

- **A service fails bring-up with `ERR_MODULE_NOT_FOUND`** — that sibling repo
  was pulled but not rebuilt; `pnpm install && pnpm build` in that repo. (The
  prep pass's fresh-skip can't detect stale installs yet.)
- **`[checkpoint: re-bake]` in `ss e2e list`** — the flow definition changed or
  the checkpoint aged out; re-run with `--snapshot-stages`.
- **Two `seed-dev-user … run seed:registry first` errors during seed** — known
  cosmetic ordering noise; it self-heals and the run continues.
- **A flaky pass/fail on session durability** — known app flake (gh-186);
  retry once before digging.
- **A service is down after a partial run** — expected; narrow closures stop
  out-of-closure services (see above). `ss stack up --only <svc> --skip-prep`.
- **A service DIES during a `--from` restore** (42P01 in its log) — the
  restore-vs-poller race; see
  [snapshots → Known issue](./snapshots.md#known-issue-restore-races-db-polling-services).
- Full docs: `docs/e2e.md` (flows/stages/checkpoints in depth), `docs/slots.md`
  (parallel stacks), `docs/worktree-sets.md` (multi-worktree development).

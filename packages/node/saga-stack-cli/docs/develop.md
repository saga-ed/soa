# Develop — concierge stacks for hands-on work

← [Getting started](./getting-started.md)

`ss develop <app-or-workflow>` is the **dev-setup concierge**: one command brings up the
right closure, resets + seeds it (recursing any prerequisite), and then **hands off a
running app** you can drive by hand — logged in, on the right screen, ready to work.

It is the sibling of [`ss e2e …`](./e2e.md), and the two split by intent:

| Topic | Intent | Commands |
| --- | --- | --- |
| **`develop`** | **set up + hand off** a developable stack for an app/workflow | `connect`, `coach`, `session-adm` (more coming) |
| **`e2e`** | **run test flows** (assertions, CI, traces) against a stack | `run`, `list`, `traces` |

Reach for `develop` when you want to *use* the app; reach for `e2e` when you want to
*test* it. Both are thin commands over the same flows-as-data machinery (`resolveFlow` +
the generic in-process executor) — a concierge just picks a flow and a hand-off style.

## `develop connect` — live interactive Connect session

```bash
ss develop connect
```

Brings up the Connect closure (iam / sessions / content / connect-api / connect-web / rtsm),
builds the `journey` prerequisite headless, then opens a real **1-tutor + 2-student**
interactive Connect room and holds it in the foreground — for hands-on Connect development,
not an assertion run.

```bash
ss develop connect                      # full: journey prereq → headed Connect room
ss develop connect --reuse -- --debug   # against the current stack, playwright --debug
ss develop connect --fake-media         # synthetic cam/mic (no camera / no v4l2loopback)
ss develop connect --refresh-snapshot   # rebake the journey prerequisite, then open the room
```

- `--reuse` skips the prerequisite rebuild + reset and runs against the **current** stack state.
- `--fake-media` swaps real mic/cam capture for Chromium's synthetic camera + mic (pins
  `FAKE_MEDIA=1` on the headed run only; the journey prerequisite is unaffected).
- `--refresh-snapshot` bakes the journey checkpoints fresh (headless replay,
  `--snapshot-stages`) before opening — the one-command reseed when the baked state has gone
  stale (>7d) or the journey changed. Requires `--prereq-from-snapshot`; mutually exclusive
  with `--reuse`.
- `--tunnel` points this run's browsers at the `https://<svc>.<moniker>.vms.wootdev.com` tunnel
  hosts so a **remote** peer can join the room (requires a prior `ss stack up --tunnel`).
  `--student-login <0-2>` leaves some students OPEN for remote peers to take — pair with
  `--tunnel` to invite coworkers. → [tunnel.md](./tunnel.md)
- Anything after `--` passes straight through to Playwright.

### Deprecation note: `e2e connect` → `develop connect`

`connect` moved from the `e2e` topic to `develop` (dev-setup, not a test flow). The old id
still works for one cycle via a deprecating alias — `ss e2e connect` dispatches to
`ss develop connect` and prints:

```
The "e2e connect" command has been deprecated. Use "develop connect" instead.
```

Update scripts to `ss develop connect`; the alias is removed in a later release.

## `develop coach` — a running, logged-in coach

```bash
ss develop coach
```

Brings up the coach closure (coach-web + coach-api + iam-api + coach_api Postgres + curriculum
mongo), seeds it (the `full` profile lands demo-tutor-1's content + track + group mapping), drives
one of coach-web's authored flows, then hands off a **headed, already-logged-in coach-web** at the
scenario's screen. Unlike `connect` (whose hold is the Playwright room), the hand-off is a real
browser via the vendored auto-login — the dev stack stays up; the window holds until you close it.

```bash
ss develop coach                          # content-viewer: the ported module player (demo-tutor-1)
ss develop coach --scenario admin         # the Reports route (demo-dadmin) — MOCK-backed today
ss develop coach --scenario playlist      # switch demo-tutor-1 to a 2nd track (needs coach#238)
ss develop coach --reuse -- --debug       # against the current stack, playwright --debug
```

- **`--scenario content-viewer`** (default) drives `module-playback` as `demo-tutor-1@saga.org` and
  lands on the ported module player (`/units/unit_1/sc_u1_m1`), rendering the seeded content
  (`CONTENT_STORE_BACKEND=postgres` is pinned in coach-api's launch env, so it serves the seeded
  release deterministically).
- **`--scenario admin`** logs in `demo-dadmin@saga.org` and lands on `/reports`. **Descoped for v1:**
  the org-wide Coach Report renders from **mock data** (`reportsStore.fetchReport → getMockReport`),
  not live coach-api resolvers — the command prints this caveat at hand-off. Live-backing it is
  coach-repo product work.
- **`--scenario playlist`** switches `demo-tutor-1` to a 2nd track via the coach-owned
  `coach-content playlist assign` + `materialize --replace`. That verb is being built in parallel
  (**coach#238**); if your coach checkout doesn't have it yet the command **fails fast** with an
  actionable message rather than crashing mid-bring-up.
- `--reuse` skips the reset+seed and hands off against the **current** stack state.
- `--tunnel` repoints this run's flow browsers at the vms tunnel hosts (as `connect`; requires a
  prior `ss stack up --tunnel`). Anything after `--` passes straight through to Playwright.

> Requires the `COACH` repo checked out (`$COACH` / `--coach`). coach-web signs in against the local
> iam via the soa#300 manifest wiring (`PUBLIC_IAM_API_URL` + iam CORS), landed with this topic.

## `develop session-adm` — the live SESSION-attendance ADM demo

```bash
ss develop session-adm
```

The 3-student staggered self-report demo as one durable command (promoted from saga-dash's
`telemetry-demo-multi.sh`): a tutor + Alex's 3 pod-A students (`ann.lee` / `cara.diaz` /
`gina.park`) join a real Connect room **staggered 15s apart**, each running the real
connectv3 `SessionHeartbeat`; ads-adm accrues **TELEMETRY dosage** live; closing one
student's window freezes **only that** counter. The command: `stack down` → relaunch with
the demo env (live dash polling + 3s heartbeat; the `ADS_ADM_*` session-source gates are
baked into the manifest since soa#346) → journey@attendance prerequisite (checkpoint
restore when baked) → **auto-open a logged-in admin browser** at
`/dashboard/attendance?mode=session` (as `empty@saga.org`; `$ADMIN_EMAIL` overrides) →
the held headed demo. The admin dash opens **before** the students join — the demo's
pre-join hold exists so you watch the counters climb from zero. Pick
**"E2E Journey Program"** in the dash. Resume (▶) in the Playwright Inspector ends the
run; the stack stays up (`ss stack down` when done).

```bash
ss develop session-adm                       # full: down → demo env → prereq → admin dash → held demo
ss develop session-adm --reuse --no-admin    # against the current stack, no admin browser
ss develop session-adm --stagger-ms 6000     # faster joins (DEMO_STAGGER_MS)
ss develop session-adm --refresh-snapshot    # rebake journey@attendance, then run the demo
```

- `--no-admin` skips the admin browser and prints the manual login one-liner (script parity;
  at `--slot N` the one-liner carries `--slot N` so the jar mints against the right iam).
- `--no-hold` drops `DEMO_HOLD` (no pre-join pause, no Inspector hold) — a straight-through
  run; the auto-opened admin browser is closed at the end instead of holding the terminal.
- `--stagger-ms <n>` pins `DEMO_STAGGER_MS` (default **15000** — pinned explicitly; the spec's
  own fallback is 6s).
- `--reuse` skips the down + prerequisite + reset. **Caveat:** the demo VITE env only reaches
  services *this run launches* — an already-up saga-dash/connect-web keeps its stale env, so
  `--reuse` presumes a previous `session-adm` bring-up.
- `--refresh-snapshot` / `--` passthrough: as `develop connect`. Media is **always synthetic**:
  the demo's Playwright project hardcodes Chromium's fake cam/mic (+ mute) in its
  launchOptions, so a camera-less box needs nothing — `--fake-media` is accepted as a no-op
  for family muscle-memory only (unlike `connect`, nothing here reads `FAKE_MEDIA`).
- **AV stays on slot 0**: `--slot N` runs all non-AV mechanics on slot N, but LiveKit/coturn
  are the shared slot-0 containers (started by `ss stack up`, not this command) — without them
  heartbeats never start and dosage never lands. Multi-only v1: the single-student sibling
  stays reachable via `ss e2e run saga-dash/connect-session-dosage`.

← [snapshots](./snapshots.md) · [e2e](./e2e.md) · [integration →](./integration.md)

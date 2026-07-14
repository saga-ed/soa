# Develop — concierge stacks for hands-on work

← [Getting started](./getting-started.md)

`ss develop <app-or-workflow>` is the **dev-setup concierge**: one command brings up the
right closure, resets + seeds it (recursing any prerequisite), and then **hands off a
running app** you can drive by hand — logged in, on the right screen, ready to work.

It is the sibling of [`ss e2e …`](./e2e.md), and the two split by intent:

| Topic | Intent | Commands |
| --- | --- | --- |
| **`develop`** | **set up + hand off** a developable stack for an app/workflow | `connect` (more coming) |
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

← [snapshots](./snapshots.md) · [e2e](./e2e.md) · [integration →](./integration.md)

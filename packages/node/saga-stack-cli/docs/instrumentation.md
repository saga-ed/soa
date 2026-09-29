# Instrumentation — CPU profiling a running service

← [Getting started](./getting-started.md)

```bash
ss stack profile iam-api                 # 15s CPU profile of a running iam-api
ss stack profile sessions-api --duration 30s
ss stack profile coach-api --out /tmp/coach.cpuprofile
```

Writes a `.cpuprofile` you can open directly in **Chrome DevTools** (Performance →
Load profile) or **VS Code**. Nothing is installed, nothing is restarted, and the
service keeps serving traffic throughout.

Drive load while it samples — a profile of an idle service is all `(idle)`:

```bash
ss stack profile iam-api --duration 20s &
# …exercise the app, run an e2e flow, click around…
```

## How it works (and why it works this way)

`profile` **attaches** to the already-running service. It does not inject anything
at launch:

1. resolve the pid **listening** on the service's port (`lsof`, the same
   `pidOnPort` the orphan-reaper uses);
2. `SIGUSR1` that pid — Node opens its V8 inspector on demand;
3. drive the Chrome DevTools Protocol (`Profiler.enable/start/stop`) and write the
   profile the target hands back.

The artifact arrives **over the wire while the process is alive**, so it does not
depend on a clean shutdown.

### Why not `--cpu-prof` or `--inspect` at launch?

Both were tried and neither works, for the same underlying reason: **the app is
never a direct child of `pnpm dev`.** 14 backends nest it inside tsup's quoted
`--onSuccess` string and 2 inside a `tsx watch` fork, so the real process sits four
levels below the pid `ss` records:

```
node pnpm dev                                   ← ss records THIS pid
 └─ sh -c tsup --watch --onSuccess "…"
     └─ node tsup/cli-default.js
         └─ /bin/sh -c cp … && node dist/main.js
             └─ node dist/main.js                ← the actual service
```

| Attempt | What happens |
| --- | --- |
| `NODE_OPTIONS="--cpu-prof"` | Every child inherits it. One run produced **53 profiles — 23 prisma, 17 pnpm, 5 tsup, 0 for the service.** `--cpu-prof` also only flushes on a clean exit, and `ss stack down` group-SIGKILLs, so the service writes nothing. |
| `pnpm dev --inspect` (argv) | **Crashes the service** — the flag reaches tsup, whose bundled `cac` rejects unknown options: `CACError: Unknown option --inspect`. |
| `NODE_OPTIONS="--inspect"` | Inherited tree-wide; the pnpm wrapper binds the port first and you attach to the package manager. |

Attach mode sidesteps all of it, and leaves the launch env **byte-identical** to a
stack without profiling.

## One service at a time, machine-wide

`SIGUSR1` always opens the inspector on Node's default port (9229) and gives no way
to choose another. Nothing injects `--inspect-port` — that's the whole point of
attach mode — so the port takes **no slot offset**: slot 2's inspector lands on 9229
exactly like slot 0's. Only one profile can be in flight on the machine at a time.

`--slot` still selects *which* service to profile; it just doesn't move the
inspector port.

Profiling the **same** service repeatedly is fine: Node leaves the inspector open
after the client disconnects, so subsequent runs re-attach to it.

Profiling a **different** service is refused while the first holds the port:

```
Error: coach-api: inspector port 9229 is held by pid 4242, not by the service.
SIGUSR1 cannot choose a port, so the service could not open its own inspector and
this profile would attach to the wrong process.
```

That refusal is the point. `inspector.open()` on a taken port does **not** throw —
it logs `Starting inspector on 127.0.0.1:9229 failed: address already in use` to the
service's own log and returns, leaving the service running with no inspector while
the profiler samples whatever *did* own the port. The capture re-checks the port's
owner after signalling for the same reason. Wait for the in-flight profile to
finish, or `ss stack down` first.

`profile` also refuses when the process holding the service's port isn't Node —
SIGUSR1 has no handler there, so signalling it would **kill** the process rather
than open an inspector.

## Reading the result

`profile` reports whether the capture actually contains the service's own frames:

```
captured 5665 samples → /tmp/sds-synthetic/iam-api-2026-08-05T20-30-30-279Z.cpuprofile
  contains frames from the service's own code.
```

If it says `WARNING: no frames from <service>'s own code`, the service was idle —
the artifact is valid but uninformative. Re-run while driving traffic. This check
exists because a wrapper-only profile (the `--cpu-prof` failure above) looks
perfectly healthy until you open it.

## Gotchas

- **Frontends aren't profilable.** `saga-dash`, `coach-web`, `connect-web` and
  `staff-admin-console` run a Vite dev server under `pnpm dev`; profiling it would
  measure the bundler. They're rejected at the argument layer.
- **A rebuild invalidates the pid.** tsup re-spawns `node dist/main.js` on every
  file save, so a profile started before a rebuild is attached to a dead process.
  Re-run after the rebuild settles.
- **`--out` is not slot-aware.** The default path lives under the slot's state dir;
  an explicit `--out` is used verbatim.

## Flags

| Flag | Meaning |
| --- | --- |
| `--duration` | how long to sample (`500ms`, `30s`, `2m`; default `15s`) |
| `--out` | artifact path (default `<state-dir>/<service>-<timestamp>.cpuprofile`) |
| `--slot N` | profile the service in slot N (the inspector port stays 9229) |
| `--output-json` / `--porcelain` | machine-readable result |

---

## Peer docs

[getting-started](./getting-started.md) · [slots](./slots.md) · [verify](./verify.md) ·
[e2e](./e2e.md) · [faq](./faq.md)

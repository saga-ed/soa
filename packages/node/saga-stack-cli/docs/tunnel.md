# Tunnel mode — share your local stack

Tunnel mode exposes the browser-facing services of your **local** stack at
`https://<svc>.<moniker>.vms.wootdev.com`, so other people (a coworker, QA, a second browser
profile) can reach the stack running on **your** machine — "dev VMs are back." The services keep
running locally under `pnpm dev` with HMR; the tunnel is a front door, not a deploy.

The canonical use case: **invite someone to test Connect with you** via a publicly-reachable URL
(`https://connect.<moniker>.vms.wootdev.com`).

## How it works (one minute)

- A tiny EC2 **rendezvous box** (`vms.wootdev.com`, `tools/synthetic-dev/vms/`) runs `frps` +
  Caddy. Your machine runs `frpc` (auto-downloaded, pinned) and reverse-tunnels each browser
  service out to `https://<svc>.<moniker>.vms.wootdev.com`.
- **Only the browser plane is tunnelled.** postgres/redis/rabbitmq/mongo get no tunnel by
  construction, so they stay unreachable. Service-to-service URLs stay `localhost`; only the
  browser-plane env flips (cookie domain, CORS, `VITE_*`/`PUBLIC_*` URLs).
- **Moniker** = your per-dev DNS namespace (standard = your initials). It lives in the gitignored
  `vendor/.vms-moniker` and is **never taken on the command line** (a placeholder in a shared
  command cross-contaminates stacks). First use prompts for it and registers it in SSM; the box
  then mints your wildcard cert `*.<moniker>.vms.wootdev.com` within ~1 minute.
- **AV (LiveKit) stays on the fleek dev cluster** (`*.fleek.wootdev.com`), NOT the tunnel. LiveKit
  is UDP and can't ride the HTTP tunnels, so a remote guest gets CRDT/chat locally (rtsm is
  websockets) but their audio/video goes through the real fleek cluster. This is deliberate.

## Prerequisites

- **AWS dev-account creds.** tunnel.sh reads `/vms/frp-token` and registers your moniker in
  `/vms/monikers`, both in the **dev** account (`396913734878`). It resolves the profile by account
  number and hard-fails if your creds land elsewhere. If you see an account-mismatch error:
  `aws sso login --profile <your-dev-profile>` (or set `AWS_PROFILE`).
- **Slot 0 only.** `--tunnel` fronts the FIXED slot-0 browser ports (dash :8900 / connect :6210 /
  iam :3010), so every `--tunnel` command hard-errors at `--slot > 0` / `--set`. Slotted tunneling
  is a separate, deferred effort.

## Bring the stack up in tunnel mode

```bash
ss stack up --tunnel --seed full --reset
```

This is fully native (no `up.sh`): it resolves your moniker via the vendored `tunnel.sh`, builds the
tunnel-aware browser-plane env for every service (incl. coach), writes the dash's tunnel routing
(`config.local.json`), brings the stack up, and — after a healthy launch+seed — starts the frpc
reverse tunnels. When it's up, `https://dash.<moniker>.vms.wootdev.com` loads, logged in.

Manage the tunnels directly (rarely needed — `up --tunnel` drives them for you):

```bash
ss stack tunnel status     # frpc process + per-URL health probes
ss stack tunnel up         # (re)attach tunnels to an already-tunnel-launched stack
ss stack tunnel down       # stop the tunnels
ss stack tunnel urls       # print the public URL table
```

## Seed launchable Connect sessions — the snapshot bridge

`ss stack up --tunnel --seed full --reset` brings the stack up **but with no launchable sessions**:
those are produced by the journey e2e, whose Playwright browsers can't be pointed at the tunnel
without a WAN hairpin (slow) and — more fundamentally — because `iam_session` has exactly one cookie
`Domain` (host-only `localhost` **or** `.<moniker>.vms.wootdev.com`, never both), so one running iam
serves the localhost journey **or** the tunnel dash, not both at once.

The fast, reliable path is the **snapshot bridge**: build the state under localhost, then carry it
across the cookie-domain boundary with a snapshot.

```bash
# 1. Build launchable sessions the fast way (localhost, no tunnel):
ss stack up --seed full --reset
ss e2e run journey --through sessions

# 2. Snapshot the built state:
ss stack snapshot store --fixture-id tunnel-demo

# 3. Bring the stack up in tunnel mode and restore:
ss stack up --tunnel --reset
ss stack snapshot restore tunnel-demo
```

> **Use `ss stack snapshot`, never the legacy `mesh-fixture-cli`.** The legacy tool dumped only 6
> postgres DBs and **omitted `sessions`** — which is exactly why a manual bridge repopulated users
> but left Demo District sessions empty. `ss stack snapshot` is manifest-driven and covers all 10
> pg DBs + the `connectv3` mongo DB (see [snapshots.md](./snapshots.md)). Keep the seed profile the
> same between build and restore (or pass `--force`) so the restore's profile guard doesn't abort.

## e2e in tunnel mode (`--tunnel`)

`ss e2e run` and `ss e2e connect` accept `--tunnel`, which resolves your moniker and points the
Playwright browser at `https://<label>.<moniker>.vms.wootdev.com` instead of localhost (the spec
`lane.ts` already reads every service URL from `PLAYWRIGHT_*_URL`, so no spec change is needed).

```bash
ss e2e connect --tunnel        # open the live Connect room, reachable at connect.<moniker>.vms…
ss e2e run journey --tunnel    # drive a whole flow over the tunnel (see the caveat below)
```

- **`ss e2e connect --tunnel`** is the concierge front door for the invite-a-coworker use case:
  it opens the live interactive-connect room and the room is reachable at
  `https://connect.<moniker>.vms.wootdev.com`. Guests authenticate at
  `https://iam.<moniker>.vms.wootdev.com/demo` as a seeded persona. Pair it with the snapshot bridge
  above so there are sessions to launch.
- **`ss e2e run … --tunnel` is the slow all-in-one.** Every request WAN-hairpins (your localhost
  Playwright → DNS → the vms box → frp → back to your localhost), so a full journey crawls and the
  timeouts stretch — `--tunnel` exports `PLAYWRIGHT_TUNNEL_TIMEOUT_MS` (consumed by the SPA's
  `playwright.config.ts`) to compensate. Prefer the snapshot bridge for seeding and reserve
  `run --tunnel` for when you specifically need the flow to execute against the tunnel.
- Both are slot-0-only, and `run --tunnel` also requires the local `stack` lane (a deployed lane
  resolves its own hostnames, so `--tunnel --lane sandbox` is rejected).

## Guest security

By design there is **no VPN and no box-level auth** in front of the wildcard hosts — the app-layer
iam demo login is the only gate. Anyone with the URL reaches the login page. (Hardening — a shared
secret / basic-auth at the box — is a possible future follow-up, not the current posture.)

## See also

- [snapshots.md](./snapshots.md) — the store/restore mechanics the bridge relies on.
- [e2e.md](./e2e.md) — flows, stages, and the live Connect session.
- `tools/synthetic-dev/vms/README.md` — provisioning the rendezvous box.

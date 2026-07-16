# Tunnel mode — share your local stack

Tunnel mode exposes the browser-facing services of your **local** stack at
`https://<svc>.<moniker>.vms.wootdev.com`, so other people (a coworker, QA, a second browser
profile) can reach the stack running on **your** machine — "dev VMs are back." The services keep
running locally under `pnpm dev` with HMR; the tunnel is a front door, not a deploy.

The canonical use case: **run a live Connect session and invite coworkers to join it** over a
publicly-reachable URL. That whole flow is the concierge below.

---

## Concierge: a live Connect session over the tunnel

From a clean machine to a running tutor + student + student Connect room that a remote coworker can
join. Run it top to bottom.

```bash
export AWS_PROFILE=dev_admin      # dev account (moniker registration + fleek A/V creds)

# 1 — Build the Empty Org + a schedule locally (fast, tested), then snapshot it:
ss stack down && ss stack up --seed full --reset
ss e2e run journey --through schedule
ss stack snapshot store --fixture-id tunnel-connect

# 2 — Bring the stack up in TUNNEL mode (fetches fleek A/V creds), then restore the org:
ss stack down && ss stack up --tunnel --reset
ss stack snapshot restore tunnel-connect

# 3 — Open the live Connect room over the tunnel. The tutor auto-hosts + STARTS the session.
#     --reuse: run against the org you just restored (don't rebuild the prerequisite).
ss develop connect --tunnel --student-login 1 --reuse   # tutor + 1 local student; 1 seat left OPEN
```

`--student-login N` = how many of the 2 students **this machine** logs in and joins locally
(`0`, `1`, or `2`; default `2` = both local). Any seat you don't fill locally stays **open** for a
remote coworker. Drop `--fake-media` (it's not on by default) — real camera/mic works via the fleek
cluster once step 2 fetched the creds.

Step 3 prints **login URLs for every participant** — share any with a coworker:

```
[interactive] ── participant logins (share any to add a remote) ──
[interactive]   TUTOR   alex.tutor@example.org  (seated locally)
[interactive]       login: https://iam.<moniker>.vms.wootdev.com/demo#auth  (devLogin as alex.tutor@example.org)  →  join: https://connect.<moniker>.vms.wootdev.com/?slsid=<id>
[interactive]   STUDENT ann.lee@example.org  (seated locally)
[interactive]       login: …
[interactive]   STUDENT cara.diaz@example.org  (OPEN — a remote can take this seat)
[interactive]       login: …  →  join: https://connect.<moniker>.vms.wootdev.com/?slsid=<id>
```

**A coworker joins** the open seat: open the `login:` URL, **devLogin** as that email (no password),
then open the `join:` URL. They land in the same room. The browsers the concierge opened stay up
until you hit Resume (▶) in the Playwright Inspector.

> Everything below is detail — how each step works and why. You don't need it to run the concierge.

---

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
  then mints your wildcard cert `*.<moniker>.vms.wootdev.com` within ~1-2 minutes.
- **A/V rides the fleek dev cluster** (`wss://*.fleek.wootdev.com`), not the tunnel (LiveKit is UDP
  and can't ride the HTTP tunnels). `up --tunnel` best-effort-fetches the cluster's LiveKit creds
  from Secrets Manager (`qboard/fleek/livekit-creds`) so connect-api signs tokens the cluster
  accepts — that's what makes **real** A/V work. CRDT/chat (rtsm, websockets) rides the tunnel.

## Prerequisites

- **AWS dev-account creds.** tunnel.sh reads `/vms/frp-token` + registers your moniker in
  `/vms/monikers`, and `up --tunnel` fetches the fleek A/V creds — all in the **dev** account
  (`396913734878`). It resolves the profile by account number and hard-fails elsewhere. If you see
  an account mismatch: `aws sso login --profile <your-dev-profile>` (or `export AWS_PROFILE=…`).
- **Slot 0 only.** `--tunnel` fronts the FIXED slot-0 browser ports (dash :8900 / connect :6210 /
  iam :3010), so every `--tunnel` command hard-errors at `--slot > 0` / `--set`.

## Why the two-phase build (step 1 + 2)

`iam_session` has exactly one cookie `Domain` — host-only `localhost` **or** `.<moniker>.vms…`,
never both — so one running iam serves the localhost journey **or** the tunnel dash, not both. The
concierge therefore **builds the org under localhost** (where the tested journey is fast and
reliable), snapshots it, then **restores it under the tunnel** cookie domain. The Connect room
itself doesn't need a pre-launched dash session: `ss develop connect` reads the schedule, **starts the
occurrence via `sessions.start`**, and everyone joins — so `--through schedule` is enough (no need
for the `sessions`/`attendance` stages, which would leave today's occurrence `Ended`).

> **Use `ss stack snapshot`, never the legacy `mesh-fixture-cli`.** The legacy tool dumped only 6
> postgres DBs and **omitted `sessions`**. `ss stack snapshot` is manifest-driven and covers all 10
> pg DBs + the `connectv3` mongo DB (see [snapshots.md](./snapshots.md)).

## Bringing the stack up in tunnel mode (`up --tunnel`)

`ss stack down && ss stack up --tunnel --reset` is fully native (no `up.sh`): it resolves your
moniker via the vendored `tunnel.sh`, builds the tunnel-aware browser-plane env for every service
(incl. coach), writes the dash's tunnel routing (`config.local.json`), fetches the fleek A/V creds,
launches the stack, and starts the frpc reverse tunnels.

The dash's tunnel routing rides **two channels** (soa#328): the same JSON is also injected into
saga-dash's launch env as `DASH_CONFIG_LOCAL_JSON`, which a new-enough saga-dash dev server serves
back for `GET /config.local.json` — per-instance routing that doesn't depend on the shared static
file. The `config.local.json` file write remains as transitional back-compat for older saga-dash
checkouts (the env injection also covers non-tunnel `--slot N` lanes; slot-0 non-tunnel injects
nothing).

Because the env **shadows** the file in a new-enough dash, a still-running dash from a different
mode can no longer self-heal by re-reading (or missing) the file — so `DASH_CONFIG_LOCAL_JSON` is
an `adoptEnv` guard key (the soa#305 mechanism): `up` refuses to adopt an already-healthy dash
whose stamped routing env doesn't match the current mode (tunnel → plain `up`, a changed moniker,
a different mode in the same slot) and asks you to stop it and re-run, instead of silently leaving
it dialing dead tunnel hosts. One-time cost: the first new-CLI `up` over a dash launched by an
older build (no stamp) is refused the same way — stop the dash (or `ss stack down`) and re-run.

The leading `ss stack down` is **part of the instruction**: `up --tunnel` skips any service whose
port is already healthy, so a stack already up in localhost mode would keep its non-tunnel env —
most visibly iam would set a **host-only** `iam_session` cookie and the dash couldn't hold the
session across the API subdomains. `down` guarantees every service (re)launches under the tunnel
env; on a cold machine it's a harmless no-op.

_Verify the relaunch took:_ the `iam_session` `Set-Cookie` should carry
`Domain=.<moniker>.vms.wootdev.com`. A host-only cookie means a service didn't relaunch — `down`
again and re-up.

Manage the tunnels directly (rarely needed — `up --tunnel` drives them):

```bash
ss stack tunnel status     # frpc process + per-URL health probes
ss stack tunnel up|down    # (re)attach / stop the tunnels
ss stack tunnel urls       # print the public URL table
```

## `ss e2e … --tunnel`

`ss e2e run` and `ss develop connect` accept `--tunnel`, which resolves your moniker and points the
Playwright browser at `https://<label>.<moniker>.vms.wootdev.com` instead of localhost.

- **`ss develop connect --tunnel`** — the concierge front door (step 3). `--student-login N` sets how
  many students join locally; `--fake-media` swaps in a synthetic camera/mic (drop it for real
  A/V). The tutor always auto-hosts and starts the session. slot-0 only.
- **`ss e2e run … --tunnel`** is the slow all-in-one: every request WAN-hairpins (localhost →
  vms box → frp → localhost), so a full journey crawls; it exports `PLAYWRIGHT_TUNNEL_TIMEOUT_MS`
  for the SPA's `playwright.config.ts`. Prefer the snapshot bridge (step 1) for seeding. slot-0 +
  local `stack` lane only (`--tunnel --lane sandbox` is rejected).

## Login credentials

Log in at `https://iam.<moniker>.vms.wootdev.com/demo#auth` via **devLogin** (enter the email, no
password). The `@saga.org` seed aliases also accept the shared dev password **`password123`**; the
`@example.org` roster users are provisioned by the journey, so use **devLogin** for them.

The Connect room seats these Empty Org personas (the concierge prints their login URLs):

| Role | Email | Login |
|------|-------|-------|
| **Tutor / host** | `alex.tutor@example.org` | devLogin |
| Student | `ann.lee@example.org` | devLogin |
| Student | `cara.diaz@example.org` | devLogin |
| Org admin (opt.) | `empty@saga.org` | devLogin or `password123` |

All three room personas are in the same pod (Math 101 + Reading 201). `empty@saga.org` is the Empty
Org admin (opt-in observer via `IN_ROOM_OBSERVER=1`); `dev@saga.org` is the *seed*-district admin, a
different org. Full roster: `saga-dash` `e2e/data/fixtures/example-roster.csv`.

> The `demo-dadmin` / `demo-lead-north` / `demo-student-*` accounts exist and can log in, but under
> `ss` they have **no sessions** — `--seed full` runs the canonical projection bake, not up.sh's
> `SEED_DEMO_ONLY` demo-session lane. Launchable sessions come from the journey / Empty Org.

## A/V

Real camera/mic works when `up --tunnel` fetched the fleek cluster creds (needs dev creds; it warns
if it couldn't and connect-api falls back to the dev key, which the cluster rejects → A/V fails but
CRDT/chat still work). Use `--fake-media` on `ss develop connect` for a synthetic camera/mic (a machine
with no camera, or where `v4l2loopback` won't build). A/V always routes through the fleek dev
cluster, never the tunnel.

## Guest security

By design there is **no VPN and no box-level auth** in front of the wildcard hosts — the app-layer
iam demo login is the only gate. Anyone with the URL reaches the login page. (Hardening — a shared
secret / basic-auth at the box — is a possible follow-up, not the current posture.)

## See also

- [snapshots.md](./snapshots.md) — the store/restore mechanics the bridge relies on.
- [e2e.md](./e2e.md) — flows, stages, and the live Connect session.
- `tools/synthetic-dev/vms/README.md` — provisioning the rendezvous box.

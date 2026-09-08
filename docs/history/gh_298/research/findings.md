# gh_298 — ss Tunnel Mode: research findings

_Research date: 2026-07-13. Sources: soa#156 (original), soa#214/#221/#271/#224 (ss port),
Jeff Ward Slack (G01CQ6UPB0E threads 2026-06-12 and 2026-07-10 `tunnel_info.md`)._

## TL;DR — this is a *finish + verify*, not a *port from scratch*

Tunnel mode is **already ported to `ss` and merged on `main`**. The original up.sh feature
(soa#156, merged 2026-06-15) was carried into `saga-stack-cli` by the soa#214/#221 "decouple"
work (Phase 1 = vendor the scripts, Phase 2 = native overlays). What remains are **three** gaps
(count corrected by the ultracode validation pass — see `validation-report.md`):

1. **Vendored `tunnel.sh` drift** — coach missing from the vendored SERVICES table.
2. **coach browser-plane overlay missing from the TypeScript** — `coach-api`/`coach-web` fall
   through to `default:{}` in `launch-plan.ts:375`, so ss never sets coach's tunnel CORS /
   `PUBLIC_COACH_API_URL` / Vite allowed-hosts. **Distinct from #1** — re-vendoring the script
   fixes frpc plumbing but leaves coach CORS-rejected + Vite-403'd. This is the gap my first
   pass missed.
3. **No `ss e2e … --tunnel`** — the capability Jeff called out for the Connect use case.

> ⚠️ The original "exactly two gaps" thesis was **refuted as stated** by validation. Details,
> per-service parity table, and the e2e implementation surface map are in
> `research/validation-report.md`.

## What tunnel mode is (original design, soa#156)

- Reverse-tunnels the browser-facing local services out to
  `https://<svc>.<moniker>.vms.wootdev.com` via **frp → a small EC2 rendezvous box**
  (`vms.wootdev.com`, ~$16/mo, `vms/template.yaml`). "Dev VMs are back."
- **Moniker** = per-dev DNS namespace (initials), stored in gitignored `.vms-moniker`,
  **never taken on the CLI** (a placeholder in a shared command cross-contaminates stacks).
  First use prompts + registers it in SSM `/vms/monikers`; the box mints a wildcard cert
  `*.<moniker>.vms.wootdev.com` within ~1 min.
- **Two planes.** Only the browser plane is tunnelled; postgres/redis/rabbitmq/mongo get no
  tunnel by construction. `tunnel_env()` flips ONLY browser-plane env (cookie domain, CORS,
  `VITE_*` URLs); service-to-service URLs stay `localhost`.
- **LiveKit/AV stays on the fleek dev cluster** (`*.fleek.wootdev.com`) — LiveKit is UDP and
  can't ride the HTTP tunnels. This is deliberate and is why remote guests get CRDT/chat
  (rtsm = websockets) locally but AV via the real cluster.
- **Companion deps (all MERGED):** soa-api-util CORS allowlist in rostering#533,
  program-hub#198, student-data-system#162, qboard#183; saga-dash#194 `url`-type override +
  `config.local.json` local-override seam. ✅ verified merged 2026-07-13.

## Current state of the `ss` port (what already works)

| Capability | Status | Where |
|---|---|---|
| `ss stack tunnel <up\|down\|status\|moniker\|urls\|aws-profile>` | ✅ done | `src/commands/stack/tunnel.ts` — thin wrapper over the **vendored** `tunnel.sh` |
| `ss stack up --tunnel` (native, no up.sh) | ✅ done | `src/commands/stack/up.ts` — resolves moniker, builds `tunnel_env` browser-plane overlay, generates `rtsm-fleet-tunnel.json`, then runs vendored `tunnel.sh up` after a healthy launch |
| moniker resolve + rtsm fleet gen | ✅ done | `src/runtime/tunnel-prep.ts` (`resolveTunnelMoniker`, `generateTunnelFleetConfig`) |
| slot-0-only guard for `--tunnel` | ✅ done | up.ts:209 — `--tunnel` fronts FIXED slot-0 browser ports; refuses slot>0 |
| dash `config.local.json` tunnel routing | ✅ (in up.sh; verify native parity) | up.sh `sync_dash_local_defaults`; confirm ss `dash-defaults.ts` writes the url-type file under `--tunnel` |

Merged commits: `4327971` (Phase 1 vendor), `519b720` (Phase 2 native `--tunnel`),
`105bc04` (per-slot rtsm, soa#271), `80a2d0e`/#224 (wire coach into tunnel mode).

## Gap 1 — vendored `tunnel.sh` drift (small, mechanical)

`tools/synthetic-dev/tunnel.sh` (source) has coach wired in (soa#224, commit `80a2d0e`) but the
CLI's **vendored copy is stale**:

```
diff tools/synthetic-dev/tunnel.sh vendor/tunnel.sh
< "coach:8800"          # missing from vendored SERVICES table
< "coach-api:6105"      # missing from vendored SERVICES table
< …|| coach …           # missing coach branch in the status health-probe
```

Effect: `ss stack tunnel` / `ss stack up --tunnel` will **not tunnel coach**. Fix = re-vendor
(there is a vendor sync path in `src/runtime/vendor.ts`). Verify no other drift crept in.

## Gap 2 — no `ss e2e … --tunnel` (the real Connect blocker)

This is the crux of Jeff's 2026-07-10 `tunnel_info.md`. `ss stack up --tunnel --seed full --reset`
brings the stack up logged in as `demo-dadmin@saga.org`, **but with no launchable sessions** — so
the invite-a-coworker-to-Connect use case has nothing to launch.

- Sessions are produced by running the **journey e2e** (`ss e2e run journey --through sessions`).
- That fails in tunnel mode because the journey's Playwright browsers hit **localhost https URLs**
  that aren't served. The specs already read every URL from `PLAYWRIGHT_*_URL` env
  (`e2e/fixtures/lane.ts`), so **no test-code change is needed** — the only missing piece is a
  `--tunnel` flag on `ss e2e run` that resolves the moniker and sets the ~12 `PLAYWRIGHT_*_URL`
  keys to `https://<svc>.<moniker>.vms.wootdev.com`.
- Hook point in the ss code: `e2e-orchestrate.ts` → `PLAYWRIGHT_SERVICE_URL_ENV` map +
  `serviceUrlEnv(ports)` (currently `http://localhost:<port>`) consumed by `playwrightEnv()`.
  A tunnel variant returns `https://<label>.<domain>` for the same keys.

### The hard constraints (why this isn't free) — from Jeff, verified against the code

1. **One iam, one cookie domain.** `iam_session` has exactly one `Domain` — host-only `localhost`
   OR `.<moniker>.vms.wootdev.com`, never both. A single running iam serves the localhost journey
   **or** the tunnel dash, not both at once. This is *why the snapshot bridge exists* (build under
   one cookie domain, use under the other) — not a patchable plumbing bug.
2. **WAN hairpin ⇒ slow + flaky.** A tunnel journey routes localhost Playwright → DNS → vms EIP →
   frp → back to localhost. Hundreds of requests ⇒ much slower; 120s timeouts need bumping. You
   can't shortcut with `/etc/hosts → 127.0.0.1` (cert is for `*.vms…`, local services speak plain
   HTTP). So the **non-tunnel-build → snapshot → restore-under-tunnel path stays the fast one.**
3. Jeff tried the snapshot bridge manually and Demo District sessions **did not** populate — worth
   reproducing to find whether that's a fixture-domain issue vs a snapshot-scope issue.

## Recommended shape (informs the plan)

- **Slot 0 first** (prompt's guidance + `--tunnel` is already slot-0-only by design — fixed
  browser ports). Slot 1..N is a later, separate problem (needs per-slot monikers/hostnames or a
  port-mux on the box; out of scope for v1).
- Add `--tunnel` to `ss e2e run` (and thread it into `ss e2e connect`, the concierge flow) so the
  whole invite-a-coworker flow is one command. Accept the slow-journey tradeoff, OR prefer the
  snapshot bridge and only tunnel the *live* connect room. Decide in the plan.

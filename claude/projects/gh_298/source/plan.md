# gh_298 — ss Tunnel Mode: plan

_See `../research/findings.md` for the evidence behind every claim here._

## Goal

Bring tunnel mode to the `ss` synthetic-dev CLI and verify it functions identically to up.sh's
`--tunnel`, driven by the real use case: **Jeff invites coworkers to test Connect via a
publicly-reachable URL against his local stack.** Slot 0 first; slot 1..N deferred.

## Reframing (important)

Tunnel mode is **already ported and merged** (soa#214/#221). `ss stack up --tunnel` and
`ss stack tunnel <verb>` exist and are native. So this is **not** a from-scratch port — it's
**close a drift, close one capability gap, then verify parity end-to-end**. That materially
shrinks the work.

---

## Phase 0 — Verify the existing port actually works (½ day)

Before building anything, confirm the merged `ss` tunnel path reaches the same state up.sh did.

1. Bring up the reference (up.sh) once for the golden baseline (Jeff's command):
   `./up.sh up --tunnel --seed full --reset --login demo-dadmin@saga.org` → note `dash.<moniker>.vms…`
   loads, logged in, sessions launchable.
2. Bring up the `ss` path: `ss stack up --tunnel --seed full --reset` (slot 0).
3. Compare, per browser-facing service: the emitted `tunnel_env` (cookie domain, CORS, `VITE_*`),
   the generated `rtsm-fleet-tunnel.json`, and the dash `config.local.json`. A diff harness
   (dump both env sets, normalize, compare) makes "functions identically" a checkable claim.
4. Confirm `ss stack tunnel status` shows all services green **except** the known coach gap
   (Phase 1) and AV (by-design fleek).

**Exit:** documented parity table; any env divergence filed as its own fix.

## Phase 1 — Fix vendored `tunnel.sh` drift (½ day)

- Re-vendor `tools/synthetic-dev/tunnel.sh` → `packages/node/saga-stack-cli/vendor/tunnel.sh`
  (adds `coach:8800`, `coach-api:6105`, and the coach status-probe branch — soa#224 that never
  got re-vendored). Use the existing `src/runtime/vendor.ts` sync path, not a hand-edit.
- Add a **drift guard**: a unit/CI check that fails when `vendor/tunnel.sh` ≠ source (so this
  can't silently rot again). This is the root cause of Gap 1, worth preventing structurally.
- Verify coach tunnels: `ss stack up --with coach --tunnel` → `coach.<moniker>.vms…` serves.

**Exit:** vendored copy matches source; drift guard green; coach reachable through the tunnel.

## Phase 2 — `ss e2e run --tunnel` (the Connect enabler) (1–1.5 days)

The missing capability. No test-code change — the specs already read `PLAYWRIGHT_*_URL`.

- Add `--tunnel` boolean to `src/commands/e2e/run.ts`. Guard slot-0-only (same rationale as
  `up --tunnel`: fixed browser ports front the box).
- In `e2e-orchestrate.ts`, add a tunnel variant of `serviceUrlEnv(ports)` that, given the
  resolved moniker domain, returns `https://<label>.<domain>` for each `PLAYWRIGHT_*_URL` key
  instead of `http://localhost:<port>`. Reuse `resolveTunnelMoniker` from `runtime/tunnel-prep.ts`.
  Thread it through `playwrightEnv()` (the tunnel URLs overlay where `serviceUrlEnv` does today).
- Bump Playwright timeouts under `--tunnel` (WAN hairpin — findings §hard-constraint-2). Gate the
  bump on the flag so localhost runs are unchanged.
- Unit tests: `--tunnel` emits `https://<svc>.<domain>` for all keys; absent → byte-identical to
  today; slot>0 + `--tunnel` errors.

**Exit:** `ss stack up --tunnel …` then `ss e2e run journey --through sessions --tunnel` yields
launchable sessions on `dash.<moniker>.vms…` in one path (slow but correct).

## Phase 3 — Wire tunnel into the Connect concierge flow (0.5–1 day)

Last week's `ss e2e connect` is the natural front door for the use case.

- Add `--tunnel` to `src/commands/e2e/connect.ts`, threading into the same moniker-resolve +
  URL-overlay from Phase 2, so `ss e2e connect --tunnel` opens the live room **and** the room is
  reachable at `connect.<moniker>.vms…` for invited guests.
- **Decide the seeding strategy (open question — see below).** Recommended default: keep the
  *build* under localhost (fast journey), then **snapshot → restore under the tunnel cookie
  domain**, and only run the *live* room over the tunnel. `--tunnel` on `e2e run` stays available
  as the slow all-in-one for when the bridge misbehaves.
- Reproduce Jeff's "Demo District sessions didn't populate after snapshot-restore" (findings
  §hard-constraint-3) and root-cause: is it snapshot scope, or fixtures that bake the localhost
  cookie/URL domain? Fix whichever it is — this is what actually unblocks Jeff.

**Exit:** `ss e2e connect --tunnel` gives Jeff a `connect.<moniker>.vms…` URL to share, backed by
launchable Demo District sessions, with a documented one-command recipe.

## Phase 4 — Docs + verification (0.5 day)

- Update the `saga-iac:ss` skill reference + `docs/` e2e ladder to cover `--tunnel` on
  `up` / `e2e run` / `e2e connect`, the AV-on-fleek caveat, and the snapshot-bridge recipe.
- Run `/code-review` and `/verify` on the diff before the PR.

## Slot 1..N (explicitly deferred)

`--tunnel` is slot-0-only by construction (fixed browser ports front the box). Slotted tunneling
needs either per-slot monikers/hostnames (`<svc>-s<N>.<moniker>.vms…` + box-side cert/routing) or
a port-mux, plus per-slot `iam_session` cookie-domain handling. Real scope, separate effort —
capture as a follow-up issue once slot-0 lands.

---

## Effort: ~3–4 focused days, sequenced so each phase ships independently.

## Decisions (resolved with Sean, 2026-07-13)

1. **Seeding strategy → snapshot bridge (default).** Build under localhost (fast journey),
   snapshot, restore under the tunnel cookie domain, tunnel only the live room. `ss e2e run
   --tunnel` (Phase 2) still ships as the slow all-in-one escape hatch. **Consequence:** Phase 3
   MUST root-cause Jeff's "Demo District sessions didn't populate after snapshot-restore" — the
   bridge is the happy path, so that bug is now on the critical path, not a nice-to-have.
2. **Guest auth → tunnelled iam demo login.** Invited coworkers hit
   `https://iam.<moniker>.vms.wootdev.com/demo` and log in as a seeded persona. No per-guest jar
   distribution. The concierge flow just hands out the `connect.<moniker>.vms…` URL; the demo
   login page is the gate. (Confirms the existing `tunnel_env` `MAIL_FRONTEND_BASE_URL` /
   `JANUS_LOGIN_HOST` → tunnelled iam demo wiring is the right target.)
3. **Security posture → keep open (v1).** No VPN, no box-level auth — matches what Jeff
   deliberately shipped. App-layer iam demo login is the only gate. Hardening (shared
   secret / basic-auth at the box) is a deliberate follow-up, not v1 scope.

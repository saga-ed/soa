# gh_298 — ss Tunnel Mode: plan

_See `../research/findings.md` for the evidence behind every claim here._

## Goal

Bring tunnel mode to the `ss` synthetic-dev CLI and verify it functions identically to up.sh's
`--tunnel`, driven by the real use case: **Jeff invites coworkers to test Connect via a
publicly-reachable URL against his local stack.** Slot 0 first; slot 1..N deferred.

## Reframing (important)

Tunnel mode is **already ported and merged** (soa#214/#221). `ss stack up --tunnel` and
`ss stack tunnel <verb>` exist and are native. So this is **not** a from-scratch port — it's
**close the gaps, then verify parity end-to-end**. That materially shrinks the work.

The ultracode validation pass (`research/validation-report.md`) **refuted the original "exactly
two gaps" thesis**: there are **three** — (1a) vendored `tunnel.sh` drift, (1b) coach missing from
the TypeScript browser-plane overlay (`launch-plan.ts:375`), (2) no `ss e2e --tunnel`. The
snapshot-bridge failure Jeff hit is also root-caused below (legacy `mesh-fixture-cli` omits the
`sessions` DB). Phases and exit criteria below reflect those corrections.

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

## Phase 1a — Fix vendored `tunnel.sh` drift (½ day)

- Re-vendor `tools/synthetic-dev/tunnel.sh` → `packages/node/saga-stack-cli/vendor/tunnel.sh`
  (adds `coach:8800`, `coach-api:6105`, and the coach status-probe branch — soa#224 that never
  got re-vendored). Use the existing `src/runtime/vendor.ts` sync path, not a hand-edit.
- Add a **drift guard SCOPED TO `tunnel.sh` ONLY**: a unit/CI check that fails when
  `vendor/tunnel.sh` ≠ source. Do NOT make it directory-wide — `refresh-suite.sh` and
  `.gitignore` under `vendor/` are **intentionally forked** from source and would false-positive.
- This fixes the **frpc reverse-tunnel plumbing** for coach, but NOT coach's browser-plane env
  (see 1b) — so on its own it does not make coach reachable.

**Exit:** vendored copy matches source; tunnel.sh-scoped drift guard green.

## Phase 1b — Add coach to the TypeScript browser-plane overlay (½ day) — NEW, thesis-breaking

Validation found a **third gap the "two gaps" thesis missed**: `coach-api`/`coach-web` fall through
to `default: return {}` at `launch-plan.ts:375`, so the ss native `--tunnel` overlay never sets
coach's browser-plane env. Three live parity breaks vs `up.sh tunnel_env` (`up.sh:1440-1454`):

1. `coach-web PUBLIC_COACH_API_URL=https://coach-api.<domain>` (SvelteKit `PUBLIC_`, compile/serve
   -time) — without it a remote browser dials `localhost:6105` and can't reach coach-api at all.
2. `coach-web __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=coach.<domain>` — without it Vite's dev-server
   host check 403s the tunnel `Host` and the page won't load.
3. `coach-api EXPRESS_SERVER_CORSALLOWEDDOMAINS += <bare domain>` — without it the remote origin is
   CORS-rejected.

- **Fix trap:** do NOT derive coach hosts from manifest `tunnelSlug` (which is `coach-web`).
  up.sh uses label `coach` for coach-web's allowed-host, `coach-api` for the API URL, and the
  **bare** `$TUNNEL_DOMAIN` for coach-api CORS. A slug-driven impl re-diverges to
  `coach-web.<domain>`.
- Add explicit coach cases to `tunnelOverlay()` (`launch-plan.ts`) + **coach assertions** to
  `launch-plan.overlay.unit.test.ts` (today it has none — nothing guards this regression).

**Exit (moved here from old Phase 1):** `ss stack up --with coach --tunnel` → `coach.<moniker>.vms…`
serves and its API is reachable/CORS-clean.

## Phase 2 — `ss e2e run --tunnel` (the Connect enabler) (1–1.5 days)

The missing capability. **Mostly** no test-code change — the specs read `PLAYWRIGHT_*_URL` — but
this is an assumption to **confirm in saga-dash `lane.ts`** (not in this repo), not a fact. Surface
map is exact: see `research/validation-report.md §4`.

- Add `--tunnel` boolean to `src/commands/e2e/run.ts` (mirror on `connect.ts`). Guard slot-0-only
  (same rationale as `up --tunnel`; the single `flags.slot>0` check also covers `--set`).
- Resolve moniker→domain by **reusing the existing `up --tunnel` machinery** verbatim:
  `getTunnelMoniker()(resolveVendorScript('tunnel.sh'))` → `<moniker>.<VMS_BASE>` (seam at
  `base-command.ts:528` → `runtime/tunnel-prep.ts:34`). Thread it after `deriveInstance`, before
  `buildStackContext`.
- **`buildStackContext` hardcodes `tunnel:false` (`e2e-orchestrate.ts:284`)** — add an optional
  `tunnelDomain?` param and set `tunnel: tunnelDomain!==undefined, tunnelDomain`. The facade
  (`stack-api.ts:850-863`) already reads these → dash `config.local.json`; **no facade change**.
- **Labels are NOT string-derivable from ServiceIds** (`saga-dash→dash`, `connect-web→connect`,
  `ads-adm-api→ads-adm`, most drop `-api` but `connect-api` keeps it). Add an explicit frozen
  `TUNNEL_SERVICE_LABELS` map keyed to `vendor/tunnel.sh` SERVICES, plus `tunnelServiceUrlEnv(domain)`;
  wire into `playwrightEnv` (overlay line ~:456, must beat `flow.env`) and `describeResolved` so
  `--dry-run` prints the `https://` URLs.
- **Timeout — the prober needs NO bump** (services still bind localhost under tunnel; only the
  Playwright *browser* hairpins). Export a net-new env (e.g. `PLAYWRIGHT_TUNNEL_TIMEOUT_MS`) from
  `playwrightEnv` when `tunnelDomain` set; the actual timeout is consumed **cross-repo in saga-dash
  `playwright.config.ts`** (`navigationTimeout`/`actionTimeout`/`timeout`) — confirm the exact env
  name there before finalizing.
- Unit tests: `--tunnel` emits `https://<label>.<domain>` for all keys; absent → byte-identical to
  today; slot>0 + `--tunnel` hard-errors; **new `tunnel-service-labels.unit.test.ts`** asserting
  every `PLAYWRIGHT_SERVICE_URL_ENV` ServiceId has a label and each label is a real `tunnel.sh`
  SERVICES entry (catches label↔SERVICES drift).

**Exit:** `ss stack up --tunnel …` then `ss e2e run journey --through sessions --tunnel` yields
launchable sessions on `dash.<moniker>.vms…` in one path (slow but correct).

## Phase 3 — Wire tunnel into the Connect concierge flow (0.5–1 day)

Last week's `ss e2e connect` is the natural front door for the use case.

- Add `--tunnel` to `src/commands/e2e/connect.ts`, threading into the same moniker-resolve +
  URL-overlay from Phase 2, so `ss e2e connect --tunnel` opens the live room **and** the room is
  reachable at `connect.<moniker>.vms…` for invited guests.
- Seeding strategy = **snapshot bridge** (decided): build under localhost (fast journey), snapshot,
  restore under the tunnel cookie domain, tunnel only the live room. `--tunnel` on `e2e run` stays
  available as the slow all-in-one escape hatch.
- **Root cause of Jeff's "Demo District sessions didn't populate" is now KNOWN (HIGH confidence),
  so this phase is confirm-and-fix, not investigate** (`validation-report.md §5`): the manual
  bridge used the legacy `mesh-fixture-cli`, whose hardcoded DB list dumps only 6 postgres DBs and
  **omits `sessions`** (+ no mongo). Demo District sessions live in the `sessions` projection DB →
  never dumped → never restored, while `iam_local` users repopulate. Exactly Jeff's symptom.
  - **Fix:** the bridge MUST use `ss stack snapshot store/restore` (new default set covers all 10
    pg DBs + `connectv3` mongo, `core/snapshot/plan.ts:144-171`), **never** `mesh-fixture-cli`.
  - Keep `SEED_PROFILE` identical between build and restore (or `--force`) so the all-or-nothing
    profile guard (`restore.ts:120-127`) doesn't silently abort.
  - Confirm on a live box with the exact psql/manifest checks in `validation-report.md §5`.
- **Separate "list populates" from "room joins".** The bridge fixes the session *list*
  (domain-independent projection data); *joining* a live room relies on Phase 1's launch-time
  overlay (cookie domain, connect-web `VITE_*`). connect-web's overlay is present and matches
  (parity ✓), but tie this exit to **Phase 1b** so a coach-style omission can't strand room-join.
- Guest auth = **tunnelled iam demo login** (decided): the flow hands out the
  `connect.<moniker>.vms…` URL; guests log in at `iam.<moniker>.vms…/demo` as a seeded persona.

**Exit:** `ss e2e connect --tunnel` gives Jeff a `connect.<moniker>.vms…` URL to share, backed by
launchable Demo District sessions (via `ss stack snapshot` bridge), with a documented one-command
recipe.

> **Re-sequencing:** because the root cause is known, run the Phase 3 reproduction **in parallel
> with Phases 1–2**, not last. Also note (`§6 item 8`): the frpc reverse tunnels fire at
> `up.ts:587` only under `if (overlays.tunnel && seeded.ok)` — stricter than first stated (needs a
> healthy seed). On the restore path, confirm `seeded.ok` is true post-restore or frpc silently
> won't come up.

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

## Effort: ~3–4 focused days (phases 0, 1a, 1b, 2, 3, 4).

The new Phase 1b adds ~½ day, but Phase 3 shrinks (root cause already known), so the total is
roughly net-neutral. Each phase still ships independently; run the Phase 3 reproduction in
parallel with 1–2.

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

# gh_298 — ss Tunnel Mode: plan validation (ultracode pass)

## 1. Verdict on the thesis

**Refuted as stated.** The plan's thesis — "already ported + exactly TWO gaps (vendored `tunnel.sh` drift; no `ss e2e --tunnel`)" — is directionally right on "already ported" (native bring-up, `stack tunnel` wrapper, dash `config.local.json` writer, and 10/12 browser-plane env overlays are all confirmed against `up.sh`) but **wrong on the gap count**. There is a **third, independent gap**: coach's browser-plane `tunnel_env` is missing from `launch-plan.ts` (`coach-api`/`coach-web` fall through to `default: return {}` at `launch-plan.ts:375`). This is a code gap in the TS overlay, not vendored-script drift, so re-vendoring `tunnel.sh` (the plan's Phase 1) fixes the frpc reverse-tunnel plumbing but leaves coach CORS-rejected and its Vite host-check 403'd — meaning **Phase 1's own exit criterion ("coach reachable through the tunnel") is unachievable as scoped.** Correct count: (1a) `tunnel.sh` drift, (1b) coach overlay, (2) `ss e2e --tunnel`.

## 2. Claim verification table

| # | Claim | Verdict | One-line evidence |
|---|-------|---------|-------------------|
| 1 | `ss stack up --tunnel` is fully native (no `up.sh` shell-out for bring-up) | **SUPPORTED** | `up.ts:492-495` native `api.up(services)`; moniker via vendored `tunnel.sh` (`up.ts:301`, `base-command.ts:528-530`); overlay `launch-plan.ts:314-375`; frpc only at `up.ts:587-592` |
| 2 | `ss stack tunnel <verb>` runs the VENDORED `tunnel.sh`, not `tools/synthetic-dev/tunnel.sh` | **SUPPORTED** | `tunnel.ts:71` `resolveVendorScript('tunnel.sh')` → `vendor.ts:37-51` walks to `<pkg>/vendor/tunnel.sh`; file exists (12951 B, exec) |
| 3 | Drift source↔vendored `tunnel.sh` is EXACTLY coach:8800/coach-api:6105 SERVICES entries + coach status-probe branch | **SUPPORTED** | Full `diff` = 3 hunks, all coach: `67,68d66` + `255c253` (`\|\| coach` dropped); 271 vs 269 lines |
| 4 | NO `--tunnel` flag on ANY `ss e2e` command (run/connect/list/traces) | **SUPPORTED** | Exhaustive grep `/tunnel/i` over `commands/e2e/` = 0 matches; flag sets enumerated `run.ts:68-141` etc.; `baseFlags` (`shared-flags.ts:111-160`) has none |
| 5 | `serviceUrlEnv`/`playwrightEnv` is the e2e `--tunnel` hook; tunnel variant emits `https://label.domain` on same `PLAYWRIGHT_*_URL` keys, no spec change | **PARTIAL** | Producer side supported (`e2e-orchestrate.ts:400-407`,`453-458`); but labels≠ServiceIds (needs new map), only dash/iam/connect/connect-api/rtsm have hosts, `buildStackContext` hardcodes `tunnel:false` (`:284`), `run.ts` lacks flag; "no spec change" depends on saga-dash `lane.ts` (not in repo) |
| 6 | Native `--tunnel` writes dash `config.local.json` url-type localDefaults matching `up.sh sync_dash_local_defaults` | **SUPPORTED** | `dash-defaults.ts:122-128` byte-equiv to `up.sh:1486-1487`; identical `DASH_TUNNEL_LABELS` (`:34-43` vs `up.sh:1482-1487`); wired `stack-api.ts:851-863` |
| 7 | `--tunnel` guarded slot-0-only for `up`; e2e would need same guard | **SUPPORTED** | Guard `up.ts:209-214`; e2e has no flag so needs none today, but shares fixed slot-0 browser ports → would need identical guard if flag added |
| 8 | OTHER vendored artifacts NOT drifted; `tunnel.sh` is the only stale one | **PARTIAL** | `tunnel.sh` is the only *stale* one (correct practical conclusion); but `refresh-suite.sh` + `.gitignore` are *intentionally forked* from source (not textually identical), and the named `compose-rest` file **does not exist** under `vendor/` |

## 3. Parity risks (up.sh `tunnel_env` vs ss `tunnelOverlay`) — most severe first

Source: `up.sh:1367-1457` vs `launch-plan.ts:314-377`. 10/12 match exactly; the two breaks are both coach and both live (launched, non-optional/browser-facing services).

1. **coach-web `PUBLIC_COACH_API_URL` (SEV: highest, browser cannot reach API).** `up.sh:1453` sets `https://coach-api.$TUNNEL_DOMAIN`; ss drops it (`launch-plan.ts:375` default). Base stays `http://localhost:6105` (`services.ts:531`) — a SvelteKit `PUBLIC_` (compile/serve-time) var, so a remote browser is pointed at localhost and cannot dial coach-api at all.
2. **coach-web `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` (SEV: page won't load).** `up.sh:1454` sets `coach.$TUNNEL_DOMAIN`; ss drops it → Vite dev-server DNS-rebind host check 403s the tunnel `Host` header, so the coach-web page itself fails to load.
3. **coach-api `EXPRESS_SERVER_CORSALLOWEDDOMAINS` (SEV: API CORS-rejected).** `up.sh:1447` appends bare `$TUNNEL_DOMAIN` to the allow-list; ss keeps base `${COACH_WEB_HOST}` only (`services.ts:505`) → remote browser from `coach.<moniker>.vms…` is CORS-rejected.
4. **rtsm-api `FLEET_CONFIG_PATH` shape (SEV: low, note only).** `up.sh` always sets it in tunnel mode (`up.sh:2321-2330`); ss emits only if `TUNNEL_RTSM_FLEET_PATH` token present (`launch-plan.ts:367-369`). Functionally equivalent on the native path (token wired from fleet-gen), but ss silently drops the key if fleet-gen is ever skipped.

**Fix trap (record in plan):** do NOT derive coach hosts from manifest `tunnelSlug` (which is `coach-web`, `services.ts:536`). `up.sh` uses label `coach` for coach-web's allowed-host, `coach-api` for the API URL, and the **bare** `$TUNNEL_DOMAIN` for coach-api CORS. A slug-driven impl re-diverges to `coach-web.$TUNNEL_DOMAIN`. The overlay unit test `launch-plan.overlay.unit.test.ts` has **no coach assertions** — nothing guards this regression.

## 4. e2e `--tunnel` implementation surface

All paths under `packages/node/saga-stack-cli/`. Reuses the existing `up --tunnel` machinery (`getTunnelMoniker` seam, `resolveVendorScript('tunnel.sh')`, `<moniker>.<VMS_BASE>`, and the `runtime.tunnel`/`runtime.tunnelDomain` fields the facade already consumes). Genuinely new code = tunnel-domain variant of `serviceUrlEnv` + the WAN timeout env.

- **Flag decl:** `commands/e2e/run.ts` `E2eRun.flags` (~L141, boolean `default:false`); mirror on `commands/e2e/connect.ts` `E2eConnect.flags` (~L98).
- **Moniker→domain resolution (already exists verbatim):** `commands/stack/up.ts:297-303` (`vmsBase = VMS_BASE ?? 'vms.wootdev.com'`; `getTunnelMoniker()(resolveVendorScript('tunnel.sh'))`; `domain = \`${moniker}.${vmsBase}\``). Seam at `base-command.ts:528` → `runtime/tunnel-prep.ts:34`, available since both e2e commands extend `BaseCommand`. Thread in `run.ts` after `deriveInstance` (~L218) before `buildStackContext` (~L265); `connect.ts` before its `buildStackContext` at L148.
- **`buildStackContext` (`e2e-orchestrate.ts:227-232` sig, literal `273-309`):** currently hardcodes `tunnel:false` at **:284**, never sets `tunnelDomain`. Add optional `tunnelDomain?` param; set `tunnel: tunnelDomain!==undefined, tunnelDomain`. Facade `stack-api.ts:850-863` already reads these → `syncDashLocalDefaults` → `dash-defaults.ts:122`; **no facade change needed.**
- **New producer:** add `TUNNEL_SERVICE_LABELS` frozen `ServiceId→label` map after `e2e-orchestrate.ts:390` (keyed to `vendor/tunnel.sh` SERVICES L55-66) + `tunnelServiceUrlEnv(domain)`. Wire into `playwrightEnv` (`:423-461`, overlay line **:456**): prefer tunnel URLs when domain present (must beat `flow.env`). Thread `tunnelDomain` via `ExecDeps.tunnelDomain?` (`:645-694`) from `executeResolvedFlow`'s `playwrightEnv` call (`:937`), and into `describeResolved`/`DescribeOptions` (`:494-537`) so `--dry-run` prints `https://` URLs.
- **Label↔ServiceId is NOT string-derivable:** `saga-dash→dash`, `connect-web→connect`, `ads-adm-api→ads-adm` are renames; `iam-api/sis-api/programs-api/scheduling-api/sessions-api` drop `-api`; but `connect-api→connect-api` keeps `-api`. All 9 `PLAYWRIGHT_SERVICE_URL_ENV` ServiceIds have a SERVICES entry — no stranded service today.
- **Slot-0 guard:** `E2eRun` is `slotAware()`/`setAware()` (`run.ts:144,149`) → add hard-error alongside `run.ts:156-167` (before `runSetPreflight`), identical to `up.ts:209-214`; the single `flags.slot>0` check covers `--set` too. `E2eConnect` is neither slot- nor set-aware → already slot-0-only, no guard.
- **Timeout:** prober does NOT need a bump — services still bind localhost under tunnel (`probe-plan.ts:62-82`, `health.ts:45-55` probe `http://localhost:<port>`). Only the Playwright browser hairpins to `https://<label>.<domain>`. Inject net-new `PLAYWRIGHT_TUNNEL_TIMEOUT_MS` in `playwrightEnv` (`:453-458`) when `tunnelDomain` set. **Cross-repo:** saga-dash `playwright.config.ts` must read it into `use.navigationTimeout`/`actionTimeout`/`timeout` — confirm the exact env name in that repo.
- **Optional all-in-one:** after green run, start reverse tunnels (parity `up.ts:587-591`: `resolveVendorScript('tunnel.sh')` + `flagMap.tunnel('up')`).
- **Tests to add:** tunnel cases in `__tests__/e2e-orchestrate-slot.unit.test.ts` (describe L117); new `__tests__/tunnel-service-labels.unit.test.ts` (every `PLAYWRIGHT_SERVICE_URL_ENV` ServiceId has a label, each label a real `tunnel.sh` SERVICES entry); `commands/e2e/__tests__/run.int.test.ts` (`--tunnel --dry-run` prints `https://`; `--tunnel --slot 1` hard-errors) — copy `getTunnelMoniker` stub from `commands/stack/__tests__/up.unit.test.ts`.

## 5. Snapshot-bridge root-cause hypotheses

**Primary (HIGH confidence): the bridge used legacy `mesh-fixture-cli`, whose hardcoded 6-DB list omits `sessions`.** `mesh-fixture-cli/src/lib/postgres.ts:25-32` `SAGA_MESH_DATABASES = {iam_local, iam_pii_local, programs, scheduling, ads_adm_local, ledger_local}` — no `sessions`, no `content`/`coach_api`/`sis_db`, and zero mongo handling (`store.ts` calls `pgDump` only). Demo District sessions live in the `sessions` postgres projection DB (`up.sh:19-22`, seeded by `seed_sessions`/`SEED_DEMO_ONLY=1` at `up.sh:1852-1885`); users live in `iam_local`/`iam_pii_local`. So `iam_local` restores → users repopulate; `sessions` is never dumped → Demo District sessions stay empty. This asymmetry is the exact fingerprint. The gap is called out in-repo (`core/snapshot/plan.ts:13-17`); the NEW `ss stack snapshot` default set covers all 10 pg DBs + `connectv3` mongo (`plan.ts:144-171`).

**Ruled out / secondary:**
- **Profile guard** (`restore.ts:120-127`) and **snapshot-ahead guard** (`plan.ts:240-278`) are all-or-nothing → would NOT produce the users-yes/sessions-no split. Inconsistent with symptom.
- **Per-org restore?** No — whole-DB `pg_restore --clean --if-exists` (`restore.ts:138-148`). Ruled out.
- **Cookie/URL domain baking** (`up.sh:1382-1433`): applied at launch, not baked into rows; `sessions` projection data is domain-independent → would break *joining a live Connect room*, not the list populating. Separate risk.

**Confirm on a live box (UNVERIFIABLE_HERE):**
```
# SOURCE box — prove data existed at snapshot time:
docker exec soa-postgres-1 psql -U postgres_admin -d sessions -tAc \
  "SELECT count(*) FROM program_projection WHERE id LIKE 'a1b2c3d4-0001-4000-8000-%'"   # >0
docker exec soa-postgres-1 psql -U postgres_admin -d sessions -tAc \
  "SELECT count(*) FROM projection_readiness"                                            # >=1
# Decisive — which tool/DB set:
ls -la ~/.saga-mesh/snapshots/<fixture-id>/
cat  ~/.saga-mesh/snapshots/<fixture-id>/manifest.json 2>/dev/null
#   only the 6 *.dump + no sessions.dump/connectv3.archive/manifest → legacy tool → CONFIRMED
# TARGET box after restore — prove asymmetry:
docker exec soa-postgres-1 psql -U postgres_admin -d sessions -tAc \
  "SELECT count(*) FROM program_projection WHERE id LIKE 'a1b2c3d4-0001-4000-8000-%'"   # 0
docker exec soa-postgres-1 psql -U postgres_admin -d iam_local -tAc 'SELECT count(*) FROM "User"'  # >0
```
Also: hit sessions-api `/my-sessions` on the tunnel box — a 408 "projection … is warming" ⇒ `projection_readiness` row also missing, consistent with the whole `sessions` DB not restored.

**Fix:** bridge must use `ss stack snapshot store/restore`, never `mesh-fixture-cli`; keep `SEED_PROFILE` identical between build and restore (or `--force`) so the profile guard doesn't silently abort.

## 6. Corrections to the plan (prioritized)

**P0 — thesis-breaking:**
1. **Add GAP 3: coach browser-plane overlay in `launch-plan.ts`.** `coach-api`/`coach-web` fall through to `default:{}` at `launch-plan.ts:375` (vs `up.sh:1440-1454`). Separate from the `tunnel.sh` drift.
2. **Split Phase 1 → 1a (re-vendor `tunnel.sh`: frpc plumbing) + 1b (add coach cases to `tunnelOverlay()` + overlay unit-test assertions).** Tie Phase 1 Exit ("coach reachable") to **1b, not 1a**. Record the slug trap (§3).
3. **Re-sequence Phase 0.** Phase 0 step 3 (diff emitted `tunnel_env` per service) already surfaces this divergence, but step 4 pre-labels coach-red as "known (Phase 1)" and waves it through — that pre-label hides Gap 3. Treat any coach env divergence as an open finding routed to 1b.

**P1 — refuted/PARTIAL claims to edit:**
4. **"No test-code change needed" (Phase 2) is only partial.** Needs explicit `TUNNEL_SERVICE_LABELS` table (labels not string-derivable); `buildStackContext` hardcodes `tunnel:false` (`e2e-orchestrate.ts:284`) → thread `tunnelDomain` through `buildStackContext`→`ExecDeps`→`playwrightEnv`+`describeResolved`; "no spec change" is an **assumption to confirm in saga-dash `lane.ts`** (not in repo), not a fact.
5. **Phase 2 "bump Playwright timeouts" conflates two timeouts.** Prober needs no bump (localhost). The real one is the browser WAN hairpin, consumed cross-repo in saga-dash `playwright.config.ts`; CLI only exports the env. Add the cross-repo dep and confirm the env name.
6. **Drift guard must be scoped to `tunnel.sh` only.** A directory-wide "vendor≠source" guard false-positives on the intentionally-forked `refresh-suite.sh` and `.gitignore`. Also drop the nonexistent `compose-rest` reference from findings.
7. **Add `tunnel-service-labels.unit.test.ts`** to catch label↔SERVICES drift.

**P2 — missed entirely:**
8. **`seeded.ok`-after-restore interaction.** Reverse tunnels fire at `up.ts:587` only under `if (overlays.tunnel && seeded.ok)` — stricter than findings state (requires a healthy seed). Under the snapshot-bridge decision the happy path *restores* rather than journey-seeds; confirm `seeded.ok` is true post-restore or frpc silently won't come up.
9. **De-risk & pull Phase 3 forward.** Root cause is now known (§5) → rewrite Phase 3's open question to "confirm bridge uses `ss stack snapshot`, never `mesh-fixture-cli`"; add the profile guard + snapshot-ahead guard as must-satisfy; run the reproduction in parallel with Phase 1/2, not last.
10. **Separate "list populates" from "room joins" in Phase 3.** Bridge fixes the *list* (domain-independent projection data); room-join relies on Phase 1's launch-time overlay (cookie domain, connect-web `VITE_*`). connect-web overlay is present and matches (parity #8), but a coach-style omission would strand room-join → tie Phase 3 "room reachable" exit to Phase 1b.
11. **Record rtsm-api `FLEET_CONFIG_PATH` shape note** (low risk, §3 item 4).

**Net:** phases become 0, 1a, **1b (new)**, 2, 3, 4; thesis "exactly TWO gaps" → **THREE**; ~+½ day for 1b, roughly net-neutral since Phase 3 shrinks (~3-4 days total).

## 7. What still needs a running stack to verify (UNVERIFIABLE_HERE)

- **Snapshot root cause** — all live-box checks in §5 (source data existed; snapshot-dir tool/DB-set fingerprint; target-box users>0 while sessions=0; sessions-api 408 warming probe).
- **coach parity breaks at runtime** — that a remote browser from `coach.<moniker>.vms…` is actually CORS-rejected / Vite-403'd / pointed at localhost:6105 (static comparison only; token values `DASH_URL`/`CONNECT_WEB_URL`/`IAM_PORT` assumed equal across both sides).
- **saga-dash cross-repo consumers (not in this worktree):** (a) `lane.ts` reads every service URL from env — the load-bearing assumption behind "no e2e spec change"; (b) `playwright.config.ts` reads the WAN-timeout env into `navigationTimeout`/`actionTimeout`/`timeout` — confirm exact env name before finalizing; (c) the saga-dash#194 seam (`lib/api/config.ts mergeLocalTopology` consuming the `url` type) — ss writes a matching config (verified), but consumption is unverifiable here.
- **`flagMap.tunnel` argv/env** for the final `tunnel.sh up` invocation (`flag-map.ts` not opened; outside claim scope).
- **`seeded.ok` after a snapshot-restore** (§6 item 8) — whether the frpc gate at `up.ts:587` is satisfied on the restore path.

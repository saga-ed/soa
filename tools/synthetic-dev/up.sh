#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# synthetic-dev/up.sh — stand up the local synthetic-dev stack for sds_92.
#
# Goal: dockerized postgres + redis + rabbitmq + mongo + the nine services,
# EMPTY, ready to seed SYNTHETIC iam rosters / programs via the deterministic `db:seed`
# (@saga-ed/*-seed-ids — same data as preview/CI, stable ids across --reset; no
# VPN, no prod-mirror fixture). See synthetic-dev-align. The old scenario-runner
# seed was retired here (scenario scripts stay in-repo for future journey data).
#
# The sixth API is sis-api (rostering, on main as of 2026-06 — Adam's SIS
# reconciliation / CSV-roster service). It runs on :3100 against a dedicated
# `sis_db`, and calls iam-api's `service.*` S2S surface. No S2S credentials are
# needed locally: iam-api's auth.middleware synthesizes a dev-bypass service
# actor when authEnabled=false ("for the SIS CSV pilot"), which is the mode we
# run iam-api in here. See decisions/d1.7. Its `sis_db` is created by the
# canonical mesh seed (soa profile-empty.sql, soa#112) like the other app DBs.
#
# The seventh API is sessions-api (program-hub, :3007 — harvested out of
# programs-api in program-hub #148, 2026-06). It owns a `sessions` DB of
# event-built projections (programs.* / scheduling.* / iam.* consumers over the
# mesh broker) + TutoringSession, and serves the dash's /sessions page
# (sessions.dayList / rangeList / lifecycle). On the canonical --reset --seed
# lane it's up before any program exists, so projections build live. If your
# mesh ALREADY had program data when sessions-api first joined, catch it up
# once with the manual per-program replay CLIs (program-hub #160/#161:
# `pnpm replay:program-outbox <id>` / `replay:schedule-outbox <id>` — see
# getting-started.md). See soa#146.
#
# Services eight + nine are the Connect app (qboard repo): connect-api (:6106,
# Express + MongoDB) and connect-web (:6210, Vite). Connect needs NO seed
# fixtures — its mongo collections auto-create on first write; "session data"
# comes from sessions-api (:3007). Its mongo is part of the MESH (infra-compose
# saga-mesh includes services/connect-mongo → soa-connect-mongo-1, :27037 —
# standalone, no auth; NOT the legacy saga-api/wootmath template, NOT qboard's
# bespoke :27017 container).
# AV comes from qboard's livekit+coturn containers (best-effort). No HTTPS /
# domain-spoof proxy (qboard's proxy-dev.sh) is needed here: iam is local, so
# localhost host-scoped cookies reach every port — same trick the dash uses.
#
# Service ten is rtsm-api (rtsm repo, :6110) — the CRDT/socket service Connect
# syncs through. It runs as a ONE-NODE FLEET (FLEET_CONFIG_PATH=
# rtsm-fleet-local.json + FLEET_NODE_NAME=local): rtsm-client always
# discovers via GET /fleet/discover, which only fleet mode serves, so bare
# single-instance mode 404s the client. With itself as the only member the
# mesh half stays idle. Still stateless: in-memory, no DB/redis,
# SOCKET_AUTHMODE=none, ws:// — no migrate/seed step, and rooms die ~20s
# after the last client leaves (by design). connect-web reaches it via
# VITE_RTSM_BOOTSTRAP_URL (qboard plumbs it through to rtsm-client's
# bootstrapUrl; on a qboard checkout without that plumb the env var is
# ignored and connect-web falls back to the wootdev.com fleet).
#
# Deferred: the fleek recording stack, dash→connect linking. SAGA_API_TARGET
# (legacy poll content, unauthenticated endpoint) stays remote until
# content-api lands.
#
# Branch posture (see decisions/d1.1): iam/programs/scheduling/saga-dash/soa on
# MAIN; ads-adm from the canonical ~/dev/student-data-system checkout (sds_92 is
# merged to main; the sds_92 worktree has been retired). Override with SDS=...
#
# This wraps + corrects the concierge (student-data-system-demo.sh). The
# concierge's `up` does NOT work out-of-the-box on these mains: it doesn't pass
# RABBITMQ_URL to program-hub (apps default to :5673, mesh is :5672), its
# .env.local template predates main's required AUTH_* secrets, and it launches
# iam-api via `pnpm dev` which (on main) fails to copy a runtime asset. Every
# such drift + fix is documented in README.md and applied idempotently below.
#
# Usage:
#   ./up.sh                      bring up mesh + 10 services (empty)
#   ./up.sh up --pull            ff-only sync all siblings to origin, then build/migrate
#   ./up.sh --seed [roster|full] seed synthetic data (default: roster)
#                                  roster = iam roster only (programs empty → from-scratch)
#                                  full   = iam roster + programs/periods/enrollment
#   ./up.sh --reset              truncate synthetic data → empty baseline (keeps migrations);
#                                  also clean-restarts services + clears vite caches
#   ./up.sh restart              clean restart ONLY: stop services + clear vite + start,
#                                  NO data wipe. Use after refresh-suite when the dash UI
#                                  is stale/unresponsive (a rewritten branch corrupts vite's
#                                  module graph and HMR doesn't recover) — same recovery as
#                                  --reset but without truncating your seeded data.
#   ./up.sh --record [crdt|av]   opt-in fleek recording stack (recorder + recordings-api
#                                  + MinIO; `av` adds the LiveKit egress sidecar). Needs
#                                  the fleek repo cloned + AWS CLI (CodeArtifact token
#                                  for the image builds). Composes with up/reset/seed.
#   ./up.sh --tunnel             ALSO expose the browser-facing services to other
#                                  users at https://<svc>.<moniker>.vms.wootdev.com
#                                  (multi-user Connect). Moniker comes from
#                                  .vms-moniker (first run prompts + registers;
#                                  never a CLI arg). Composes: `--reset --tunnel
#                                  --seed roster --login`. Needs AWS SSO creds +
#                                  the vms box (vms/README.md). Services must
#                                  (re)launch to pick up tunnel env — prefer
#                                  `restart --tunnel` / `--reset --tunnel`.
#   ./up.sh --login [email]      auto-login via iam-api devLogin (default: dev@saga.org)
#   ./up.sh --user  [email]      alias for --login
#   ./up.sh --down               stop services (leaves mesh up)
#   ./up.sh --status             health + row counts
#
# HYBRID mode (edit ONE service locally; the rest live in a cloud sandbox):
#   ./up.sh --only <svc> --sandbox <name>
#                                launch ONLY <svc> locally and point its
#                                cross-service deps (today: iam-api) at the dev
#                                fleet sandbox <name> via preview-header routing
#                                (x-saga-preview-iam-api: sandbox-<name>) instead
#                                of the local mesh. Compose the sandbox first
#                                (refresh-suite.sh --compose-rest, or the UI).
#                                NOTE: the cloud iam-api runs auth ON, so a real
#                                S2S token is required (no local dev-bypass) — see
#                                the design doc (INTEGRATION.md, alongside this script).
#
# Flags compose, applied in order up → reset → seed → login. Reproducible
# recipes (no post-deletes — selectivity is in what you seed):
#   ./up.sh --reset --seed roster --login  from-scratch roster + dev@saga.org session
#   ./up.sh --reset --seed full --login    roster + 9 programs + a fresh dev@saga.org session
#   ./up.sh --reset --seed roster --login empty@saga.org
#                                          same db:seed, but log in as the EMPTY ORG
#                                          admin. db:seed always builds an Empty Org too
#                                          (an admin on a district with NO schools/sections/
#                                          roster) — the persona you --login picks which
#                                          district you see. Use empty@saga.org for CSV
#                                          upload-from-scratch testing; dev@saga.org lands
#                                          you in the fully-rostered Seed District.
# (--reset / --seed / --login against an already-running stack skip the up step.)
#
# IMPORTANT: the default --login persona (dev@saga.org) is the rostered Seed
# District admin — it only exists AFTER the iam roster is seeded, so --login
# must follow a --seed (the recipes above). A BARE `--reset --login` truncates
# the roster and leaves only the bootstrap user (dev@example.org), so the
# dev@saga.org default 401s; either seed first, or `--login dev@example.org`.
#
# --login does TWO things:
#   1. writes a cookie jar ($STATE/cookies.txt, Netscape) for HEADLESS harnesses
#      (Playwright storageState / curl --cookie).
#   2. opens a real Chromium (persistent profile, via browser-login.mjs) already
#      logged into the dash at :8900 — so you skip the Janus redirect and the
#      manual /demo#auth step. Drive THAT window; re-run --login after a reset to
#      refresh it. (Needs Playwright in saga-dash — if absent, half 2 is skipped
#      with a hint and the cookie jar still works.)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DEV=${DEV:-$HOME/dev}
SOA=$DEV/soa
ROSTERING=$DEV/rostering
PROGRAM_HUB=$DEV/program-hub
SAGA_DASH=$DEV/saga-dash
SDS=${SDS:-$DEV/student-data-system}         # ads-adm from the canonical checkout (sds_92 merged to main; worktree retired)
QBOARD=${QBOARD:-$DEV/qboard}                # Connect app (connect-api + connect-web)
RTSM=${RTSM:-$DEV/rtsm}                      # RTSM CRDT/socket service (single-node local)
FLEEK=${FLEEK:-$DEV/fleek}                   # fleek recording stack (opt-in: --record)

IAM_PORT=3010                                               # iam-api port — matches saga-dash main's static/config.json default (post Janus auth rewrite, d1.4)
IAM_URL="http://localhost:$IAM_PORT"
SIS_PORT=3100                                               # sis-api port (SisConfigSchema default; rostering apps/node/sis-api)
SIS_DB_URL="postgresql://sis:sis@localhost:5432/sis_db"     # sis-api owns a dedicated DB (read direct from SIS_DATABASE_URL; see d1.7)
# program-hub config defaults to its OWN standalone-dev postgres on :5433; in this
# stack programs/scheduling/sessions live in the mesh on :5432, so override
# DATABASE_URL everywhere we run program-hub (migrate + runtime), matching
# seed_programs.
PROGRAMS_DB_URL="postgresql://saga_user:password123@localhost:5432/programs"
SCHEDULING_DB_URL="postgresql://saga_user:password123@localhost:5432/scheduling"
SESSIONS_DB_URL="postgresql://saga_user:password123@localhost:5432/sessions"
CONTENT_DB_URL="postgresql://saga_user:password123@localhost:5432/content"      # content-api owns the `content` mesh DB
MESH_MQ="amqp://rabbitmq_admin:password123@localhost:5672"  # mesh broker creds (NOT saga_user)
# Connect (qboard). Ports are the apps' own defaults (vite.config.ts / config.ts).
# Its mongo is the mesh's soa-connect-mongo-1 (infra-compose services/connect-mongo),
# host :27037 (non-default on purpose: no contention with qboard-mongo/:27017),
# standalone, no auth. Collections auto-create; no migrate step, no seed.
CONNECT_API_PORT=6106
CONNECT_WEB_PORT=6210
CONNECT_MONGO_PORT=27037
# NOTE: connect-api selects its database from MONGO_DB_NAME (default
# `connectv3`), NOT the URI path — keep the path matching so there's one name.
CONNECT_MONGO_URI="mongodb://localhost:$CONNECT_MONGO_PORT/connectv3"
CONNECT_API_URL="http://localhost:$CONNECT_API_PORT"
CONNECT_WEB_URL="http://localhost:$CONNECT_WEB_PORT"
RTSM_PORT=6110                               # rtsm-api (EXPRESS_SERVER_PORT — its committed .env default)
RTSM_URL="http://localhost:$RTSM_PORT"
# Recording (opt-in --record). The recorder/recordings-api run from fleek's
# compose + local overlay; ports are the overlay's local-dev values.
FLEEK_REC_DIR="$HOME/.fleek-local/recordings" # per-user recordings (same dir proxy-dev uses)
RECORDER_CONTROL_PORT=7890                    # fleek-recorder control (plan push + /v1/health)
RECORDINGS_API_PORT=8444                      # fleek-recordings-api (8443 is its prod port)
RECORDING_TOKEN="local-dev-token"             # shared bearer, matches the fleek local overlay
# Legacy poll-content source (REQUIRED by connect-api's config; the poll
# endpoint is unauthenticated so no saga cookie is needed). Export your own
# (e.g. SAGA_API_TARGET=https://jw.wootmath.com) to override. Goes away when
# content-api lands.
SAGA_API_TARGET="${SAGA_API_TARGET:-https://wootmath.com}"
# content-api: the MODERN poll/content source — the "content-api lands" wiring the
# note above anticipates. connect-api resolves contentRef→body from it via
# CONTENT_API_URL and the dash content picker reads it. Its app default :3010
# collides with iam-api on :3010, so run it on :3009. SAGA_API_TARGET stays as the
# legacy fallback for poll-backed pages until the corpus is fully migrated.
CONTENT_PORT=3009
CONTENT_API_URL="http://localhost:$CONTENT_PORT"
DEV_USER_UUID="f0000004-0000-4000-8000-00000000beef"        # from iam-db seed-dev-user.ts
# ── hybrid mode (--only / --sandbox): run ONE service locally, point its
# cross-service deps at a CLOUD sandbox instead of the local mesh. Empty by
# default (pure-local stack). When SANDBOX_NAME is set, the dependency URLs
# below flip from localhost to the dev fleet host and the launched service
# forwards the preview-routing header `x-saga-preview-<svc>: sandbox-<name>`
# on its outbound calls (see sandbox_env() + the fleet-mesh handoff). Override
# the host with SANDBOX_BASE=... for non-dev fleets.
ONLY_SERVICE=""                                             # --only <svc>: launch just this one
SANDBOX_NAME=""                                             # --sandbox <name>: compose name the deps live under
SANDBOX_BASE="${SANDBOX_BASE:-wootdev.com}"                # dev fleet base domain (preview-header routed)
# ── tunnel mode (--tunnel): expose the browser-facing services to OTHER users
# via the vms rendezvous box — https://<svc>.<moniker>.$VMS_BASE → this laptop
# (tunnel.sh + vms/; built for multi-user Connect sessions). The moniker comes
# from .vms-moniker (tunnel.sh bootstraps it on first use), deliberately NEVER
# from the command line. tunnel_env() flips ONLY the browser-plane env (cookie
# domain, connect CORS/VITE_* URLs); service-to-service URLs stay localhost.
TUNNEL=0
TUNNEL_DOMAIN=""                                            # <moniker>.$VMS_BASE once resolved
TUNNEL_LK_KEY=""; TUNNEL_LK_SECRET=""; TUNNEL_FLEEK_TOPOLOGY=""  # AV-via-fleek (set in the tunnel block)
VMS_BASE="${VMS_BASE:-vms.wootdev.com}"                     # rendezvous domain (vms/template.yaml)
LOGIN_IAM_URL=""                                            # tunnel mode: login flows use the PUBLIC iam…
LOGIN_DASH_URL=""                                           # …and dash URLs (domain cookie can't be set via localhost)
STATE=/tmp/sds-synthetic; mkdir -p "$STATE"
COOKIE_JAR="$STATE/cookies.txt"                             # devLogin session jar (for headless harnesses)
DEFAULT_LOGIN_USER="dev@saga.org"                          # --login default persona (Seed District admin)
DASH_URL="http://localhost:8900"                           # saga-dash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"                 # this script's dir (browser-login.mjs lives alongside)
BROWSER_LOGIN="$SCRIPT_DIR/browser-login.mjs"              # playwright auto-login helper
BROWSER_PROFILE="$STATE/browser-profile"                    # persistent Chromium profile for the logged-in dash

PG=( postgresql://iam:iam@localhost:5432/iam_local )
say(){ printf "\033[34m→\033[0m %s\n" "$*"; }
ok(){ printf "\033[32m✓\033[0m %s\n" "$*"; }
warn(){ printf "\033[33m⚠\033[0m %s\n" "$*"; }
err(){ printf "\033[31m✗\033[0m %s\n" "$*"; }

# ── branch posture sanity (warn only, overlay-aware) ─────────────────
# A repo with PRs in your integration-suite.local.tsv overlay is EXPECTED on
# local/integration (that's where refresh-suite parks it); without an overlay
# it's expected on main. So we only warn on ACTUAL drift — not on the correct
# overlaid state. With no local overlay (the default) every repo is expected on
# main. (verify.sh turns this into a hard, exit-code check + confirms the
# overlaid PRs are merged; here it stays a warning so `up` proceeds.)
check_branches(){
  # ── preflight: every sibling repo must actually be cloned ────────────
  # A missing dir otherwise surfaces only as git's raw "fatal: cannot change
  # to '…'" from the probes below (or a late prep/launch failure). up.sh is
  # the repeatable runner, so it only ASSERTS here — provisioning (clone +
  # co:login + install) is bootstrap.sh's "ensure repos" step.
  local _miss=()
  for kv in "$SOA:soa" "$ROSTERING:rostering" "$PROGRAM_HUB:program-hub" \
            "$SAGA_DASH:saga-dash" "$SDS:student-data-system" "$QBOARD:qboard" \
            "$RTSM:rtsm"; do
    [[ -d "${kv%:*}/.git" ]] || _miss+=("$kv")
  done
  if [[ ${#_miss[@]} -gt 0 ]]; then
    printf "\033[31m✗\033[0m %d sibling repo(s) not cloned:\n" "${#_miss[@]}"
    for kv in "${_miss[@]}"; do
      printf "    %-20s (expected at %s)\n" "${kv#*:}" "${kv%:*}"
    done
    printf "  Run ./bootstrap.sh to clone + install them (or clone each by hand), then re-run.\n"
    exit 1
  fi
  local MANIFEST="$SCRIPT_DIR/integration-suite.local.tsv" repo have want
  declare -A PINS=()
  if [[ -f "$MANIFEST" ]]; then
    while IFS=$'\t' read -r repo _prs; do
      repo="${repo//[[:space:]]/}"; [[ -z "$repo" ]] && continue
      PINS["$repo"]="${_prs//[[:space:]]/}"
    done < <(grep -vE '^\s*(#|$)' "$MANIFEST")
  fi
  for kv in "$ROSTERING:rostering" "$PROGRAM_HUB:program-hub" "$SAGA_DASH:saga-dash" "$QBOARD:qboard" "$RTSM:rtsm"; do
    r=${kv%:*}; repo=${kv#*:}
    have=$(git -C "$r" branch --show-current)
    if [[ -n "${PINS[$repo]:-}" ]]; then
      [[ "$have" == local/integration ]] || printf "\033[33m⚠\033[0m %s on '%s' (expected 'local/integration')\n" "$repo" "$have"
    elif [[ "$have" == main ]] || { [[ "$have" == local/integration ]] && git -C "$r" diff --quiet origin/main HEAD 2>/dev/null; }; then
      : # on main, or an empty local/integration that's identical to main — fine
    else
      printf "\033[33m⚠\033[0m %s on '%s' (expected 'main')\n" "$repo" "$have"
    fi
  done
  # soa/sds: always main — except a soa manifest row, which pins soa itself
  # (testing a synthetic-dev/infra tooling PR; mirrors verify.sh's posture loop).
  for kv in "$SOA:soa" "$SDS:student-data-system"; do
    r=${kv%:*}; repo=${kv#*:}; have=$(git -C "$r" branch --show-current)
    if [[ "$repo" == soa && -n "${PINS[soa]:-}" ]]; then
      [[ "$have" == local/integration ]] || printf "\033[33m⚠\033[0m soa on '%s' (overlay pins soa — expected 'local/integration')\n" "$have"
    else
      [[ "$have" == main ]] || printf "\033[33m⚠\033[0m %s on '%s' (expected 'main')\n" "$repo" "$have"
    fi
  done
}

# ── preflight: launch directories must exist ─────────────────────────
# The Connect/RTSM launch dirs only exist on reasonably-current checkouts
# (qboard's monorepo restructure, rtsm's apps/ split). A cloned-but-stale repo
# otherwise dies mid-launch with a raw `cd: No such file or directory` —
# assert up front, with the actual fix. Runs on BOTH the `up` and the
# flag-only --reset/restart paths (anything that launches services).
check_layout(){
  local missing=0 d
  for d in "$QBOARD/apps/node/connectv3-api" "$QBOARD/apps/web/connectv3" \
           "$RTSM/apps/node/rtsm-api"; do
    [[ -d "$d" ]] || { err "missing $d"; missing=1; }
  done
  if [[ $missing == 1 ]]; then
    printf "  a sibling repo predates the layout this stack launches from —\n"
    printf "  run ./up.sh --pull (or git -C <repo> pull), then re-run.\n"
    exit 1
  fi
}

# ── idempotent fixes (all the main-vs-tooling drifts) ────────────────
apply_fixes(){
  # 1. rostering root .env.local — main iam-api needs NODE_ENV + AUTH secrets + broker
  local L="$ROSTERING/.env.local"
  [[ -f "$L" ]] || cat >"$L" <<EOF
DATABASE_URL=postgresql://iam:iam@localhost:5432/iam_local
PII_DATABASE_URL=postgresql://iam_pii:iam_pii@localhost:5432/iam_pii_local
PII_DEK_HEX=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
PII_HMAC_KEY_HEX=fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210
PII_DEK_VERSION=1
PII_CRYPTO_PIIDEKHEX=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
PII_CRYPTO_PIIHMACKEYHEX=fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210
PII_CRYPTO_PIIDEKVERSION=1
REDIS_URL=redis://localhost:6379
EOF
  grep -q '^NODE_ENV='                     "$L" || echo "NODE_ENV=development" >>"$L"
  grep -q '^AUTH_EMAIL_LOOKUP_SECRET='     "$L" || echo "AUTH_EMAIL_LOOKUP_SECRET=$(openssl rand -hex 32)" >>"$L"
  grep -q '^AUTH_EMAIL_VERIFICATION_SECRET=' "$L" || echo "AUTH_EMAIL_VERIFICATION_SECRET=$(openssl rand -hex 32)" >>"$L"
  grep -q '^RABBITMQ_URL='                 "$L" || echo "RABBITMQ_URL=$MESH_MQ" >>"$L"
  # sis-api / sis-db read SIS_DATABASE_URL directly (sis-db/prisma.config.ts
  # loads this repo-root .env.local), so it must live here for `migrate deploy`
  # AND the running service to see the same DB. See d1.7.
  grep -q '^SIS_DATABASE_URL='             "$L" || echo "SIS_DATABASE_URL=$SIS_DB_URL" >>"$L"

  # 2. iam-api/.env — dev user must be a UUID (audit_log.actor is uuid); raise rate limit for bulk seed
  local IE="$ROSTERING/apps/node/iam-api/.env"
  if [[ -f "$IE" ]]; then
    sed -i "s|^AUTH_DEVUSERID=.*|AUTH_DEVUSERID=$DEV_USER_UUID|" "$IE"
    # iam-api on :3010 to match saga-dash main's default (d1.4). Set in .env
    # (authoritative) AND passed as launch env below.
    if grep -q '^PORT=' "$IE"; then sed -i "s|^PORT=.*|PORT=$IAM_PORT|" "$IE"; else echo "PORT=$IAM_PORT" >>"$IE"; fi
    if grep -q '^SECURITY_RATELIMITMAXREQUESTS=' "$IE"; then
      sed -i 's|^SECURITY_RATELIMITMAXREQUESTS=.*|SECURITY_RATELIMITMAXREQUESTS=1000000|' "$IE"
    else echo 'SECURITY_RATELIMITMAXREQUESTS=1000000' >>"$IE"; fi
    # Longer local session: bump the access-token TTL to 8h so hand-driving the
    # dash doesn't 401 mid-edit (the dash's refresh loop is Janus/gateway-only,
    # not wired locally; default TTL is 15 min). DotenvConfigManager exposes the
    # JwtConfigSchema field as JWT_ACCESSTOKENTTLSECONDS. Prod is capped at 900s
    # by assertProductionConfig — rostering PR #310.
    if grep -q '^JWT_ACCESSTOKENTTLSECONDS=' "$IE"; then
      sed -i 's|^JWT_ACCESSTOKENTTLSECONDS=.*|JWT_ACCESSTOKENTTLSECONDS=28800|' "$IE"
    else echo 'JWT_ACCESSTOKENTTLSECONDS=28800' >>"$IE"; fi
    # Janus perimeter (rostering issue #155, @saga-ed/janus-client v0.2) is the
    # OUTER Saga-employee gate; with it on, the local seed scenario 401s with
    # {"realms":["janus"]}. Disable for local dev -- the documented default
    # in iam-api's own .env.example.
    if grep -q '^JANUS_REQUIRED=' "$IE"; then
      sed -i 's|^JANUS_REQUIRED=.*|JANUS_REQUIRED=false|' "$IE"
    else echo 'JANUS_REQUIRED=false' >>"$IE"; fi
  fi

  # 3. (removed) iam-api dev script password-blocklist copy — fixed upstream in
  #    rostering PR #302 (commit bc2a2dd), on main as of 2026-05-27. No longer patched here.

  # 4. (removed) program-hub programs scenario iam_session cookie patch — fixed
  #    upstream in program-hub PR #102 (merge d85aa2d, on main as of 2026-05-27).
  #    The scenario now reads/sends the JWT `iam_session` cookie natively. No
  #    longer patched here.

  # 5. saga-dash static/config.json — teach the dash where sis-api lives so a
  #    dash sis-api client resolves to :3100 with no hand-editing (d1.7, dec 2).
  #    Idempotent: only adds the `sis-api` localDefaults key if absent. NOTE:
  #    config.json is a TRACKED file — this leaves a saga-dash working-tree edit
  #    (expected; remove the key if you'd rather Adam own it). The key name is a
  #    best-guess until dash sis-api code lands; rename to match if it differs.
  local DASH_CFG="$SAGA_DASH/apps/web/dash/static/config.json"
  if [[ -f "$DASH_CFG" ]] && ! grep -q '"sis-api"' "$DASH_CFG"; then
    if node -e '
      const fs=require("fs"); const [p,port]=process.argv.slice(1);
      const c=JSON.parse(fs.readFileSync(p,"utf8"));
      c.localDefaults=c.localDefaults||{};
      c.localDefaults["sis-api"]={type:"localhost",port:Number(port)};
      fs.writeFileSync(p, JSON.stringify(c,null,2)+"\n");
    ' "$DASH_CFG" "$SIS_PORT" 2>/dev/null; then
      ok "saga-dash config.json: sis-api → :$SIS_PORT"
    else
      printf "\033[33m⚠\033[0m could not patch %s (add sis-api → :%s by hand)\n" "$DASH_CFG" "$SIS_PORT"
    fi
  fi
}

# Ports the mesh publishes on the host. A pre-check here names ALL conflicts up
# front and — crucially — PRINTS them: mesh_up sends `make up` to a log, so the
# infra Makefile's own (docker-only) port-conflict message otherwise dies in the
# log while set -e exits the script with nothing on screen.
MESH_PORTS=( "5432:postgres" "6379:redis" "5672:rabbitmq" "15672:rabbitmq-mgmt" )

# Is host port $1 bound by a LISTENING socket? Tests the real listener table
# (ss → netstat → lsof → bash /dev/tcp), so it catches NATIVE processes AND
# host-network containers — not just port-mapped containers. (A docker-ps-only
# check misses a host redis on 6379, which is exactly how one slipped through.)
port_listening(){
  local p=$1
  if   command -v ss      >/dev/null 2>&1; then ss -ltnH 2>/dev/null     | awk '{print $4}' | grep -qE "[:.]$p$"
  elif command -v netstat >/dev/null 2>&1; then netstat -ltn 2>/dev/null  | awk '{print $4}' | grep -qE "[:.]$p$"
  elif command -v lsof    >/dev/null 2>&1; then lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1
  else ( exec 3<>"/dev/tcp/127.0.0.1/$p" ) 2>/dev/null && exec 3>&- 3<&-
  fi
}

check_ports(){
  local conflict=0 entry p name dock
  for entry in "${MESH_PORTS[@]}"; do
    p=${entry%:*}; name=${entry#*:}
    # A port-mapped docker container shows in `docker ps` — gives a clean name +
    # `docker stop`. Our own mesh containers are fine (make up reconciles them).
    dock=$(docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null | grep -E "[:.]$p->" | head -1 | cut -f1 || true)
    [[ "$dock" =~ ^soa-(postgres|redis|rabbitmq)-1$ ]] && continue
    if [[ -n "$dock" ]]; then
      printf "\033[31m✗\033[0m mesh port %s (%s) held by container '%s' — free it:  docker stop %s\n" "$p" "$name" "$dock" "$dock"
      conflict=1
    elif port_listening "$p"; then
      # native process or host-network container — no Ports mapping to name it
      printf "\033[31m✗\033[0m mesh port %s (%s) in use by a non-docker listener — find it:  sudo lsof -iTCP:%s -sTCP:LISTEN  (or: sudo ss -lptn 'sport = :%s')\n" "$p" "$name" "$p" "$p"
      conflict=1
    fi
  done
  [[ $conflict -eq 0 ]] || { printf "  The mesh needs 5432/6379/5672/15672 free. Clear the holder(s) above, then re-run.\n"; exit 1; }
}

mesh_up(){
  # "already up" only if ALL four mesh containers are running. A partial mesh
  # (e.g. redis failed to bind its port last run) must reconcile via make up,
  # not masquerade as up — otherwise we skip straight past a missing service.
  local running; running=$(docker ps --format '{{.Names}}' | grep -cE '^soa-(postgres|redis|rabbitmq|connect-mongo)-1$' || true)
  if [[ "$running" -eq 4 ]]; then ok "mesh already up"; return; fi
  [[ "$running" -gt 0 ]] && say "partial mesh ($running/4 up) — reconciling…"
  # One-time migration: pre-infra-compose-1.4.0 stacks ran connect-mongo as a
  # standalone synthetic-dev container (compose/connect-mongo.yml). It holds
  # :27037 and the connect-mongo-data volume name against the mesh-managed
  # service — remove both (synthetic data; collections auto-create on write).
  if docker ps -a --format '{{.Names}}' | grep -qx connect-mongo; then
    say "migrating: removing legacy standalone connect-mongo (mongo is mesh-managed now)"
    docker rm -f connect-mongo >/dev/null 2>&1 || true
    docker volume rm connect-mongo-data >/dev/null 2>&1 || true
  fi
  check_ports
  say "starting mesh (postgres + redis + rabbitmq + connect-mongo)…"
  if ! ( cd "$SOA/infra" && EXTRA_POSTGRES_SEED_DIR=../../projects/saga-mesh/seed \
      make up PROJECT=saga-mesh PROFILE=empty \
      POSTGRES_PORT=5432 REDIS_PORT=6379 RABBITMQ_PORT=5672 RABBITMQ_MGMT_PORT=15672 \
      CONNECT_MONGO_PORT="$CONNECT_MONGO_PORT" >"$STATE/mesh.log" 2>&1 ); then
    printf "\033[31m✗\033[0m mesh failed to start — 'make up' output (%s):\n" "$STATE/mesh.log"
    sed 's/^/    /' "$STATE/mesh.log" 2>/dev/null
    exit 1
  fi
  for _ in $(seq 1 20); do docker exec soa-postgres-1 pg_isready -U postgres_admin >/dev/null 2>&1 && break; sleep 1; done
  for _ in $(seq 1 20); do
    docker exec soa-connect-mongo-1 mongosh --quiet --eval 'db.runCommand({ping:1}).ok' >/dev/null 2>&1 && break; sleep 1
  done
  ok "mesh up — pg :5432  redis :6379  rabbitmq :5672  connect-mongo :$CONNECT_MONGO_PORT"
}

# ── Connect AV: qboard's livekit + coturn containers ─────────────────────────
# Connect's mongo is part of the MESH now (infra-compose saga-mesh includes
# services/connect-mongo — standalone mongo:8, loopback :27037; mesh_up starts
# and health-waits it). livekit+coturn come from qboard's compose (the
# single-node AV path; the fleek repo only adds recording sidecars — deferred)
# and are BEST-EFFORT: without them Connect still runs whiteboard/CRDT-only.
connect_av_up(){
  # best-effort — start ONLY these two services from qboard's compose (never
  # its mongo; the mesh's soa-connect-mongo-1 serves :27037).
  if docker compose -f "$QBOARD/docker-compose.yml" up -d livekit coturn >"$STATE/connect-av.log" 2>&1; then
    ok "connect AV up — livekit :7880 + coturn (qboard compose)"
  else
    printf "\033[33m⚠\033[0m livekit/coturn failed to start (AV unavailable; Connect still works CRDT-only) — see %s\n" "$STATE/connect-av.log"
  fi
}

# ── Recording stack (opt-in: --record [crdt|av]) ─────────────────────────────
# fleek's recorder + recordings-api + MinIO S3 stand-in (and, for av, the
# LiveKit egress sidecar) via fleek's compose + LOCAL overlay. `--no-deps` is
# load-bearing: the base compose would start fleek's bundled livekit, but
# locally qboard's livekit serves :7880 and its livekit.yaml already webhooks
# the recorder unconditionally (host.docker.internal:7889). Images build from
# source and need a CodeArtifact token (12h TTL; build-time only). Recording
# observes the LOCAL single-node RTSM via RTSM_BOOTSTRAP_URL (fleek recorder
# plumb — fleek feat/rtsm-bootstrap-url), and recordings-api runs with auth
# OFF + a dev identity (no saga cookie exists in this stack).
record_up(){ # mode: crdt|av
  local mode=${1:-crdt} token
  [[ -d "$FLEEK/.git" ]] || { printf "\033[31m✗\033[0m --record needs the fleek repo at %s (clone git@github.com:saga-ed/fleek.git)\n" "$FLEEK"; exit 1; }
  mkdir -p "$FLEEK_REC_DIR"
  # qboard's redis first (livekit.yaml names it; egress subscribes via the
  # :6380 host mapping — NOT the mesh redis on :6379), then recreate livekit
  # so it serves the CURRENT livekit.yaml webhook block.
  say "ensuring qboard redis + recreating livekit (recording wiring)…"
  if ! ( cd "$QBOARD" && docker compose up -d redis >>"$STATE/connect-av.log" 2>&1 \
        && docker compose up -d --force-recreate livekit >>"$STATE/connect-av.log" 2>&1 ); then
    printf "\033[31m✗\033[0m qboard redis/livekit failed — see %s\n" "$STATE/connect-av.log"; exit 1
  fi
  command -v aws >/dev/null 2>&1 || { printf "\033[31m✗\033[0m --record needs the AWS CLI (CodeArtifact token for the recorder image builds)\n"; exit 1; }
  say "fetching CodeArtifact token for the image builds (12h TTL; not written to disk)…"
  token=$(aws codeartifact get-authorization-token \
    --domain saga --domain-owner 531314149529 --region us-west-2 \
    ${AWS_PROFILE:+--profile "$AWS_PROFILE"} \
    --query authorizationToken --output text 2>"$STATE/record.log") || {
    printf "\033[31m✗\033[0m CodeArtifact token fetch failed (try: aws sso login):\n"
    sed 's/^/    /' "$STATE/record.log" 2>/dev/null; exit 1; }
  [[ -n "$token" && "$token" != None ]] || { printf "\033[31m✗\033[0m CodeArtifact returned an empty token\n"; exit 1; }
  local services=(recorder recordings-api minio minio-init)
  [[ "$mode" == av ]] && services+=(egress)
  say "building + starting recording stack: ${services[*]} (first build takes a while)…"
  if ! env CODEARTIFACT_AUTH_TOKEN="$token" \
      FLEEK_LOCAL_RECORDINGS_DIR="$FLEEK_REC_DIR" \
      FLEEK_LOCAL_EGRESS_CONFIG="$FLEEK/configs/egress-local.yaml" \
      RTSM_BOOTSTRAP_URL="http://127.0.0.1:$RTSM_PORT" \
      RECORDINGS_AUTH_ENABLED=false \
      RECORDINGS_DEV_USER_ID="$DEV_USER_UUID" \
      RECORDINGS_DEV_USER_ROLE=TUTOR \
      RECORDINGS_ALLOWED_ORIGINS="$CONNECT_WEB_URL" \
      SAGA_API_TARGET="$SAGA_API_TARGET" \
      docker compose -f "$FLEEK/docker-compose.yml" -f "$FLEEK/docker-compose.local.yml" \
        up -d --build --no-deps "${services[@]}" >>"$STATE/record.log" 2>&1; then
    printf "\033[31m✗\033[0m recording stack failed — tail %s\n" "$STATE/record.log"; exit 1
  fi
  for _ in $(seq 1 30); do
    [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$RECORDER_CONTROL_PORT/v1/health" 2>/dev/null)" == 200 ]] && break; sleep 1
  done
  [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$RECORDER_CONTROL_PORT/v1/health" 2>/dev/null)" == 200 ]] \
    && ok "fleek-recorder up :$RECORDER_CONTROL_PORT (webhook :7889)" \
    || printf "\033[33m⚠\033[0m fleek-recorder not healthy yet — tail %s\n" "$STATE/record.log"
  [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$RECORDINGS_API_PORT/healthz" 2>/dev/null)" == 200 ]] \
    && ok "fleek-recordings-api up :$RECORDINGS_API_PORT (auth off, dev identity)" \
    || printf "\033[33m⚠\033[0m fleek-recordings-api not healthy yet — tail %s\n" "$STATE/record.log"
  [[ "$mode" == av ]] && ok "egress up (AV recording; Chromium + 2GiB shm)" || true
  ok "recording stack up (mode: $mode) — recordings land in $FLEEK_REC_DIR"
}

# Run `pnpm install` in a repo, surfacing failures instead of swallowing them.
# A CodeArtifact 401 (token expires ~12h) is the most common prep failure — on a
# TTY, offer to refresh it (pnpm co:login) and retry inline; else exit with the
# fix. Previously this was `|| true`, so a 401 sailed on and died two steps later
# as a cryptic "prisma not found" (exit 254).
pnpm_install(){ # repo_dir
  local dir=$1 name=${1##*/} log="$STATE/prep-install.log" ans
  ( cd "$dir" && pnpm install ) >"$log" 2>&1 && return 0
  if grep -qiE 'ERR_PNPM_FETCH_401|Unauthorized' "$log"; then
    printf "\033[33m⚠\033[0m %s: pnpm install hit a CodeArtifact 401 (token expires ~12h)\n" "$name"
    # Interactive: ask before minting. Non-interactive (the e2e runner, CI-ish
    # wrappers): just try co:login — it's non-destructive and the alternative
    # is a guaranteed abort with the same command as homework.
    ans=y
    if [[ -t 0 ]]; then
      printf "  Refresh the token now (pnpm co:login) and retry? [Y/n] "; read -r ans || ans=
    fi
    if [[ "${ans:-y}" != [nN]* ]]; then
      say "pnpm co:login…"
      if ( cd "$dir" && pnpm co:login ) >>"$log" 2>&1 && ( cd "$dir" && pnpm install ) >>"$log" 2>&1; then
        ok "token refreshed + $name installed"; return 0
      fi
    fi
    printf "\033[31m✗\033[0m %s: install still failing on auth — run 'pnpm co:login' in %s, then re-run.\n" "$name" "$dir"
    exit 1
  fi
  printf "\033[31m✗\033[0m %s: pnpm install failed:\n" "$name"; tail -15 "$log" | sed 's/^/    /'; exit 1
}

# Run `pnpm build` in a repo, capturing output to $STATE/<name>-build.log.
# fatal=1 → a failure aborts with the log tail (qboard/rtsm: their services
# import workspace dist/ at launch, so an unbuilt tree is a guaranteed crash
# later with a far worse error). fatal=0 → loud-warn with the tail but
# continue (the pre-Connect repos keep their build-hiccups-are-non-fatal
# semantics — just visibly now, instead of `>/dev/null || true`).
build_step(){ # name dir fatal
  local name=$1 dir=$2 fatal=${3:-0}
  local log="$STATE/$name-build.log"   # separate statement: a single `local` expands all words before assigning (set -u)
  ( cd "$dir" && pnpm build ) >"$log" 2>&1 && return 0
  if [[ "$fatal" == 1 ]]; then
    printf "\033[31m✗\033[0m %s: pnpm build failed (%s):\n" "$name" "$log"
    tail -15 "$log" | sed 's/^/    /'
    exit 1
  fi
  printf "\033[33m⚠\033[0m %s: pnpm build failed (continuing — %s):\n" "$name" "$log"
  tail -5 "$log" | sed 's/^/    /'
  return 0
}

# Run a prisma/db command in $2, surfacing output on failure. These used to go to
# /dev/null with no `|| true`, so a failure died under set -e with nothing shown.
db_step(){ # label dir cmd...
  local label=$1 dir=$2; shift 2
  ( cd "$dir" && "$@" ) >"$STATE/prep-db.log" 2>&1 && return 0
  printf "\033[31m✗\033[0m %s failed:\n" "$label"; tail -15 "$STATE/prep-db.log" | sed 's/^/    /'
  grep -qiE 'prisma" not found|RECURSIVE_EXEC' "$STATE/prep-db.log" \
    && printf "  → looks like %s isn't installed — run 'pnpm install' there first.\n" "$dir"
  exit 1
}

# Provision an API's DB the canonical way — `prisma migrate deploy` (db:deploy),
# exactly what program-hub's ECS `migrate` job runs. migrate deploy replays the
# ordered migration SQL, so migration-only DDL that `schema.prisma` can't express
# (partial unique indexes, backfills, triggers…) is created correctly — unlike
# `db:push`, which only mirrors the schema and silently omits it. See
# decisions/d1.5. Wrinkle: a DB previously provisioned by `db:push` has schema
# but no `_prisma_migrations` history, so migrate deploy P3005s; detect that
# (one-time legacy/empty case) and convert via `migrate reset` (drops + replays
# from scratch — synthetic data is re-seeded via --seed).
migrate_db(){ # dir db_name [database_url — override to point prisma at the mesh]
  local dir=$1 db=$2 url=${3:-} pre=()
  [[ -n "$url" ]] && pre=(env "DATABASE_URL=$url")
  if [[ "$(docker exec soa-postgres-1 psql -U postgres_admin -d "$db" -tAc \
        "SELECT to_regclass('public._prisma_migrations') IS NOT NULL" 2>/dev/null)" == t ]]; then
    db_step "$db migrate deploy" "$dir" "${pre[@]+"${pre[@]}"}" pnpm db:deploy                    # migration-managed → apply pending (non-destructive)
  elif [[ "$(docker exec soa-postgres-1 psql -U postgres_admin -d "$db" -tAc \
        "SELECT count(*) FROM pg_tables WHERE schemaname='public'" 2>/dev/null)" == 0 ]]; then
    # Truly EMPTY DB (fresh mesh volume / just-created): migrate deploy replays
    # the full migration history non-destructively — same end state as reset
    # with nothing to drop. Keeps the destructive path off fresh provisions
    # (prisma 7 also gates `migrate reset` behind an AI-consent prompt when it
    # detects an agent, which would wedge an unattended bootstrap here).
    db_step "$db migrate deploy (empty db)" "$dir" "${pre[@]+"${pre[@]}"}" pnpm db:deploy
  else
    db_step "$db migrate reset"  "$dir" "${pre[@]+"${pre[@]}"}" pnpm prisma migrate reset --force  # unmanaged (db:push'd, no history) → drop + replay all
  fi
}

# --pull: fast-forward each sibling repo to its upstream before building. ff-ONLY,
# skipping repos that are dirty, detached, upstream-less, or diverged (with a
# warning) — so it never clobbers local work or moves you off a feature branch.
# Kills the recurring trap of building/migrating a checkout silently behind origin
# (e.g. program-hub hundreds of commits stale → 404s on new endpoints).
pull_repos(){
  say "pulling siblings to upstream (ff-only)…"
  local kv dir name dirty br behind
  for kv in "$SOA:soa" "$ROSTERING:rostering" "$PROGRAM_HUB:program-hub" \
            "$SAGA_DASH:saga-dash" "$SDS:student-data-system" "$QBOARD:qboard" \
            "$RTSM:rtsm"; do
    dir=${kv%:*}; name=${kv#*:}
    [[ -d "$dir/.git" ]] || { printf "\033[33m⚠\033[0m %-20s not cloned — skipping\n" "$name"; continue; }
    dirty=$(git -C "$dir" status --porcelain 2>/dev/null | grep -v '^??' || true)
    [[ -z "$dirty" ]] || { printf "\033[33m⚠\033[0m %-20s uncommitted changes — skipping\n" "$name"; continue; }
    git -C "$dir" fetch -q origin 2>/dev/null || { printf "\033[33m⚠\033[0m %-20s fetch failed — skipping\n" "$name"; continue; }
    br=$(git -C "$dir" branch --show-current 2>/dev/null)
    [[ -n "$br" ]] || { printf "\033[33m⚠\033[0m %-20s detached HEAD — skipping\n" "$name"; continue; }
    git -C "$dir" rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1 || { printf "\033[33m⚠\033[0m %-20s %s has no upstream — skipping\n" "$name" "$br"; continue; }
    behind=$(git -C "$dir" rev-list --count "HEAD..@{u}" 2>/dev/null || echo 0)
    if [[ "$behind" -eq 0 ]]; then ok "$name up to date ($br)"; continue; fi
    if git -C "$dir" merge --ff-only '@{u}' >/dev/null 2>&1; then
      ok "$name fast-forwarded $behind commit(s) ($br)"
    else
      printf "\033[33m⚠\033[0m %-20s %s diverged from upstream — skipping (pull by hand)\n" "$name" "$br"
    fi
  done
}

prep(){
  say "reconciling rostering deps + workspace build (main switch is not dep-neutral)…"
  pnpm_install "$ROSTERING"
  build_step rostering "$ROSTERING"                                # build hiccups are non-fatal (but visible)
  say "reconciling program-hub deps + workspace build (new deps / stale workspace dist after a main pull)..."
  pnpm_install "$PROGRAM_HUB"
  build_step program-hub "$PROGRAM_HUB"
  # ads-adm-api imports the @saga-ed/ads-adm-db workspace package from dist/ —
  # on a fresh clone that dist/ doesn't exist until the sds workspace is built,
  # so install + build sds too (mirrors rostering/program-hub above). The sds
  # *-db packages' builds (tsup) assume an already-generated Prisma client at
  # src/prisma/generated/ — turbo's build graph doesn't run db:generate, so
  # generate FIRST for every package that declares the script (ads-adm-db,
  # chat-db, insights-db, ledger-db, transcripts-db, and whatever arrives
  # next) or the build and the runtime import of dist/prisma/generated fail.
  say "reconciling student-data-system deps + workspace build (ads-adm-db dist for ads-adm-api)..."
  pnpm_install "$SDS"
  local dbpkg
  for dbpkg in "$SDS"/packages/node/*/; do
    grep -q '"db:generate"' "$dbpkg/package.json" 2>/dev/null || continue
    ( cd "$dbpkg" && pnpm db:generate >/dev/null 2>&1 ) || true
  done
  build_step student-data-system "$SDS"
  # saga-dash runs via `vite dev` (no prebuild), but vite must be installed or the
  # launch dies with "vite: not found" — and prep installs it nowhere else, so a
  # freshly-cloned or freshly-pulled dash would 404 the whole UI. Install it here.
  say "reconciling saga-dash deps (vite)…"
  pnpm_install "$SAGA_DASH"
  # qboard: connect-api runs via tsx watch and connect-web via vite (no
  # prebuild), but their workspace deps (qboard-lib, qboard-sync, iam-auth…)
  # resolve from dist/, so install + best-effort build like the others. NO
  # migrate step: Connect's mongo has no schema — collections auto-create.
  say "reconciling qboard deps + workspace build (connect-api/-web)…"
  pnpm_install "$QBOARD"
  build_step qboard "$QBOARD" 1
  # rtsm: stateless single-node service — install + build its workspace deps;
  # no migrate/seed step (no DB at all).
  say "reconciling rtsm deps + workspace build (rtsm-api)…"
  pnpm_install "$RTSM"
  build_step rtsm "$RTSM" 1
  say "applying prisma schemas (migrate deploy — canonical, see d1.5)…"
  db_step "iam-db migrate deploy"     "$ROSTERING/packages/node/iam-db"     pnpm prisma migrate deploy
  db_step "iam-pii-db db push"        "$ROSTERING/packages/node/iam-pii-db" pnpm prisma db push
  migrate_db "$PROGRAM_HUB/apps/node/programs-api"   programs   "$PROGRAMS_DB_URL"
  migrate_db "$PROGRAM_HUB/apps/node/scheduling-api" scheduling "$SCHEDULING_DB_URL"
  # sessions-api (program-hub #148 harvest) owns a `sessions` DB. The mesh seed
  # (profile-empty.sql) creates it on FIRST postgres init only — a mesh volume
  # initialized before sessions-api existed won't have it, so ensure it here.
  if [[ "$(docker exec soa-postgres-1 psql -U postgres_admin -tAc \
        "SELECT 1 FROM pg_database WHERE datname='sessions'" 2>/dev/null)" != 1 ]]; then
    db_step "sessions db create" "$SOA" docker exec soa-postgres-1 \
      psql -U postgres_admin -c "CREATE DATABASE sessions OWNER saga_user"
  fi
  migrate_db "$PROGRAM_HUB/apps/node/sessions-api"   sessions   "$SESSIONS_DB_URL"
  # content-api owns a `content` DB (same first-postgres-init caveat as sessions).
  if [[ "$(docker exec soa-postgres-1 psql -U postgres_admin -tAc \
        "SELECT 1 FROM pg_database WHERE datname='content'" 2>/dev/null)" != 1 ]]; then
    db_step "content db create" "$SOA" docker exec soa-postgres-1 \
      psql -U postgres_admin -c "CREATE DATABASE content OWNER saga_user"
  fi
  migrate_db "$PROGRAM_HUB/apps/node/content-api"    content    "$CONTENT_DB_URL"
  migrate_db "$ROSTERING/packages/node/sis-db"       sis_db   # sis-api schema (d1.7); uses sis-db's own config
  db_step "ads-adm-db migrate deploy" "$SDS/packages/node/ads-adm-db"       pnpm prisma migrate deploy
  say "seeding dev user ($DEV_USER_UUID)…"
  ( cd "$ROSTERING/packages/node/iam-db" && env $(grep -v '^#' "$ROSTERING/.env.local" | xargs) node dist/seed-dev-user.js >/dev/null 2>&1 ) || true
  ok "schemas + dev user ready"
}

# Health-probe path per service. APIs expose /health; the two vite apps
# (saga-dash, connect-web) answer on /; connect-api mounts its router under
# /connectv3/v1 (qboard apps/node/connectv3-api/src/app.ts).
probe_path(){ # name
  case "$1" in
    saga-dash|connect-web) echo / ;;
    connect-api)           echo /connectv3/v1/health ;;
    *)                     echo /health ;;
  esac
}

# ── hybrid helpers (--only / --sandbox) ─────────────────────────────────
# want_service: under --only, launch ONLY the named service; otherwise launch
# all (the normal full-local stack).
want_service(){ # svc
  [[ -z "$ONLY_SERVICE" || "$ONLY_SERVICE" == "$1" ]]
}
# launch_if: gate launch by want_service and RECORD any real failure. A service
# filtered out by --only is a clean skip; a launched service that fails its
# health check (launch → 1) sets SERVICES_RC=1, which services_up returns so the
# set -e caller aborts before reset/seed/login. We accumulate into SERVICES_RC
# rather than relying on each call's own exit code because services_up's return
# is only its LAST statement — a failing non-last service would otherwise be
# masked by a later clean skip. (We also avoid the inline `want_service x &&
# launch x` form: launch on the right of && is set -e-exempt, silently ignored.)
SERVICES_RC=0
launch_if(){ # svc port dir extra_env...
  want_service "$1" || return 0
  launch "$@" || SERVICES_RC=1
}
# sandbox_env: emit the env-var KEY=VAL pairs that repoint a locally-run
# service's CROSS-SERVICE dependency URLs at a cloud sandbox, instead of the
# local mesh. Prints nothing when SANDBOX_NAME is unset (pure-local mode), so
# it's a no-op safe to splat into every launch line: `launch x ... $(sandbox_env x)`.
#
# This ONLY flips the dependency URL (localhost → https://<dep-host>.$SANDBOX_BASE).
# It deliberately does NOT try to set the preview-routing header via env: the
# services read it from getPreviewHeaders() (AsyncLocalStorage populated per
# INBOUND request) — there is no env var that makes a service ORIGINATE
# `x-saga-preview-<dep>: sandbox-<name>` for its own outbound calls. The header
# must enter at the request boundary (the dash, or your curl/test harness) and
# forward-propagate. A backend hit WITHOUT that header silently routes its iam
# calls to MAIN (empty variant), not the sandbox — see the warning printed at
# launch, and the design doc (INTEGRATION.md, alongside this script).
# Only iam-api is wired today (the proven single-dep shape); programs/scheduling/
# sessions deps are additive once the multi-service mesh compose is unblocked.
sandbox_env(){ # svc
  [[ -z "$SANDBOX_NAME" ]] && return 0
  local svc=$1 iam_host="https://iam.$SANDBOX_BASE"
  case "$svc" in
    sis-api)
      printf '%s\n' "IAM_BASEURL=$iam_host/trpc" "IAM_TOKENURL=$iam_host/v1/oauth/token" ;;
    programs-api|scheduling-api|sessions-api)
      printf '%s\n' "IAM_API_URL=$iam_host" ;;
    *) ;; # iam-api itself / saga-dash / ads-adm / rtsm / connect: no repoint wired (yet)
  esac
}
# tunnel_env: browser-plane env overrides for --tunnel (sandbox_env's sibling;
# same splat-no-op contract — prints nothing unless TUNNEL=1). Splatted LAST on
# each launch line, so its keys win over the local defaults (`env A=1 A=2` →
# last wins). What flips, and why only this:
#   - iam-api: AUTH_SESSIONCOOKIEDOMAIN=.<moniker>.$VMS_BASE — the iam_session
#     cookie must flow across iam./connect-api./dash. tunnel hosts (locally the
#     same trick is free: localhost cookies ignore ports). Env name follows the
#     verified AUTH flattening (devUserId ↔ AUTH_DEVUSERID; AuthConfigSchema
#     sessionCookieDomain, rostering schemas.ts:173). Scoped per-moniker, NOT
#     .$VMS_BASE, so two devs' instances can't read each other's sessions.
#     CORS needs nothing: soa-api-util's dev allowlist already wildcard-matches
#     *.wootdev.com at any depth (cors.test.ts: pr-12.dash.wootdev.com passes),
#     and rtsm subdomain-matches its parent-domain list (wootdev.com included).
#   - connect-api: ALLOWED_ORIGINS gains the tunnel connect-web origin (qboard
#     uses an exact-origin list, not the soa wildcard); PUBLIC_API_URL becomes
#     the public name (recorder callbacks / absolute-URL surfaces).
#   - connect-web: VITE_* dependency URLs flip to the tunnel hosts — these are
#     BROWSER-side (a remote coworker's browser must reach connect-api/iam/rtsm
#     via public names). Server-to-server URLs (IAM_API_URL etc.) stay local.
#   - vite host check: __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS lets the vite dev
#     servers accept the tunnel Host header (DNS-rebind protection would 403 an
#     unknown host). Best-effort: vite ≥6.1 reads it; older vite either has no
#     host check or needs server.allowedHosts in the app's vite config.
# REMOTE dash: works when saga-dash carries PR #194 (the `url` override type +
# the config.local.json local-override seam — pin it in
# integration-suite.local.tsv until it lands); services_up's
# sync_dash_local_defaults writes an untracked config.local.json the dash
# overlays onto its tracked config.json (no tracked-file mutation). AV (LiveKit)
# is UDP and doesn't traverse tunnels: remote users get CRDT/chat (rtsm is
# websockets); for AV point FLEEK_TOPOLOGY_JSON at the real fleek dev cluster.
tunnel_env(){ # svc
  [[ "$TUNNEL" == 0 ]] && return 0
  local svc=$1
  # CORS: do NOT rely on each service's built-in wootdev wildcard — iam-api
  # (api-util allowlist) has one, but sis-api is a plain `cors` exact-string
  # list (rostering sis-api/src/main.ts:71 — found the hard way: tunnel dash
  # got 'no Access-Control-Allow-Origin' from sis), and the others are
  # unaudited. Tunnel mode passes the tunnel origins EXPLICITLY everywhere a
  # browser calls; these splat after the launch line's CORS_ORIGIN, so they
  # win (env last-wins).
  case "$svc" in
    iam-api)
      printf '%s\n' "AUTH_SESSIONCOOKIEDOMAIN=.$TUNNEL_DOMAIN" \
                    "CORS_ORIGIN=$DASH_URL,$CONNECT_WEB_URL,https://dash.$TUNNEL_DOMAIN,https://connect.$TUNNEL_DOMAIN" ;;
    sis-api)
      # include the iam demo-page origins (local + tunnel): the demo page
      # drives sis directly, and setting CORS_ORIGIN overrides sis's built-in
      # localhost:3010 default (rostering #391)
      printf '%s\n' "CORS_ORIGIN=$DASH_URL,http://localhost:$IAM_PORT,https://dash.$TUNNEL_DOMAIN,https://iam.$TUNNEL_DOMAIN" ;;
    programs-api|scheduling-api|sessions-api|ads-adm-api)
      printf '%s\n' "CORS_ORIGIN=$DASH_URL,https://dash.$TUNNEL_DOMAIN" ;;
    connect-api)
      # JANUS_LOGIN_HOST: where 401s send the browser. Default is the REAL dev
      # fleet's login (login.wootdev.com), which "succeeds" via the employee
      # janus gate and mints a real-dev iam_session our local iam can't verify
      # → redirect LOOP. Point it at the tunneled iam's demo page (devLogin)
      # instead — buildIamLoginUrl/new URL preserves the /demo path.
      printf '%s\n' "ALLOWED_ORIGINS=$CONNECT_WEB_URL,https://connect.$TUNNEL_DOMAIN" \
                    "PUBLIC_API_URL=https://connect-api.$TUNNEL_DOMAIN" \
                    "JANUS_LOGIN_HOST=iam.$TUNNEL_DOMAIN/demo"
      # AV → fleek dev cluster when the creds fetch succeeded (tunnel block).
      # Splatted after the launch line's local FLEEK_TOPOLOGY_JSON/LIVEKIT_*,
      # so these win (env last-wins). Values are space-free by construction
      # (compact JSON) — safe through the $() splat.
      if [[ -n "$TUNNEL_LK_KEY" && -n "$TUNNEL_LK_SECRET" ]]; then
        printf '%s\n' "FLEEK_TOPOLOGY_JSON=$TUNNEL_FLEEK_TOPOLOGY" \
                      "LIVEKIT_API_KEY=$TUNNEL_LK_KEY" \
                      "LIVEKIT_API_SECRET=$TUNNEL_LK_SECRET"
      fi ;;
    connect-web)
      printf '%s\n' "VITE_CONNECTV3_API_URL=https://connect-api.$TUNNEL_DOMAIN" \
                    "VITE_IAM_API_URL=https://iam.$TUNNEL_DOMAIN" \
                    "VITE_RTSM_BOOTSTRAP_URL=https://rtsm.$TUNNEL_DOMAIN" \
                    "VITE_JANUS_LOGIN_HOST=https://iam.$TUNNEL_DOMAIN/demo" \
                    "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=connect.$TUNNEL_DOMAIN" ;;
    rtsm-api)
      # Generated in the --tunnel resolution block; advertises the tunnel host
      # as the node endpoint so discovery returns a reachable URL.
      printf '%s\n' "FLEET_CONFIG_PATH=$STATE/rtsm-fleet-tunnel.json" ;;
    saga-dash)
      printf '%s\n' "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=dash.$TUNNEL_DOMAIN" ;;
    *) ;; # everything else: dev CORS wildcard already admits *.wootdev.com
  esac
}

# sync_dash_local_defaults: point the dash's API routing at the tunnel hosts in
# tunnel mode — via an UNTRACKED static/config.local.json that the dash overlays
# onto its tracked config.json (saga-dash #194's dev-only local-override seam;
# lib/api/config.ts mergeLocalTopology). Tunnel mode WRITES it (url-type
# localDefaults → https://<svc>.<moniker>.vms…); any other mode REMOVES it so
# the dash falls back to the tracked localhost defaults. Deliberately never
# touches the tracked config.json — no dirty tree, no moniker baked into a
# committed file, no `git checkout` dance before refresh-suite.
# REQUIRES saga-dash #194 (the `url` type + the config.local.json seam): on a
# dash without it the file is simply ignored and the dash uses localhost (so a
# remote browser can't reach the APIs — but it fails safe, no real-fleet
# misroute). Pin #194 in integration-suite.local.tsv until it lands.
sync_dash_local_defaults(){
  local LOCAL_CFG="$SAGA_DASH/apps/web/dash/static/config.local.json"
  [[ -d "$SAGA_DASH/apps/web/dash/static" ]] || return 0
  if [[ "$TUNNEL" != 1 ]]; then
    [[ -f "$LOCAL_CFG" ]] && { rm -f "$LOCAL_CFG"; ok "saga-dash: removed config.local.json (localhost defaults)"; }
    return 0
  fi
  # dash service key → tunnel host label (<label>.<TUNNEL_DOMAIN>)
  if node -e '
    const fs = require("fs");
    const [out, domain] = process.argv.slice(1);
    const map = { "iam":"iam", "program-hub":"programs", "enrollment-api":"programs",
      "scheduling-api":"scheduling", "sessions-api":"sessions", "sis-api":"sis", "connect":"connect" };
    const localDefaults = {};
    for (const [key, label] of Object.entries(map)) localDefaults[key] = { type: "url", url: `https://${label}.${domain}` };
    fs.writeFileSync(out, JSON.stringify({ localDefaults }, null, 2) + "\n");
  ' "$LOCAL_CFG" "$TUNNEL_DOMAIN" 2>/dev/null; then
    ok "saga-dash: wrote config.local.json → https://<svc>.$TUNNEL_DOMAIN (untracked; needs dash #194)"
  else
    printf "\033[33m⚠\033[0m could not write %s (tunnel dash routing falls back to localhost)\n" "$LOCAL_CFG"
  fi
}

launch(){ # name port dir extra_env...
  local name=$1 port=$2 dir=$3 probe; shift 3
  probe=$(probe_path "$name")
  [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:$port$probe 2>/dev/null)" == 200 ]] && { ok "$name already up :$port"; return; }
  say "starting $name on :$port…"
  ( cd "$dir"; env "$@" nohup pnpm dev >"$STATE/$name.log" 2>&1 & echo $! >"$STATE/$name.pid" )
  for _ in $(seq 1 40); do
    [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:$port$probe 2>/dev/null)" == 200 ]] && { ok "$name up :$port"; return; }
    sleep 1
  done
  printf "\033[31m✗\033[0m %s failed on :%s — tail %s\n" "$name" "$port" "$STATE/$name.log"; return 1
}

services_up(){
  SERVICES_RC=0   # reset so a second call (restart) doesn't carry a stale failure
  # Config-file deps first: the dash reads localDefaults at page load, so the
  # file must match the mode BEFORE saga-dash (re)launches/HMRs.
  sync_dash_local_defaults
  # Drift: soa-logger/soa-config on main now require a PINO_LOGGER config with
  # no defaults — `level` + `isExpressContext` (DotenvConfigManager reads them as
  # PINO_LOGGER_LEVEL / PINO_LOGGER_ISEXPRESSCONTEXT). Every soa node service
  # validates this at startup, so export once here; all `env "$@" pnpm dev`
  # children inherit it. `:-` lets an external override win. Seed paths use
  # seed-mode (logger config inline) so they're unaffected.
  export PINO_LOGGER_LEVEL="${PINO_LOGGER_LEVEL:-info}"
  export PINO_LOGGER_ISEXPRESSCONTEXT="${PINO_LOGGER_ISEXPRESSCONTEXT:-true}"
  # AUTH_DEVUSERID must be the seeded dev-user UUID (iam-api refuses to boot with
  # the 'dev-user-001' default when AUTH_ENABLED=false). apply_fixes only set this
  # via sed on iam-api/.env, which doesn't exist on a fresh clone — pass it on the
  # launch env so it's independent of that file.
  # CORS_ORIGIN: the dash runs on :8900, but every soa API's dev CORS allowlist
  # (@saga-ed/soa-api-util buildSagaOriginAllowlist) hardcodes only 5173/3006 +
  # *.wootdev.com — it adds the dash origin only if CORS_ORIGIN is set. Without
  # it the browser blocks the dash's cross-origin calls and the dash shows
  # "can't reach the identity service" (iam whoami) / silently drops programs.
  # Pass it to every dash-facing API (ads-adm-api already sets it below).
  # Each service goes through launch_if (so --only <svc> runs just one) and
  # splats $(sandbox_env <svc>) — a no-op unless --sandbox repoints its deps at
  # a cloud sandbox. Order/env are otherwise unchanged from the full-local stack.
  # launch_if preserves launch's exit code, so a real boot failure still aborts
  # the set -e caller before reset/seed/login (fail-fast), while a service merely
  # filtered out by --only is a clean skip.
  # CORS_ORIGIN is COMMA-SEPARATED (api-util ≥1.2.0) — iam-api also gets the
  # connect-web origin, because connect-web's iam-client calls iam DIRECTLY
  # from the browser (personas.getMyPermissions, memberships, whoami…).
  launch_if iam-api "$IAM_PORT" "$ROSTERING/apps/node/iam-api" PORT="$IAM_PORT" AUTH_DEVUSERID="$DEV_USER_UUID" CORS_ORIGIN="$DASH_URL,$CONNECT_WEB_URL" $(tunnel_env iam-api)
  # sis-api → iam-api service.* over S2S; no creds locally (iam-api dev-bypass
  # synthesizes a service actor when auth is off). IAM_BASEURL/IAM_TOKENURL must
  # point at iam on :3010 (sis-api defaults to :3000). See d1.7. Under --sandbox
  # those two flip to the cloud iam host (sandbox_env), and a REAL S2S token is
  # then required — the cloud iam has auth ON (no dev-bypass); see integration doc.
  launch_if sis-api "$SIS_PORT" "$ROSTERING/apps/node/sis-api" \
     NODE_ENV=development PORT="$SIS_PORT" \
     SIS_DATABASE_URL="$SIS_DB_URL" CORS_ORIGIN="$DASH_URL" \
     IAM_BASEURL="$IAM_URL/trpc" IAM_TOKENURL="$IAM_URL/v1/oauth/token" \
     $(sandbox_env sis-api) $(tunnel_env sis-api)
  launch_if programs-api 3006 "$PROGRAM_HUB/apps/node/programs-api"     NODE_ENV=development DATABASE_URL="$PROGRAMS_DB_URL"   IAM_API_URL="$IAM_URL" RABBITMQ_URL="$MESH_MQ" JANUS_REQUIRED=false CORS_ORIGIN="$DASH_URL" $(sandbox_env programs-api) $(tunnel_env programs-api)
  launch_if scheduling-api 3008 "$PROGRAM_HUB/apps/node/scheduling-api" NODE_ENV=development DATABASE_URL="$SCHEDULING_DB_URL" IAM_API_URL="$IAM_URL" RABBITMQ_URL="$MESH_MQ" JANUS_REQUIRED=false CORS_ORIGIN="$DASH_URL" $(sandbox_env scheduling-api) $(tunnel_env scheduling-api)
  # sessions-api: DATABASE_URL + IAM_API_URL are REQUIRED (it throws without
  # them); its RABBITMQ_URL default is program-hub's standalone :5673, so point
  # it at the mesh. SCHEDULING_API_URL defaults to :3008 (already the mesh
  # port) and it doesn't read JANUS_REQUIRED, so neither is set. Pre-existing
  # program data needs a one-time manual replay (see header note).
  launch_if sessions-api 3007 "$PROGRAM_HUB/apps/node/sessions-api"     NODE_ENV=development DATABASE_URL="$SESSIONS_DB_URL"   IAM_API_URL="$IAM_URL" RABBITMQ_URL="$MESH_MQ" CORS_ORIGIN="$DASH_URL" $(sandbox_env sessions-api) $(tunnel_env sessions-api)
  # content-api (:3009 — default :3010 collides with iam): the MODERN poll/content
  # store. The dash picker reads it from the browser (CORS → dash origin) and
  # connect-api resolves contentRef→body from it S2S. RABBITMQ for its outbox events.
  launch_if content-api "$CONTENT_PORT" "$PROGRAM_HUB/apps/node/content-api"     NODE_ENV=development PORT="$CONTENT_PORT" DATABASE_URL="$CONTENT_DB_URL"   IAM_API_URL="$IAM_URL" RABBITMQ_URL="$MESH_MQ" CORS_ORIGIN="$DASH_URL" $(tunnel_env content-api)
  launch_if ads-adm-api 5005 "$SDS/apps/node/ads-adm-api" \
     ADS_ADM_SCHEDULE_PROVIDER=mock \
     ADS_ADM_DATABASE_URL=postgresql://ads_adm:ads_adm@localhost:5432/ads_adm_local \
     DATABASE_URL=postgresql://ads_adm:ads_adm@localhost:5432/ads_adm_local \
     CORS_ORIGIN=http://localhost:8900 RABBITMQ_URL="$MESH_MQ" $(tunnel_env ads-adm-api)
  launch_if saga-dash 8900 "$SAGA_DASH/apps/web/dash" $(tunnel_env saga-dash)
  # rtsm-api: a ONE-NODE FLEET, not bare single-instance mode. rtsm-client
  # always discovers via GET /fleet/discover (404 without fleet mode → the
  # browser's "Fleet discovery failed … Fleet mode may not be active"), so the
  # local node must serve it. FLEET_CONFIG_PATH (overrides /opt/fleet.json —
  # no sudo) names this node as the fleet's only member with the
  # browser-visible endpoint http://localhost:6110; with no peers the mesh
  # half stays idle. Its committed .env already sets port 6110 + auth none;
  # EXPRESS_SERVER_PORT is passed anyway so the stack pins it explicitly.
  # CORS allows localhost/127.0.0.1 origins unconditionally in its config.
  launch_if rtsm-api "$RTSM_PORT" "$RTSM/apps/node/rtsm-api" \
     EXPRESS_SERVER_PORT="$RTSM_PORT" \
     FLEET_CONFIG_PATH="$SCRIPT_DIR/rtsm-fleet-local.json" FLEET_NODE_NAME=local \
     $(tunnel_env rtsm-api)
  # connect-api: verifies the SAME iam_session JWT the dash flow mints (JWKS
  # from local iam). Its issuer default is the wootdev iam, so override
  # JWT_ISSUER to local iam-api's JwtConfigSchema default (rostering
  # config/schemas.ts: https://iam.saga.org); audience already matches
  # (saga-platform). JANUS_REQUIRED=false = same literal-false bypass as the
  # other services. SAGA_API_TARGET is legacy poll content (unauthenticated
  # endpoint — see header). LiveKit creds match qboard's local container.
  launch_if connect-api "$CONNECT_API_PORT" "$QBOARD/apps/node/connectv3-api" \
     PORT="$CONNECT_API_PORT" \
     MONGO_URI="$CONNECT_MONGO_URI" \
     AUTH_ENABLED=true JANUS_REQUIRED=false \
     IAM_API_URL="$IAM_URL" JWT_ISSUER="https://iam.saga.org" \
     ALLOWED_ORIGINS="$CONNECT_WEB_URL" \
     SESSIONS_API_BASE_URL="http://localhost:3007" \
     SAGA_API_TARGET="$SAGA_API_TARGET" \
     CONTENT_API_URL="$CONTENT_API_URL" \
     PUBLIC_API_URL="$CONNECT_API_URL" \
     LIVEKIT_URL="ws://localhost:7880" LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=devsecret \
     RECORDING_SERVICE_TOKEN="$RECORDING_TOKEN" \
     RECORDER_URL_TEMPLATE="http://127.0.0.1:$RECORDER_CONTROL_PORT" \
     FLEEK_TOPOLOGY_JSON='{"cityMap":{"_default":"ws://localhost:7880"},"nodes":{"local":{"url":"ws://localhost:7880"}}}' \
     $(tunnel_env connect-api)
  # connect-web: vite on :6210 (its own config default). VITE_RTSM_BOOTSTRAP_URL
  # points the rtsm-client at the LOCAL single-node rtsm-api (it overrides
  # domain-based fleet discovery). On a qboard checkout without the plumb the
  # var is ignored and connect-web falls back to the wootdev.com fleet —
  # graceful either way. `?rtsm_url=` on the Connect URL overrides per-tab.
  # Recorder env (RECORDING_SERVICE_TOKEN / RECORDER_URL_TEMPLATE above) and
  # the playback override here are set UNCONDITIONALLY: harmless when the
  # recording stack is down (plan pushes only happen when a session records;
  # playback only fetches when manifests exist), and it means a later
  # `./up.sh --record` works without relaunching connect-api/-web.
  # FLEEK_TOPOLOGY_JSON: REQUIRED for plan pushes to happen at all locally —
  # fleekNodeFromUrl(ws://localhost:7880) is null via the prod hostname
  # pattern (plan push silently skipped, recorder logs skipped_plan_missing);
  # the topology's nodes.url block maps the local LiveKit URL → node "local",
  # which RECORDER_URL_TEMPLATE then resolves (no {node} placeholder needed).
  launch_if connect-web "$CONNECT_WEB_PORT" "$QBOARD/apps/web/connectv3" \
     VITE_CONNECTV3_API_URL="$CONNECT_API_URL" \
     VITE_IAM_API_URL="$IAM_URL" \
     VITE_SAGA_API_TARGET="$SAGA_API_TARGET" \
     VITE_RTSM_BOOTSTRAP_URL="$RTSM_URL" \
     VITE_PLAYBACK_ASSET_BASE_OVERRIDE="http://localhost:$RECORDINGS_API_PORT" \
     $(tunnel_env connect-web)
  return "$SERVICES_RC"   # non-zero iff a LAUNCHED service failed (skips don't count)
}

# ── reset: truncate synthetic data to an empty baseline ──────────────
# Not a "post-delete of seeded data" — a clean baseline BEFORE seeding, so any
# --seed mode is reproducible regardless of prior state. Needed because iam
# groups don't dedup (re-running the roster on a non-empty iam duplicates it).
# Preserves _prisma_migrations so no re-migrate. Uses the mesh superuser
# (postgres_admin) so it can truncate tables owned by iam / saga_user / etc.
reset_data(){
  say "resetting synthetic data → empty baseline (iam, programs, scheduling, sessions, sis, connect)…"
  local trunc="DO \$\$ DECLARE r RECORD; BEGIN FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' LOOP EXECUTE 'TRUNCATE TABLE public.'||quote_ident(r.tablename)||' RESTART IDENTITY CASCADE'; END LOOP; END \$\$;"
  # `sessions` truncation also clears its consumed-event cursors, so its
  # event-built projections re-converge from the producers' outbox replay.
  for db in iam_local iam_pii_local programs scheduling sessions content sis_db; do
    if docker exec -i soa-postgres-1 psql -U postgres_admin -d "$db" -v ON_ERROR_STOP=1 -c "$trunc" >/dev/null 2>&1; then
      ok "truncated $db"
    else
      printf "\033[33m⚠\033[0m could not truncate %s (does it exist? is mesh up?)\n" "$db"
    fi
  done
  # Connect's mongo: drop the whole DB (session-scoped CRDT/chat/lifecycle data
  # — all of it is "synthetic session residue"; collections auto-recreate on
  # first write, so a drop IS the empty baseline; no migrations to preserve).
  # `connectv3` is connect-api's MONGO_DB_NAME default — the db it actually
  # writes (NOT the URI path).
  if docker exec soa-connect-mongo-1 mongosh --quiet --eval \
       'db.getSiblingDB("connectv3").dropDatabase()' >/dev/null 2>&1; then
    ok "dropped connectv3 (connect mongo)"
  else
    printf "\033[33m⚠\033[0m could not drop connectv3 (is connect-mongo up?)\n"
  fi
  say "re-seeding dev user ($DEV_USER_UUID)…"
  ( cd "$ROSTERING/packages/node/iam-db" && env $(grep -v '^#' "$ROSTERING/.env.local" | xargs) node dist/seed-dev-user.js >/dev/null 2>&1 ) || true
  ok "reset complete — empty roster/programs/scheduling baseline"
}

# ── seeding (db:seed — Seth's deterministic model, synthetic-dev-align) ──
# Base seed is now `db:seed` (deterministic @saga-ed/*-seed-ids ids written
# STRAIGHT to the DB) — NOT the old scenario-over-HTTP. So seeding no longer
# needs a running iam-api, JANUS off, the rate-limit bump, or the JWT cookie
# contract; the data matches preview/CI exactly and stable ids survive --reset.
# (LOGIN still uses iam-api devLogin + JANUS_REQUIRED=false — see login_user();
# that bypass is independent of seeding and is preserved.) The scenario scripts
# remain in their repos as the future "journey" layer. See plan
# soa/claude/projects/synthetic-dev-align/plans/up-sh-db-seed-transition.md and
# d2.1 (db:seed = 205 users: 190 roster + 6 personas + dev + 8 Connect Demo).
seed_iam(){
  say "seeding iam roster (db:seed — deterministic seed-ids, direct DB)…"
  # Load DATABASE_URL/PII_DATABASE_URL + PII_DEK/HMAC from .env.local so the seed
  # writes encrypted names/emails too (without the PII keys it silently skips
  # them and the dash shows blanks). Same env-load the dev-user seed uses.
  ( cd "$ROSTERING/packages/node/iam-db" \
      && env $(grep -v '^#' "$ROSTERING/.env.local" | xargs) pnpm db:seed )
  ok "iam roster seeded (db:seed; deterministic ids) — see --status"
}

# Seeds programs/periods/enrollment via programs-api's db:seed. Deterministic and
# OFFLINE — derives org/district ids from @saga-ed/iam-seed-ids (agrees with
# iam-db) with no HTTP. We pass DATABASE_URL explicitly (mesh :5432, matching
# programs-api/.env) and deliberately OMIT IAM_API_URL: with it set the seed
# attempts a protected groups lookup that 401s in a script context before falling
# back to derived ids anyway. See plan R3.
seed_programs(){
  say "seeding programs (db:seed — deterministic, offline derived ids)…"
  ( cd "$PROGRAM_HUB/apps/node/programs-api" \
      && env DATABASE_URL="$PROGRAMS_DB_URL" pnpm db:seed )
  ok "programs seeded (db:seed)"
}

# sessions-api db:seed — the Connect-demo DIRECT-PROJECTION seed. Writes
# sessions-api's local projection tables (demo programs/periods/pods/slots,
# deterministic @saga-ed/demo-seed-ids — pairs with the 8 Connect Demo users
# in iam's db:seed) AND the `projection_readiness` warm row, straight to the
# DB. Cold-start immune by design: no relay/consumers needed, so the read
# gate ("projection sessions-api.authz-projection is warming" → 408 → connect
# /my-sessions 500s) opens even on the event-less db:seed lane.
seed_sessions(){
  say "seeding sessions projections (db:seed — Connect demo, direct projections + readiness)…"
  ( cd "$PROGRAM_HUB/apps/node/sessions-api" \
      && env DATABASE_URL="$SESSIONS_DB_URL" pnpm db:seed )
  ok "sessions projections seeded (demo programs render + authorize)"
}

# content-api: catalog (db:seed, direct DB) + obvious demo polls (HTTP authoring),
# plus an optional REAL decoded legacy poll IF the (unmerged) migration tool is
# present. Runs after services_up, so the HTTP steps reach content-api on :3009.
# Each step is self-guarding so a content-api that's down only warns.
seed_content(){
  say "seeding content (catalog db:seed + demo polls)…"
  ( cd "$PROGRAM_HUB/apps/node/content-api" && env DATABASE_URL="$CONTENT_DB_URL" pnpm db:seed >/dev/null 2>&1 ) \
    && ok "content catalog seeded (db:seed)" || printf "\033[33m⚠\033[0m content catalog seed failed\n"
  ( CONTENT_API="$CONTENT_API_URL" node "$SCRIPT_DIR/seed-demo-polls.mjs" >/dev/null 2>&1 ) \
    && ok "demo polls authored → demo-poll-arithmetic|fractions|exit-ticket" \
    || printf "\033[33m⚠\033[0m demo-poll seeding skipped (content-api up on :%s?)\n" "$CONTENT_PORT"
  # The legacy→content migration tool lives on an UNMERGED program-hub branch; run
  # it only when present so this stays green against program-hub main too.
  if [[ -f "$PROGRAM_HUB/apps/node/content-api/tools/legacy-poll-migrate/migrate.ts" ]]; then
    ( cd "$PROGRAM_HUB/apps/node/content-api" \
        && env DATABASE_URL="$CONTENT_DB_URL" pnpm exec tsx tools/legacy-poll-migrate/migrate.ts \
             --fixture bwo8my5mgprq9ran --target "$CONTENT_API_URL" >/dev/null 2>&1 ) \
      && ok "demo legacy poll migrated → legacy-poll-bwo8my5mgprq9ran" \
      || printf "\033[33m⚠\033[0m legacy-poll migration skipped (tsx present?)\n"
  fi
}

# roster = iam + sessions demo (programs empty); full = + programs + content.
seed_stack(){
  local mode=${1:-roster}
  seed_iam
  seed_sessions
  if [[ "$mode" == full ]]; then seed_programs; seed_content; fi
  return 0
}

# ── auto-login: mint a session via iam-api devLogin, then open the dash ──
# devLogin is dev-only (FORBIDDEN when AUTH_ENABLED) and origin-checked, so we
# send iam-api's own origin (always allowlisted — it's what the /demo page uses).
#
# Two halves, because a shell can't put an HttpOnly cookie in your browser:
#   1. curl → a Netscape cookie jar ($COOKIE_JAR: iam_session JWT + iam_refresh)
#      for HEADLESS harnesses (curl --cookie, Playwright storageState).
#   2. browser-login.mjs → a real Chromium (persistent profile) that does the
#      same devLogin in-browser and opens the dash already authenticated, so you
#      don't land on the Janus redirect. Falls back gracefully if Playwright /
#      saga-dash isn't available — the cookie jar half still succeeds.
login_user(){
  # Tunnel mode logs in through the PUBLIC iam URL: with AUTH_SESSIONCOOKIEDOMAIN
  # set to .<moniker>.$VMS_BASE, a browser/jar rejects that Set-Cookie on a
  # localhost response (host mismatch) — the cookie only lands via the tunnel
  # host. The tunnel origin passes iam's allowlist (*.wootdev.com wildcard).
  local email=${1:-$DEFAULT_LOGIN_USER} code iam_url="${LOGIN_IAM_URL:-$IAM_URL}"
  say "auto-login via iam-api devLogin as $email…"
  code=$(curl -s -o "$STATE/devlogin.json" -w '%{http_code}' --max-time 10 \
    -X POST "$iam_url/trpc/auth.devLogin" \
    -H 'Content-Type: application/json' -H "Origin: $iam_url" \
    -c "$COOKIE_JAR" -d "{\"email\":\"$email\"}" 2>/dev/null) || code=000
  if [[ "$code" != 200 ]]; then
    printf "\033[31m✗\033[0m devLogin failed (HTTP %s) for '%s'.\n" "$code" "$email"
    if [[ "$email" == "$DEFAULT_LOGIN_USER" ]]; then
      printf "  '%s' is the rostered Seed District admin — it only exists after a roster seed.\n" "$email"
      printf "  Seed first, e.g.  %s --seed roster --login  (or add --seed to your reset).\n" "$0"
      printf "  For a bare reset (no roster), the only user is the bootstrap one: %s --login dev@example.org\n" "$0"
    else
      printf "  Is iam-api up and is '%s' present in the seeded roster?\n" "$email"
    fi
    printf "  Response: %s\n" "$STATE/devlogin.json"
    return 1
  fi
  ok "session minted — cookie jar → $COOKIE_JAR (headless harnesses)"
  open_login_browser "$email"
}

# Launch a headful Chromium that's already logged into the dash. Backgrounded
# (nohup) so the window outlives this script; pid tracked for --down. The
# persistent profile is single-locked, so we kill any prior auto-login browser
# first. Best-effort: a missing node / Playwright / saga-dash only warns.
open_login_browser(){
  local email=$1
  [[ -f "$BROWSER_LOGIN" ]] || { printf "\033[33m⚠\033[0m %s missing — skipping browser auto-login (cookie jar is ready)\n" "$BROWSER_LOGIN"; return 0; }
  command -v node >/dev/null 2>&1 || { printf "\033[33m⚠\033[0m node not found — skipping browser auto-login (cookie jar is ready)\n"; return 0; }
  [[ -d "$SAGA_DASH/apps/web/dash/node_modules/playwright" ]] || { printf "\033[33m⚠\033[0m playwright not installed in saga-dash — skipping browser auto-login. Run: (cd %s/apps/web/dash && pnpm install && pnpm exec playwright install chromium)\n" "$SAGA_DASH"; return 0; }
  if [[ -f "$STATE/browser-login.pid" ]]; then
    kill "$(cat "$STATE/browser-login.pid")" 2>/dev/null || true; rm -f "$STATE/browser-login.pid"; sleep 1
  fi
  say "opening auto-logged-in dash in Chromium (profile $BROWSER_PROFILE)…"
  ( IAM_URL="${LOGIN_IAM_URL:-$IAM_URL}" DASH_URL="${LOGIN_DASH_URL:-$DASH_URL}" LOGIN_EMAIL="$email" \
      PROFILE_DIR="$BROWSER_PROFILE" SAGA_DASH_DASH="$SAGA_DASH/apps/web/dash" \
      nohup node "$BROWSER_LOGIN" >"$STATE/browser-login.log" 2>&1 & echo $! >"$STATE/browser-login.pid" )
  for _ in $(seq 1 40); do
    if grep -q '^AUTOLOGIN_OK' "$STATE/browser-login.log" 2>/dev/null; then
      ok "dash open + logged in as $email — use that Chromium window ($(grep -o 'http[^ ]*$' "$STATE/browser-login.log" | tail -1))"
      return 0
    fi
    if grep -q '^AUTOLOGIN_FAIL' "$STATE/browser-login.log" 2>/dev/null; then
      printf "\033[31m✗\033[0m browser auto-login failed: %s\n" "$(grep '^AUTOLOGIN_FAIL' "$STATE/browser-login.log" | head -1 | cut -d' ' -f2-)"
      printf "  (cookie jar is still valid for harnesses.) Full log: %s\n" "$STATE/browser-login.log"
      return 1
    fi
    sleep 1
  done
  printf "\033[33m⚠\033[0m Chromium still starting — watch %s\n" "$STATE/browser-login.log"
}

services_down(){ for n in iam-api sis-api programs-api scheduling-api sessions-api content-api ads-adm-api saga-dash rtsm-api connect-api connect-web; do
  [[ -f "$STATE/$n.pid" ]] && { pkill -P "$(cat "$STATE/$n.pid")" 2>/dev/null||true; kill "$(cat "$STATE/$n.pid")" 2>/dev/null||true; rm -f "$STATE/$n.pid"; }
done
[[ -f "$STATE/browser-login.pid" ]] && { kill "$(cat "$STATE/browser-login.pid")" 2>/dev/null||true; rm -f "$STATE/browser-login.pid"; }
# tunnels: a tunnel with no services behind it is just public 502s — drop it too.
[[ -f "$STATE/frpc.pid" ]] && { kill "$(cat "$STATE/frpc.pid")" 2>/dev/null||true; rm -f "$STATE/frpc.pid"; pkill -f "frpc -c $STATE/frpc.toml" 2>/dev/null||true; }
# tsup watchers: match the real cmdline (node .../tsup/dist/cli-default.js --watch);
# the literal "tsup --watch" never matches, so watchers used to survive --down.
pkill -f "tsup/dist/cli-default.js --watch" 2>/dev/null||true
# tsup's --onSuccess \`node dist/main.js\` children are orphaned by the kill above
# and keep holding their ports; reap whatever still listens on our known ports.
for _p in "$IAM_PORT" "$SIS_PORT" 3006 3007 "$CONTENT_PORT" 3008 5005 8900 "$RTSM_PORT" "$CONNECT_API_PORT" "$CONNECT_WEB_PORT"; do fuser -k "$_p/tcp" 2>/dev/null||true; done
ok "services down (mesh incl. connect-mongo + AV containers left up)"; }

# Remove stale Vite optimize caches so the dash serves CURRENT source after a
# code/branch change. The dep-optimizer cache survives restarts and silently
# serves the old program-config bundle -- the classic "fix is in the source but
# the browser runs old JS" trap. Targets the dash app + package-level caches
# only, never the root .pnpm vitest caches.
nuke_vite(){
  say "clearing dash vite caches (stale optimized bundles)..."
  rm -rf "$SAGA_DASH/apps/web/dash/node_modules/.vite" 2>/dev/null||true
  find "$SAGA_DASH/apps" "$SAGA_DASH/packages" -type d -name .vite -prune -exec rm -rf {} + 2>/dev/null||true
  # connect-web is vite too — same stale-optimize-cache trap.
  rm -rf "$QBOARD/apps/web/connectv3/node_modules/.vite" 2>/dev/null||true
  ok "vite caches cleared"
}

status(){
  for kv in iam-api:$IAM_PORT sis-api:$SIS_PORT programs-api:3006 scheduling-api:3008 sessions-api:3007 content-api:$CONTENT_PORT ads-adm-api:5005 saga-dash:8900 rtsm-api:$RTSM_PORT connect-api:$CONNECT_API_PORT connect-web:$CONNECT_WEB_PORT; do
    n=${kv%:*}; p=${kv#*:}; probe=$(probe_path "$n")
    printf "  %-15s :%s → %s\n" "$n" "$p" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:$p$probe 2>/dev/null)"
  done
  # Recording stack is opt-in — only report when its containers exist.
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx fleek-recorder; then
    printf "  %-15s :%s → %s\n" "recorder" "$RECORDER_CONTROL_PORT" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:$RECORDER_CONTROL_PORT/v1/health 2>/dev/null)"
    printf "  %-15s :%s → %s\n" "recordings-api" "$RECORDINGS_API_PORT" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:$RECORDINGS_API_PORT/healthz 2>/dev/null)"
  else
    printf "  %-15s off (opt-in: ./up.sh --record [crdt|av])\n" "recording"
  fi
  docker exec soa-postgres-1 psql -U iam -d iam_local -tAc \
    "SELECT 'iam users='||count(*) FROM users" 2>/dev/null | sed 's/^/  /'
  if [[ -f "$STATE/frpc.pid" ]] && kill -0 "$(cat "$STATE/frpc.pid")" 2>/dev/null; then
    printf "  %-15s up — ./tunnel.sh status for public URLs\n" "tunnel"
  fi
}

# ── arg parsing: verbs (up/down/status/help) + composable flags ──────
DO_UP=0; DO_RESET=0; DO_RESTART=0; DO_PULL=0; DO_SEED=0; SEED_MODE=roster; DO_LOGIN=0; LOGIN_USER=$DEFAULT_LOGIN_USER; DO_RECORD=0; RECORD_MODE=crdt
case "${1:-up}" in
  # `shift || true`: bare `./up.sh` defaults ${1:-up} to "up" but leaves $# at 0,
  # so an unguarded shift returns 1 and `set -e` kills the script before it runs.
  up|--up)                       DO_UP=1; shift || true ;;
  --down)                        services_down; exit 0 ;;
  # Clean restart WITHOUT a data wipe: bounce services + clear vite caches, then
  # start fresh on current code. The recovery for a stale dash bundle after a
  # refresh-suite branch rewrite (corrupted vite module graph / unresponsive UI)
  # — same restart+nuke_vite as --reset, minus reset_data. Composes with trailing
  # flags: `restart --login [email]` re-opens the logged-in browser the bounce kills.
  restart|--restart)             DO_RESTART=1; shift || true ;;
  --status)                      status; exit 0 ;;
  # Self-maintaining: print the header's "Usage:" block through its closing
  # ruler, instead of a hardcoded line range that drifts as the header grows.
  -h|--help)                     sed -n '/^# Usage:/,/^# ─────/p' "$0"; exit 0 ;;
  --reset|--seed|--login|--user|--pull|--record|--only|--sandbox|--tunnel) ;; # flag-only invocation; skip up
  *) echo "unknown: $1 (use --help)"; exit 1 ;;
esac
while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset) DO_RESET=1; shift ;;
    --seed)  DO_SEED=1; shift; case "${1:-}" in roster|full) SEED_MODE=$1; shift ;; esac ;;
    # --record [crdt|av]: opt-in fleek recording stack. crdt (default) =
    # recorder + recordings-api + minio; av adds the LiveKit egress sidecar.
    --record) DO_RECORD=1; shift; case "${1:-}" in crdt|av) RECORD_MODE=$1; shift ;; esac ;;
    # --login / --user [email]: optional positional email; bare or next-flag → default persona
    --login|--user) DO_LOGIN=1; shift; case "${1:-}" in ''|--*) ;; *) LOGIN_USER=$1; shift ;; esac ;;
    --pull) DO_PULL=1; shift ;;
    # --only <svc>: launch just one service (the one you're editing); the rest
    # are expected to live in a cloud sandbox. --sandbox <name>: the compose name
    # those deps live under — flips the launched service's dep URLs + preview
    # header to the dev fleet (see sandbox_env). Either implies the hybrid path.
    --only)    ONLY_SERVICE="${2:-}"; [[ -z "$ONLY_SERVICE" || "$ONLY_SERVICE" == -* ]] && { echo "--only needs a service name"; exit 1; }; shift 2 ;;
    --sandbox) SANDBOX_NAME="${2:-}"; [[ -z "$SANDBOX_NAME" || "$SANDBOX_NAME" == -* ]] && { echo "--sandbox needs a name"; exit 1; }; shift 2 ;;
    # --tunnel: NO argument — the moniker comes from .vms-moniker (tunnel.sh
    # bootstraps it interactively on first use), keeping monikers out of shared
    # command lines (no placeholders, no cross-contamination).
    --tunnel)  TUNNEL=1; shift ;;
    *) echo "unknown flag: $1 (use --help)"; exit 1 ;;
  esac
done

# Hybrid-mode sanity: --only takes a real service; --sandbox is only meaningful
# with --only (running the full local stack against a cloud iam is not the point).
if [[ -n "$ONLY_SERVICE" ]]; then
  case "$ONLY_SERVICE" in
    iam-api|sis-api|programs-api|scheduling-api|sessions-api|content-api|ads-adm-api|saga-dash|rtsm-api|connect-api|connect-web) ;;
    *) echo "--only: unknown service '$ONLY_SERVICE' (iam-api|sis-api|programs-api|scheduling-api|sessions-api|content-api|ads-adm-api|saga-dash|rtsm-api|connect-api|connect-web)"; exit 1 ;;
  esac
  # --only is a launch directive: a bare `./up.sh --only <svc>` (no `up` verb)
  # should still bring that one service up, so imply DO_UP unless the user
  # already asked for a reset/restart (which run services_up themselves).
  [[ $DO_RESET == 1 || $DO_RESTART == 1 ]] || DO_UP=1
fi
if [[ -n "$SANDBOX_NAME" && -z "$ONLY_SERVICE" ]]; then
  echo "--sandbox <name> requires --only <svc> (point ONE local service at the sandbox; the rest are the sandbox)"; exit 1
fi
# Validate the sandbox name — it flows into the host URL and the preview header,
# so constrain it to the same shape the composition API enforces.
if [[ -n "$SANDBOX_NAME" && ! "$SANDBOX_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9-]{0,39}$ ]]; then
  echo "--sandbox: '$SANDBOX_NAME' must match [a-zA-Z0-9][a-zA-Z0-9-]{0,39}"; exit 1
fi
# Tunnel-mode resolution. The moniker prompt (first run) talks on stderr, so
# the $() capture stays clean. tunnel_env() needs TUNNEL_DOMAIN before any
# launch line runs; LOGIN_*_URLs flip the login flow to the public hosts (the
# domain cookie can't be minted via localhost). --tunnel is a LAUNCH-ENV
# directive: services must (re)start to pick the env up, so a bare
# `./up.sh --tunnel` implies up — but already-running services keep their
# localhost env (warned below); `--reset --tunnel` / `restart --tunnel` flips
# everything cleanly.
if [[ $TUNNEL == 1 ]]; then
  TUNNEL_MONIKER="$("$SCRIPT_DIR/tunnel.sh" moniker)" || { err "could not resolve a moniker (see tunnel.sh)"; exit 1; }
  TUNNEL_DOMAIN="$TUNNEL_MONIKER.$VMS_BASE"
  LOGIN_IAM_URL="https://iam.$TUNNEL_DOMAIN"
  LOGIN_DASH_URL="https://dash.$TUNNEL_DOMAIN"
  # rtsm fleet config, tunnel flavor. The node's `endpoint` is the
  # BROWSER-visible host (bare, no scheme — rtsm-client composes
  # `${scheme}://${endpoint}`, deriving the scheme from its bootstrap URL).
  # With the https tunnel bootstrap, a localhost:6110 endpoint makes every
  # client probe https://localhost:6110 → "no reachable fleet nodes" — so in
  # tunnel mode the fleet must advertise the tunnel host instead.
  # tunnel_env(rtsm-api) points FLEET_CONFIG_PATH at this generated file.
  node -e '
    const fs = require("fs");
    const [src, dst, host] = process.argv.slice(1);
    const c = JSON.parse(fs.readFileSync(src, "utf8"));
    c._comment = "GENERATED by up.sh --tunnel from rtsm-fleet-local.json — endpoint swapped to the tunnel host (browser-visible; scheme comes from the bootstrap URL).";
    c.nodes.local.endpoint = host;
    fs.writeFileSync(dst, JSON.stringify(c, null, 4) + "\n");
  ' "$SCRIPT_DIR/rtsm-fleet-local.json" "$STATE/rtsm-fleet-tunnel.json" "rtsm.$TUNNEL_DOMAIN" \
    || { err "could not render $STATE/rtsm-fleet-tunnel.json"; exit 1; }
  # AV via the REAL fleek dev cluster. Local LiveKit (ws://localhost:7880) is
  # unreachable from a guest's browser (WebRTC media is UDP — it can't ride
  # the HTTP tunnels), so tunnel mode points connect-api at the fleek dev
  # nodes instead: the deployed topology (qboard infra/connectv3-api/
  # samconfig.yaml — keep in sync) + the cluster's real LiveKit creds from
  # Secrets Manager (same JSON secret the ECS task injects). Best-effort: no
  # creds → warn and stay on local AV (guests get CRDT-only, same as before).
  TUNNEL_LK_KEY=""; TUNNEL_LK_SECRET=""
  TUNNEL_FLEEK_TOPOLOGY='{"domain":"fleek.wootdev.com","cityMap":{"phx":"wss://phx-1.fleek.wootdev.com","chi":"wss://chi-1.fleek.wootdev.com","nyc":"wss://nyc-1.fleek.wootdev.com","_default":"wss://chi-1.fleek.wootdev.com"}}'
  TUNNEL_AWS_PROFILE="$("$SCRIPT_DIR/tunnel.sh" aws-profile 2>/dev/null)" || TUNNEL_AWS_PROFILE=""
  _lk_json=$(aws secretsmanager get-secret-value --secret-id qboard/fleek/livekit-creds \
      --region us-west-2 ${TUNNEL_AWS_PROFILE:+--profile "$TUNNEL_AWS_PROFILE"} \
      --query SecretString --output text 2>/dev/null) || _lk_json=""
  if [[ -n "$_lk_json" ]]; then
    TUNNEL_LK_KEY=$(node -e 'console.log(JSON.parse(process.argv[1]).api_key||"")' "$_lk_json" 2>/dev/null) || TUNNEL_LK_KEY=""
    TUNNEL_LK_SECRET=$(node -e 'console.log(JSON.parse(process.argv[1]).api_secret||"")' "$_lk_json" 2>/dev/null) || TUNNEL_LK_SECRET=""
  fi
  unset _lk_json
  if [[ -n "$TUNNEL_LK_KEY" && -n "$TUNNEL_LK_SECRET" ]]; then
    ok "tunnel AV: fleek dev cluster (wss://*.fleek.wootdev.com; creds from qboard/fleek/livekit-creds)"
    [[ $DO_RECORD == 1 && "$RECORD_MODE" == av ]] \
      && warn "--record av + --tunnel: AV rides the fleek CLUSTER, so the LOCAL egress can't capture media; CRDT recording still works."
  else
    warn "could not fetch qboard/fleek/livekit-creds — AV stays LOCAL (guests get CRDT-only; aws sso login and re-run for cluster AV)"
  fi
  say "tunnel mode: browser plane at https://<svc>.$TUNNEL_DOMAIN (Connect: https://connect.$TUNNEL_DOMAIN)"
  warn "remote users: Connect + dash are wired (dash needs PR #194 pinned — see"
  warn "integration-suite.local.tsv); AV is CRDT-only over tunnels (LiveKit/UDP —"
  warn "see vms/README.md known limitations)."
  if [[ $DO_RESET == 0 && $DO_RESTART == 0 ]]; then
    DO_UP=1
    warn "services already running keep their LOCALHOST env — use './up.sh restart --tunnel'"
    warn "(or --reset --tunnel) to relaunch everything tunnel-aware."
  fi
fi

if [[ -n "$SANDBOX_NAME" ]]; then
  say "hybrid: $ONLY_SERVICE local → iam dep at https://iam.$SANDBOX_BASE (sandbox '$SANDBOX_NAME')"
  warn "ROUTING IS NOT AUTOMATIC: $ONLY_SERVICE only reaches sandbox iam if its INBOUND"
  warn "request carries  x-saga-preview-iam-api: sandbox-$SANDBOX_NAME  (it forward-propagates"
  warn "from there). Drive via the dash (which originates it) or set that header on each"
  warn "curl/test request. WITHOUT it, iam calls hit MAIN — and main has SVCCRED auth ON, so"
  warn "an unauthenticated S2S call is rejected. See the design doc (INTEGRATION.md)."
fi

# `up` does first-run prep (branch posture, fixups, mesh, schema). A bare
# `--reset`/`restart` (no `up` verb) skips the posture/fixup preamble but still
# ENSURES its launch assumptions: mesh (incl. connect-mongo), AV, and prep —
# they're idempotent and cheap when already satisfied. Any invocation that
# launches services has provisioned them (the e2e runner's `--reset --seed`
# previously launched ten services against an unprepped tree / missing mongo).
# SKIP_PREP=1 skips the install+build pass for tight iteration loops.
[[ $DO_PULL == 1 ]] && pull_repos        # ff-only sync siblings BEFORE we build/migrate
if [[ $DO_UP == 1 ]]; then
  check_branches; check_layout; apply_fixes; mesh_up; connect_av_up; prep
elif [[ $DO_RESET == 1 || $DO_RESTART == 1 ]]; then
  check_layout; mesh_up; connect_av_up
  if [[ "${SKIP_PREP:-0}" == "1" ]]; then say "SKIP_PREP=1 — skipping install+build prep"; else prep; fi
fi

# A --reset ALWAYS means a CLEAN restart on current code — independent of the
# `up` verb, so a bare `./up.sh --reset` clears caches too (it used to only
# truncate data, leaving stale services up). Stop running services (incl. stale
# tsup / vite watchers that accumulate across runs), clear vite caches, then
# bring services back up FRESH. This is what escapes the stale-cached-bundle
# trap: a dead Vite watcher serving old JS even though the source changed (e.g.
# after a refresh-suite branch swap). Plain `up` (no --reset) reuses "already
# up" processes / cached bundles.
if [[ $DO_RESET == 1 || $DO_RESTART == 1 ]]; then
  say "clean restart — stopping services + clearing vite caches..."
  services_down; nuke_vite
  # reset_data MUST precede services_up: it truncates `projection_readiness`
  # (sessions DB) among everything else, and sessions-api only re-warms at
  # STARTUP (warm-on-caught-up). Truncating after the service started left it
  # gated — every read 408 "projection … is warming" until the next restart.
  [[ $DO_RESET == 1 ]] && reset_data
  services_up
  ok "stack up (clean) — try: $0 --status"
elif [[ $DO_UP == 1 ]]; then
  services_up
  ok "stack up — try: $0 --status"
fi
# Tunnels come up AFTER services (so the end-to-end probe has something to
# hit) and BEFORE --login (which routes through the public iam in tunnel mode).
if [[ $TUNNEL == 1 ]]; then
  "$SCRIPT_DIR/tunnel.sh" up
fi
[[ $DO_RECORD == 1 ]] && record_up "$RECORD_MODE"
[[ $DO_SEED == 1 ]]  && seed_stack "$SEED_MODE"
[[ $DO_LOGIN == 1 ]] && login_user "$LOGIN_USER"
exit 0

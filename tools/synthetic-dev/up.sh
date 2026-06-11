#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# synthetic-dev/up.sh — stand up the local synthetic-dev stack for sds_92.
#
# Goal: dockerized postgres + redis + rabbitmq + the six APIs, EMPTY, ready to
# seed SYNTHETIC iam rosters / programs via the deterministic `db:seed`
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
#   ./up.sh                      bring up mesh + 6 services (empty)
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
#   ./up.sh --login [email]      auto-login via iam-api devLogin (default: dev@saga.org)
#   ./up.sh --user  [email]      alias for --login
#   ./up.sh --down               stop services (leaves mesh up)
#   ./up.sh --status             health + row counts
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

IAM_PORT=3010                                               # iam-api port — matches saga-dash main's static/config.json default (post Janus auth rewrite, d1.4)
IAM_URL="http://localhost:$IAM_PORT"
SIS_PORT=3100                                               # sis-api port (SisConfigSchema default; rostering apps/node/sis-api)
SIS_DB_URL="postgresql://sis:sis@localhost:5432/sis_db"     # sis-api owns a dedicated DB (read direct from SIS_DATABASE_URL; see d1.7)
# program-hub config defaults to its OWN standalone-dev postgres on :5433; in this
# stack programs/scheduling live in the mesh on :5432, so override DATABASE_URL
# everywhere we run program-hub (migrate + runtime), matching seed_programs.
PROGRAMS_DB_URL="postgresql://saga_user:password123@localhost:5432/programs"
SCHEDULING_DB_URL="postgresql://saga_user:password123@localhost:5432/scheduling"
MESH_MQ="amqp://rabbitmq_admin:password123@localhost:5672"  # mesh broker creds (NOT saga_user)
DEV_USER_UUID="f0000004-0000-4000-8000-00000000beef"        # from iam-db seed-dev-user.ts
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
            "$SAGA_DASH:saga-dash" "$SDS:student-data-system"; do
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
  for kv in "$ROSTERING:rostering" "$PROGRAM_HUB:program-hub" "$SAGA_DASH:saga-dash"; do
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
  for kv in "$SOA:soa" "$SDS:student-data-system"; do
    r=${kv%:*}; repo=${kv#*:}; have=$(git -C "$r" branch --show-current)
    [[ "$have" == main ]] || printf "\033[33m⚠\033[0m %s on '%s' (expected 'main')\n" "$repo" "$have"
  done
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
  # "already up" only if ALL three mesh containers are running. A partial mesh
  # (e.g. redis failed to bind its port last run) must reconcile via make up,
  # not masquerade as up — otherwise we skip straight past a missing service.
  local running; running=$(docker ps --format '{{.Names}}' | grep -cE '^soa-(postgres|redis|rabbitmq)-1$' || true)
  if [[ "$running" -eq 3 ]]; then ok "mesh already up"; return; fi
  [[ "$running" -gt 0 ]] && say "partial mesh ($running/3 up) — reconciling…"
  check_ports
  say "starting mesh (postgres + redis + rabbitmq)…"
  if ! ( cd "$SOA/infra" && EXTRA_POSTGRES_SEED_DIR=../../projects/saga-mesh/seed \
      make up PROJECT=saga-mesh PROFILE=empty \
      POSTGRES_PORT=5432 REDIS_PORT=6379 RABBITMQ_PORT=5672 RABBITMQ_MGMT_PORT=15672 >"$STATE/mesh.log" 2>&1 ); then
    printf "\033[31m✗\033[0m mesh failed to start — 'make up' output (%s):\n" "$STATE/mesh.log"
    sed 's/^/    /' "$STATE/mesh.log" 2>/dev/null
    exit 1
  fi
  for _ in $(seq 1 20); do docker exec soa-postgres-1 pg_isready -U postgres_admin >/dev/null 2>&1 && break; sleep 1; done
  ok "mesh up — pg :5432  redis :6379  rabbitmq :5672"
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
    if [[ -t 0 ]]; then
      printf "  Refresh the token now (pnpm co:login) and retry? [Y/n] "; read -r ans || ans=
      if [[ "${ans:-y}" != [nN]* ]]; then
        say "pnpm co:login…"
        if ( cd "$dir" && pnpm co:login ) >>"$log" 2>&1 && ( cd "$dir" && pnpm install ) >>"$log" 2>&1; then
          ok "token refreshed + $name installed"; return 0
        fi
      fi
    fi
    printf "\033[31m✗\033[0m %s: install still failing on auth — run 'pnpm co:login' in %s, then re-run.\n" "$name" "$dir"
    exit 1
  fi
  printf "\033[31m✗\033[0m %s: pnpm install failed:\n" "$name"; tail -15 "$log" | sed 's/^/    /'; exit 1
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
  else
    db_step "$db migrate reset"  "$dir" "${pre[@]+"${pre[@]}"}" pnpm prisma migrate reset --force  # unmanaged (db:push'd / empty) → drop + replay all
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
            "$SAGA_DASH:saga-dash" "$SDS:student-data-system"; do
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
  ( cd "$ROSTERING" && pnpm build >/dev/null 2>&1 ) || true        # build hiccups are non-fatal
  say "reconciling program-hub deps + workspace build (new deps / stale workspace dist after a main pull)..."
  pnpm_install "$PROGRAM_HUB"
  ( cd "$PROGRAM_HUB" && pnpm build >/dev/null 2>&1 ) || true
  # ads-adm-api imports the @saga-ed/ads-adm-db workspace package from dist/ —
  # on a fresh clone that dist/ doesn't exist until the sds workspace is built,
  # so install + build sds too (mirrors rostering/program-hub above). ads-adm-db's
  # build (tsup) assumes its Prisma client is already generated at src/prisma/
  # generated/ — turbo build won't do it, so `db:generate` must run FIRST or both
  # the build and the runtime import of dist/prisma/generated fail.
  say "reconciling student-data-system deps + workspace build (ads-adm-db dist for ads-adm-api)..."
  pnpm_install "$SDS"
  ( cd "$SDS/packages/node/ads-adm-db" && pnpm db:generate >/dev/null 2>&1 ) || true
  ( cd "$SDS" && pnpm build >/dev/null 2>&1 ) || true
  say "applying prisma schemas (migrate deploy — canonical, see d1.5)…"
  db_step "iam-db migrate deploy"     "$ROSTERING/packages/node/iam-db"     pnpm prisma migrate deploy
  db_step "iam-pii-db db push"        "$ROSTERING/packages/node/iam-pii-db" pnpm prisma db push
  migrate_db "$PROGRAM_HUB/apps/node/programs-api"   programs   "$PROGRAMS_DB_URL"
  migrate_db "$PROGRAM_HUB/apps/node/scheduling-api" scheduling "$SCHEDULING_DB_URL"
  migrate_db "$ROSTERING/packages/node/sis-db"       sis_db   # sis-api schema (d1.7); uses sis-db's own config
  db_step "ads-adm-db migrate deploy" "$SDS/packages/node/ads-adm-db"       pnpm prisma migrate deploy
  say "seeding dev user ($DEV_USER_UUID)…"
  ( cd "$ROSTERING/packages/node/iam-db" && env $(grep -v '^#' "$ROSTERING/.env.local" | xargs) node dist/seed-dev-user.js >/dev/null 2>&1 ) || true
  ok "schemas + dev user ready"
}

launch(){ # name port dir extra_env...
  local name=$1 port=$2 dir=$3; shift 3
  [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:$port/health 2>/dev/null)" == 200 ]] && { ok "$name already up :$port"; return; }
  say "starting $name on :$port…"
  ( cd "$dir"; env "$@" nohup pnpm dev >"$STATE/$name.log" 2>&1 & echo $! >"$STATE/$name.pid" )
  for _ in $(seq 1 40); do
    local probe=/health; [[ "$name" == saga-dash ]] && probe=/
    [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:$port$probe 2>/dev/null)" == 200 ]] && { ok "$name up :$port"; return; }
    sleep 1
  done
  printf "\033[31m✗\033[0m %s failed on :%s — tail %s\n" "$name" "$port" "$STATE/$name.log"; return 1
}

services_up(){
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
  launch iam-api "$IAM_PORT" "$ROSTERING/apps/node/iam-api" PORT="$IAM_PORT" AUTH_DEVUSERID="$DEV_USER_UUID"
  # sis-api → iam-api service.* over S2S; no creds locally (iam-api dev-bypass
  # synthesizes a service actor when auth is off). IAM_BASEURL/IAM_TOKENURL must
  # point at iam on :3010 (sis-api defaults to :3000). See d1.7.
  launch sis-api "$SIS_PORT" "$ROSTERING/apps/node/sis-api" \
     NODE_ENV=development PORT="$SIS_PORT" \
     SIS_DATABASE_URL="$SIS_DB_URL" \
     IAM_BASEURL="$IAM_URL/trpc" IAM_TOKENURL="$IAM_URL/v1/oauth/token"
  launch programs-api 3006 "$PROGRAM_HUB/apps/node/programs-api"     NODE_ENV=development DATABASE_URL="$PROGRAMS_DB_URL"   IAM_API_URL="$IAM_URL" RABBITMQ_URL="$MESH_MQ" JANUS_REQUIRED=false
  launch scheduling-api 3008 "$PROGRAM_HUB/apps/node/scheduling-api" NODE_ENV=development DATABASE_URL="$SCHEDULING_DB_URL" IAM_API_URL="$IAM_URL" RABBITMQ_URL="$MESH_MQ" JANUS_REQUIRED=false
  launch ads-adm-api 5005 "$SDS/apps/node/ads-adm-api" \
     ADS_ADM_SCHEDULE_PROVIDER=mock \
     ADS_ADM_DATABASE_URL=postgresql://ads_adm:ads_adm@localhost:5432/ads_adm_local \
     DATABASE_URL=postgresql://ads_adm:ads_adm@localhost:5432/ads_adm_local \
     CORS_ORIGIN=http://localhost:8900 RABBITMQ_URL="$MESH_MQ"
  launch saga-dash 8900 "$SAGA_DASH/apps/web/dash"
}

# ── reset: truncate synthetic data to an empty baseline ──────────────
# Not a "post-delete of seeded data" — a clean baseline BEFORE seeding, so any
# --seed mode is reproducible regardless of prior state. Needed because iam
# groups don't dedup (re-running the roster on a non-empty iam duplicates it).
# Preserves _prisma_migrations so no re-migrate. Uses the mesh superuser
# (postgres_admin) so it can truncate tables owned by iam / saga_user / etc.
reset_data(){
  say "resetting synthetic data → empty baseline (iam, programs, scheduling, sis)…"
  local trunc="DO \$\$ DECLARE r RECORD; BEGIN FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' LOOP EXECUTE 'TRUNCATE TABLE public.'||quote_ident(r.tablename)||' RESTART IDENTITY CASCADE'; END LOOP; END \$\$;"
  for db in iam_local iam_pii_local programs scheduling sis_db; do
    if docker exec -i soa-postgres-1 psql -U postgres_admin -d "$db" -v ON_ERROR_STOP=1 -c "$trunc" >/dev/null 2>&1; then
      ok "truncated $db"
    else
      printf "\033[33m⚠\033[0m could not truncate %s (does it exist? is mesh up?)\n" "$db"
    fi
  done
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

# roster = iam only (programs empty); full = roster + programs.
seed_stack(){
  local mode=${1:-roster}
  seed_iam
  [[ "$mode" == full ]] && seed_programs
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
  local email=${1:-$DEFAULT_LOGIN_USER} code
  say "auto-login via iam-api devLogin as $email…"
  code=$(curl -s -o "$STATE/devlogin.json" -w '%{http_code}' --max-time 10 \
    -X POST "$IAM_URL/trpc/auth.devLogin" \
    -H 'Content-Type: application/json' -H "Origin: $IAM_URL" \
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
  ( IAM_URL="$IAM_URL" DASH_URL="$DASH_URL" LOGIN_EMAIL="$email" \
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

services_down(){ for n in iam-api sis-api programs-api scheduling-api ads-adm-api saga-dash; do
  [[ -f "$STATE/$n.pid" ]] && { pkill -P "$(cat "$STATE/$n.pid")" 2>/dev/null||true; kill "$(cat "$STATE/$n.pid")" 2>/dev/null||true; rm -f "$STATE/$n.pid"; }
done
[[ -f "$STATE/browser-login.pid" ]] && { kill "$(cat "$STATE/browser-login.pid")" 2>/dev/null||true; rm -f "$STATE/browser-login.pid"; }
# tsup watchers: match the real cmdline (node .../tsup/dist/cli-default.js --watch);
# the literal "tsup --watch" never matches, so watchers used to survive --down.
pkill -f "tsup/dist/cli-default.js --watch" 2>/dev/null||true
# tsup's --onSuccess \`node dist/main.js\` children are orphaned by the kill above
# and keep holding their ports; reap whatever still listens on our known ports.
for _p in "$IAM_PORT" "$SIS_PORT" 3006 3008 5005 8900; do fuser -k "$_p/tcp" 2>/dev/null||true; done
ok "services down (mesh left up)"; }

# Remove stale Vite optimize caches so the dash serves CURRENT source after a
# code/branch change. The dep-optimizer cache survives restarts and silently
# serves the old program-config bundle -- the classic "fix is in the source but
# the browser runs old JS" trap. Targets the dash app + package-level caches
# only, never the root .pnpm vitest caches.
nuke_vite(){
  say "clearing dash vite caches (stale optimized bundles)..."
  rm -rf "$SAGA_DASH/apps/web/dash/node_modules/.vite" 2>/dev/null||true
  find "$SAGA_DASH/apps" "$SAGA_DASH/packages" -type d -name .vite -prune -exec rm -rf {} + 2>/dev/null||true
  ok "vite caches cleared"
}

status(){
  for kv in iam-api:$IAM_PORT sis-api:$SIS_PORT programs-api:3006 scheduling-api:3008 ads-adm-api:5005 saga-dash:8900; do
    n=${kv%:*}; p=${kv#*:}; probe=/health; [[ "$n" == saga-dash ]] && probe=/
    printf "  %-15s :%s → %s\n" "$n" "$p" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:$p$probe 2>/dev/null)"
  done
  docker exec soa-postgres-1 psql -U iam -d iam_local -tAc \
    "SELECT 'iam users='||count(*) FROM users" 2>/dev/null | sed 's/^/  /'
}

# ── arg parsing: verbs (up/down/status/help) + composable flags ──────
DO_UP=0; DO_RESET=0; DO_RESTART=0; DO_PULL=0; DO_SEED=0; SEED_MODE=roster; DO_LOGIN=0; LOGIN_USER=$DEFAULT_LOGIN_USER
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
  -h|--help)                     sed -n '2,51p' "$0"; exit 0 ;;
  --reset|--seed|--login|--user|--pull) ;; # flag-only invocation; skip up
  *) echo "unknown: $1 (use --help)"; exit 1 ;;
esac
while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset) DO_RESET=1; shift ;;
    --seed)  DO_SEED=1; shift; case "${1:-}" in roster|full) SEED_MODE=$1; shift ;; esac ;;
    # --login / --user [email]: optional positional email; bare or next-flag → default persona
    --login|--user) DO_LOGIN=1; shift; case "${1:-}" in ''|--*) ;; *) LOGIN_USER=$1; shift ;; esac ;;
    --pull) DO_PULL=1; shift ;;
    *) echo "unknown flag: $1 (use --help)"; exit 1 ;;
  esac
done

# `up` does first-run prep (branch posture, fixups, mesh, schema). A bare
# `--reset` (no `up` verb) skips prep and assumes a running mesh.
[[ $DO_PULL == 1 ]] && pull_repos        # ff-only sync siblings BEFORE we build/migrate
if [[ $DO_UP == 1 ]]; then
  check_branches; apply_fixes; mesh_up; prep
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
  services_down; nuke_vite; services_up
  ok "stack up (clean) — try: $0 --status"
elif [[ $DO_UP == 1 ]]; then
  services_up
  ok "stack up — try: $0 --status"
fi
[[ $DO_RESET == 1 ]] && reset_data
[[ $DO_SEED == 1 ]]  && seed_stack "$SEED_MODE"
[[ $DO_LOGIN == 1 ]] && login_user "$LOGIN_USER"
exit 0

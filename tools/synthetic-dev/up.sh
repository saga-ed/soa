#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# synthetic-dev/up.sh — stand up the local synthetic-dev stack for sds_92.
#
# Goal: dockerized postgres + redis + rabbitmq + the six APIs, EMPTY, ready to
# seed with SYNTHETIC iam rosters / programs / schedules via the scenario
# scripts (no VPN, no prod-mirror fixture).
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
#   ./up.sh --seed [roster|full] seed synthetic data (default: roster)
#                                  roster = iam roster only (programs empty → from-scratch)
#                                  full   = iam roster + programs/periods/enrollment
#   ./up.sh --reset              truncate synthetic data → empty baseline (keeps migrations)
#   ./up.sh --login [email]      auto-login via iam-api devLogin (default: dev@saga.org)
#   ./up.sh --user  [email]      alias for --login
#   ./up.sh --down               stop services (leaves mesh up)
#   ./up.sh --status             health + row counts
#
# Flags compose, applied in order up → reset → seed → login. Reproducible
# recipes (no post-deletes — selectivity is in what you seed):
#   ./up.sh --reset --seed roster --login  from-scratch roster + dev@saga.org session
#   ./up.sh --reset --seed full --login    roster + 9 programs + a fresh dev@saga.org session
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
# program-hub's programs/scheduling config defaults to its OWN standalone postgres
# (:5433); the mesh hosts these DBs on :5432 as saga_user. We INJECT these at
# migrate + launch time (program-hub treats process-env as authoritative over
# config/.env.development — see drift #7) rather than edit its tracked config.
PROGRAMS_DB_URL="postgresql://saga_user:password123@localhost:5432/programs"
SCHEDULING_DB_URL="postgresql://saga_user:password123@localhost:5432/scheduling"
# iam-api/.env sets JWT_ISSUER=https://iam.wootdev.com, so the iam_session JWTs it
# mints carry iss=…wootdev.com. programs-api/scheduling-api verify that JWT via
# @saga-ed/rostering-client's createIamAuth, which DEFAULTS the expected issuer to
# https://iam.saga.org (iam-auth.ts) — so without this override their verify throws
# "unexpected iss claim value", userId stays unset, and the --seed full programs
# scenario 401s on programs.create. Inject the real local issuer at launch.
IAM_JWT_ISSUER="https://iam.wootdev.com"
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

# Set KEY=VALUE in an env file: rewrite in place if the key is present (even with
# a different value), else append. Used to RECONCILE connection URLs to the mesh —
# a pre-existing .env.local from a standalone rostering stack may point DB/redis/
# broker at other ports (e.g. postgres :5434), which silently breaks prep's prisma
# migrate + iam-api. (Random secrets like AUTH_* stay append-if-absent below so we
# don't churn them every run.)
ensure_kv(){ # file key value
  local f=$1 k=$2 v=$3
  if grep -q "^$k=" "$f"; then sed -i "s|^$k=.*|$k=$v|" "$f"; else printf '%s=%s\n' "$k" "$v" >>"$f"; fi
}

# ── branch posture sanity (warn only, manifest-aware) ────────────────
# A repo with pins in integration-suite.tsv is EXPECTED on local/integration
# (that's where refresh-suite parks it); without pins it's expected on main.
# So we only warn on ACTUAL drift — not on the correct pinned-suite state.
# (verify.sh turns this into a hard, exit-code check + confirms the pinned PRs
# are merged; here it stays a warning so `up` proceeds.)
check_branches(){
  local MANIFEST="$SCRIPT_DIR/integration-suite.tsv" repo have want
  declare -A PINS=()
  if [[ -f "$MANIFEST" ]]; then
    while IFS=$'\t' read -r repo _prs; do
      repo="${repo//[[:space:]]/}"; [[ -z "$repo" ]] && continue
      PINS["$repo"]="${_prs//[[:space:]]/}"
    done < <(grep -vE '^\s*(#|$)' "$MANIFEST")
  fi
  for kv in "$ROSTERING:rostering" "$PROGRAM_HUB:program-hub" "$SAGA_DASH:saga-dash"; do
    r=${kv%:*}; repo=${kv#*:}
    want=main; [[ -n "${PINS[$repo]:-}" ]] && want=local/integration
    have=$(git -C "$r" branch --show-current)
    [[ "$have" == "$want" ]] || printf "\033[33m⚠\033[0m %s on '%s' (expected '%s')\n" "$repo" "$have" "$want"
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
  # Generated/random values: append only if absent (don't churn them every run).
  grep -q '^NODE_ENV='                       "$L" || echo "NODE_ENV=development" >>"$L"
  grep -q '^AUTH_EMAIL_LOOKUP_SECRET='       "$L" || echo "AUTH_EMAIL_LOOKUP_SECRET=$(openssl rand -hex 32)" >>"$L"
  grep -q '^AUTH_EMAIL_VERIFICATION_SECRET=' "$L" || echo "AUTH_EMAIL_VERIFICATION_SECRET=$(openssl rand -hex 32)" >>"$L"
  # Connection URLs: RECONCILE to the mesh (rewrite if present-but-wrong) — a
  # standalone-stack .env.local pointing these elsewhere (postgres :5434, broker
  # :5673…) silently breaks prep's prisma migrate + iam-api. sis-db reads
  # SIS_DATABASE_URL directly (sis-db/prisma.config.ts loads this root .env.local),
  # so it must be correct here for `migrate deploy` AND the running service (d1.7).
  ensure_kv "$L" DATABASE_URL     "postgresql://iam:iam@localhost:5432/iam_local"
  ensure_kv "$L" PII_DATABASE_URL "postgresql://iam_pii:iam_pii@localhost:5432/iam_pii_local"
  ensure_kv "$L" REDIS_URL        "redis://localhost:6379"
  ensure_kv "$L" RABBITMQ_URL     "$MESH_MQ"
  ensure_kv "$L" SIS_DATABASE_URL "$SIS_DB_URL"

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
  #    Idempotent: only adds the `sis-api` localDefaults key if absent.
  #
  #    config.json is a TRACKED file and the dash has no local-override file (it
  #    reads /config.json directly), so the sis-api default has to live here. A
  #    naked edit would leave saga-dash's working tree dirty — which makes
  #    refresh-integration.sh (hence refresh-suite / bootstrap step 1) ABORT with
  #    "modified/staged changes — skipping". So after editing we mark the file
  #    `skip-worktree`: git then treats our local override as unchanged (hidden
  #    from `git status`) AND keeps it across `checkout -B`/merge, so the
  #    integration-branch rebuild stays clean. To hand the key back to the repo,
  #    undo with:
  #      git -C "$SAGA_DASH" update-index --no-skip-worktree apps/web/dash/static/config.json
  #    The key name is a best-guess until dash sis-api code lands; rename if it differs.
  local DASH_CFG="$SAGA_DASH/apps/web/dash/static/config.json"
  local DASH_CFG_REL="apps/web/dash/static/config.json"
  if [[ -f "$DASH_CFG" ]]; then
    if ! grep -q '"sis-api"' "$DASH_CFG"; then
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
    # Hide our local override from git so refresh-integration sees a clean tree
    # and checkout -B won't clobber it. Only if tracked and not already flagged.
    if git -C "$SAGA_DASH" ls-files --error-unmatch "$DASH_CFG_REL" >/dev/null 2>&1 \
       && ! git -C "$SAGA_DASH" ls-files -v "$DASH_CFG_REL" 2>/dev/null | grep -q '^S'; then
      if git -C "$SAGA_DASH" update-index --skip-worktree "$DASH_CFG_REL" 2>/dev/null; then
        ok "saga-dash config.json marked skip-worktree (local sis-api override hidden from git)"
      fi
    fi
  fi
}

# Mesh is "up" only if ALL THREE services are running AND answering — not just
# postgres. The old check looked solely at soa-postgres-1, so a half-up mesh
# (redis/rabbitmq dead on a port clash, or rabbitmq crash-looping on a stale
# .erlang.cookie) was reported as healthy and `up` marched on into flaky,
# hard-to-trace failures downstream (programs/scheduling-api circuit-break and
# die without the broker — README drift #7). Any miss returns non-zero so the
# caller (re)runs `make up` or fails loudly.
mesh_healthy(){
  local c
  for c in soa-postgres-1 soa-redis-1 soa-rabbitmq-1; do
    [[ "$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null)" == running ]] || return 1
  done
  docker exec soa-postgres-1  pg_isready -U postgres_admin   >/dev/null 2>&1 || return 1
  docker exec soa-redis-1     redis-cli ping 2>/dev/null | grep -q PONG      || return 1
  docker exec soa-rabbitmq-1  rabbitmq-diagnostics -q ping   >/dev/null 2>&1 || return 1
  return 0
}

mesh_up(){
  if mesh_healthy; then ok "mesh already up (pg + redis + rabbitmq healthy)"; return; fi
  say "starting mesh (postgres + redis + rabbitmq)…"
  ( cd "$SOA/infra" && EXTRA_POSTGRES_SEED_DIR=../../projects/saga-mesh/seed \
      make up PROJECT=saga-mesh PROFILE=empty \
      POSTGRES_PORT=5432 REDIS_PORT=6379 RABBITMQ_PORT=5672 RABBITMQ_MGMT_PORT=15672 >"$STATE/mesh.log" 2>&1 ) \
    || { printf "\033[31m✗\033[0m mesh 'make up' failed (port clash? see check-ports output) — tail %s\n" "$STATE/mesh.log"; return 1; }
  # Wait for ALL THREE to answer, not just postgres — rabbitmq cold-boots slowest.
  local i
  for i in $(seq 1 45); do mesh_healthy && break; sleep 1; done
  if mesh_healthy; then
    ok "mesh up — pg :5432  redis :6379  rabbitmq :5672"
  else
    printf "\033[31m✗\033[0m mesh came up incomplete — redis/rabbitmq not healthy. Containers:\n"
    docker ps -a --format '  {{.Names}}\t{{.Status}}' | grep -E 'soa-(postgres|redis|rabbitmq)-1' || true
    printf "  tail %s (a stale rabbitmq cookie reads as '\''.erlang.cookie: eacces'\'')\n" "$STATE/mesh.log"
    return 1
  fi
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
migrate_db(){ # dir db_name [database_url]
  # Optional 3rd arg overrides the repo's configured DATABASE_URL — used to point
  # program-hub's programs/scheduling at the mesh (:5432) instead of its standalone
  # config default (:5433). Empty → repo config is used as-is (sis/iam read .env.local).
  local dir=$1 db=$2 url=${3:-}
  if [[ "$(docker exec soa-postgres-1 psql -U postgres_admin -d "$db" -tAc \
        "SELECT to_regclass('public._prisma_migrations') IS NOT NULL" 2>/dev/null)" == t ]]; then
    ( cd "$dir" && env ${url:+DATABASE_URL="$url"} pnpm db:deploy >/dev/null 2>&1 )                         # migration-managed → apply pending (non-destructive)
  else
    ( cd "$dir" && env ${url:+DATABASE_URL="$url"} pnpm prisma migrate reset --force >/dev/null 2>&1 )  # unmanaged (db:push'd / empty) → drop + replay all migrations (no seed configured in prisma.config.ts)
  fi
}

prep(){
  say "reconciling rostering deps + workspace build (main switch is not dep-neutral)…"
  ( cd "$ROSTERING" && pnpm install >/dev/null 2>&1 && pnpm build >/dev/null 2>&1 ) || true
  say "reconciling program-hub deps + workspace build (new deps / stale workspace dist after a main pull)..."
  ( cd "$PROGRAM_HUB" && pnpm install >/dev/null 2>&1 && pnpm build >/dev/null 2>&1 ) || true
  # student-data-system: ads-adm-api imports the workspace pkg @saga-ed/ads-adm-db,
  # which needs (a) its prisma client GENERATED (src/prisma/generated — migrate
  # deploy does NOT generate it) and (b) a built dist. Without these, ads-adm-api's
  # tsup dev build fails (Cannot find ads-adm-db / generated client) and the service
  # never starts. Build ONLY ads-adm-api's dep closure so an unrelated broken pkg
  # (e.g. transcripts-db) doesn't abort it. (up.sh skipped SDS prep entirely before.)
  say "preparing student-data-system (ads-adm-api deps: prisma client + dist)…"
  ( cd "$SDS" && pnpm install >/dev/null 2>&1 ) || true
  ( cd "$SDS/packages/node/ads-adm-db" && pnpm db:generate >/dev/null 2>&1 ) || true
  ( cd "$SDS" && pnpm --filter '@saga-ed/ads-adm-api^...' build >/dev/null 2>&1 ) || true
  say "applying prisma schemas (migrate deploy — canonical, see d1.5)…"
  ( cd "$ROSTERING/packages/node/iam-db"       && pnpm prisma migrate deploy >/dev/null 2>&1 )
  ( cd "$ROSTERING/packages/node/iam-pii-db"   && pnpm prisma db push        >/dev/null 2>&1 )
  migrate_db "$PROGRAM_HUB/apps/node/programs-api"   programs   "$PROGRAMS_DB_URL"   # mesh, not program-hub's :5433 default
  migrate_db "$PROGRAM_HUB/apps/node/scheduling-api" scheduling "$SCHEDULING_DB_URL"
  migrate_db "$ROSTERING/packages/node/sis-db"       sis_db   # sis-api schema (d1.7) — reads .env.local (mesh)
  ( cd "$SDS/packages/node/ads-adm-db"         && pnpm prisma migrate deploy >/dev/null 2>&1 )
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
  launch iam-api "$IAM_PORT" "$ROSTERING/apps/node/iam-api" PORT="$IAM_PORT"
  # sis-api → iam-api service.* over S2S; no creds locally (iam-api dev-bypass
  # synthesizes a service actor when auth is off). IAM_BASEURL/IAM_TOKENURL must
  # point at iam on :3010 (sis-api defaults to :3000). See d1.7.
  launch sis-api "$SIS_PORT" "$ROSTERING/apps/node/sis-api" \
     NODE_ENV=development PORT="$SIS_PORT" \
     SIS_DATABASE_URL="$SIS_DB_URL" \
     IAM_BASEURL="$IAM_URL/trpc" IAM_TOKENURL="$IAM_URL/v1/oauth/token"
  # DATABASE_URL injected → mesh (:5432); program-hub config defaults to its own :5433 stack,
  # but process-env is authoritative over config/.env.development (drift #7).
  launch programs-api 3006 "$PROGRAM_HUB/apps/node/programs-api"     NODE_ENV=development DATABASE_URL="$PROGRAMS_DB_URL"   IAM_API_URL="$IAM_URL" RABBITMQ_URL="$MESH_MQ" JANUS_REQUIRED=false JWT_ISSUER="$IAM_JWT_ISSUER"
  launch scheduling-api 3008 "$PROGRAM_HUB/apps/node/scheduling-api" NODE_ENV=development DATABASE_URL="$SCHEDULING_DB_URL" IAM_API_URL="$IAM_URL" RABBITMQ_URL="$MESH_MQ" JANUS_REQUIRED=false JWT_ISSUER="$IAM_JWT_ISSUER"
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

# ── seeding ──────────────────────────────────────────────────────────
seed_iam(){
  say "seeding SYNTHETIC iam roster (rostering program-hub scenario)…"
  ( cd "$ROSTERING" && pnpm tsx scripts/scenarios/src/run.ts program-hub --url "$IAM_URL" )
  ok "synthetic roster seeded — see --status"
}

# Seeds programs/periods/enrollment against the already-seeded roster. The
# iam↔programs auth-contract drift that used to block this is RESOLVED (d1.2):
# iam-api issues a JWT iam_session cookie and programs-api verifies it locally.
seed_programs(){
  say "seeding SYNTHETIC programs (program-hub programs scenario)…"
  ( cd "$PROGRAM_HUB/scripts/scenarios" && pnpm tsx src/run.ts programs --iam-url "$IAM_URL" --url http://localhost:3006 )
  ok "synthetic programs seeded"
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
DO_UP=0; DO_RESET=0; DO_SEED=0; SEED_MODE=roster; DO_LOGIN=0; LOGIN_USER=$DEFAULT_LOGIN_USER
case "${1:-up}" in
  up|--up)                       DO_UP=1; shift ;;
  --down)                        services_down; exit 0 ;;
  --status)                      status; exit 0 ;;
  -h|--help)                     sed -n '2,51p' "$0"; exit 0 ;;
  --reset|--seed|--login|--user) ;;        # flag-only invocation; skip up
  *) echo "unknown: $1 (use --help)"; exit 1 ;;
esac
while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset) DO_RESET=1; shift ;;
    --seed)  DO_SEED=1; shift; case "${1:-}" in roster|full) SEED_MODE=$1; shift ;; esac ;;
    # --login / --user [email]: optional positional email; bare or next-flag → default persona
    --login|--user) DO_LOGIN=1; shift; case "${1:-}" in ''|--*) ;; *) LOGIN_USER=$1; shift ;; esac ;;
    *) echo "unknown flag: $1 (use --help)"; exit 1 ;;
  esac
done

if [[ $DO_UP == 1 ]]; then
  check_branches; apply_fixes; mesh_up; prep
  # With --reset, do a CLEAN restart: stop running services (incl. stale tsup /
  # vite watchers that accumulate across runs) and clear vite caches, so
  # services_up starts FRESH on current code rather than reusing stale
  # "already up" processes / cached bundles.
  if [[ $DO_RESET == 1 ]]; then
    say "reset: clean restart — stopping running services + clearing vite caches..."
    services_down; nuke_vite
  fi
  services_up
  ok "stack up — try: $0 --status"
fi
[[ $DO_RESET == 1 ]] && reset_data
[[ $DO_SEED == 1 ]]  && seed_stack "$SEED_MODE"
[[ $DO_LOGIN == 1 ]] && login_user "$LOGIN_USER"
exit 0

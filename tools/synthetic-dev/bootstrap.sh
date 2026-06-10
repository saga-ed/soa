#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# bootstrap.sh — one command to land in the team's exact synthetic-dev state.
#
# Chains the steps a new engineer (e.g. Adam) needs:
#   1. ensure-repos       — clone any missing of the 5 siblings + co:login & install
#   2. refresh-suite.sh   — rebuild local/integration = main + the pinned PRs
#   3. up.sh up --reset --seed roster — mesh + 6 services, fresh synthetic roster
#   4. verify.sh          — assert every service is green and the roster seeded
#
# Stops at the first failing step (so you fix it before the next). For the
# steady-state loop afterward, use up.sh / refresh-suite.sh directly.
#
# Usage:
#   ./bootstrap.sh                  full: refresh suite + up + seed + verify
#   ./bootstrap.sh --no-refresh     skip step 1 (already on the right branches)
#   ./bootstrap.sh --seed full      seed roster + programs/periods/enrollment
#   DEV=~/work ./bootstrap.sh       non-default sibling-repo parent
#
# Prereqs (see getting-started.md): Docker running, `gh` authenticated, and AWS
# creds for CodeArtifact. The 5 sibling repos no longer need pre-cloning — step 1
# clones + installs any that are missing (under $DEV, default ~/dev).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
DO_REFRESH=1; SEED_MODE=roster
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-refresh) DO_REFRESH=0; shift ;;
    --seed) shift; case "${1:-}" in roster|full) SEED_MODE=$1; shift ;; *) echo "--seed needs roster|full"; exit 1 ;; esac ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown: $1 (use --help)"; exit 1 ;;
  esac
done

step(){ printf "\n\033[1m\033[36m▶ %s\033[0m\n" "$*"; }
say(){  printf "\033[34m→\033[0m %s\n" "$*"; }
ok(){   printf "\033[32m✓\033[0m %s\n" "$*"; }
warn(){ printf "\033[33m⚠\033[0m %s\n" "$*"; }
err(){  printf "\033[31m✗\033[0m %s\n" "$*"; }

DEV=${DEV:-$HOME/dev}
SDS=${SDS:-$DEV/student-data-system}

# Step 1 — the real one-time machine bootstrap: make sure all five sibling repos
# are cloned, and fully provision (co:login + install) any we have to clone, so a
# fresh clone is launch-ready and the run continues without a manual re-run.
# Idempotent: a no-op when all five are present. Only freshly-cloned repos are
# installed (re-runs stay fast). Fails fast when non-interactive.
ensure_repos(){
  local miss=()
  for kv in "$DEV/soa:soa" "$DEV/rostering:rostering" "$DEV/program-hub:program-hub" \
            "$DEV/saga-dash:saga-dash" "$SDS:student-data-system"; do
    [[ -d "${kv%:*}/.git" ]] || miss+=("$kv")
  done
  if [[ ${#miss[@]} -eq 0 ]]; then ok "all 5 sibling repos present"; return 0; fi

  err "${#miss[@]} sibling repo(s) not cloned under $DEV:"
  for kv in "${miss[@]}"; do printf "    %-20s → %s\n" "${kv#*:}" "${kv%:*}"; done

  if [[ ! -t 0 ]]; then
    err "non-interactive — clone them (git clone git@github.com:saga-ed/<repo>.git), then re-run"
    exit 1
  fi
  printf "  Clone + install the missing repo(s) now? [y/N] "; read -r ans || ans=
  [[ "${ans:-}" == [yY]* ]] || { err "cannot continue without all sibling repos"; exit 1; }

  for kv in "${miss[@]}"; do
    local dir=${kv%:*} name=${kv#*:}
    say "cloning $name → $dir…"
    git clone "git@github.com:saga-ed/$name.git" "$dir" \
      || { err "clone failed for $name — clone it by hand, then re-run"; exit 1; }
    say "provisioning $name (co:login + install)…"
    ( cd "$dir" && pnpm co:login ) || warn "co:login failed in $name — continuing (install may 401 without a valid CodeArtifact token)"
    if ( cd "$dir" && pnpm install ); then
      ok "$name cloned + installed"
    else
      err "$name: pnpm install failed (likely CodeArtifact auth). Run 'pnpm co:login && pnpm install' in $dir, then re-run."
      exit 1
    fi
  done
  ok "repos ensured"
}

step "1/4 ensure repos — clone + install any missing of the 5 siblings"
ensure_repos

if [[ $DO_REFRESH == 1 ]]; then
  step "2/4 refresh-suite — pinned in-flight PRs onto local/integration"
  "$DIR/refresh-suite.sh" || { echo "refresh-suite failed — resolve above, then re-run"; exit 1; }
else
  step "2/4 refresh-suite — SKIPPED (--no-refresh)"
fi

step "3/4 up.sh — mesh + 6 services + reset + seed $SEED_MODE"
"$DIR/up.sh" up --reset --seed "$SEED_MODE" || { echo "up.sh failed — tail /tmp/sds-synthetic/*.log"; exit 1; }

step "4/4 verify — assert all green"
"$DIR/verify.sh" || { echo "verification failed — see reds above"; exit 1; }

printf "\n\033[32m✓ bootstrap complete — you're in the team's synthetic-dev state.\033[0m\n"
echo "  Log in: http://localhost:3010/demo#auth as dev@saga.org, then http://localhost:8900"
echo "  Or:     ./up.sh --login   (mints a session + opens an auto-logged-in Chromium)"

#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# bootstrap.sh — one command to stand up the synthetic-dev stack on main.
#
# Chains the steps a new engineer (e.g. Adam) needs:
#   1. ensure-repos       — clone any missing of the 7 siblings + co:login & install
#   2. refresh-suite.sh   — apply your local overlay if present (else everyone on main)
#   3. up.sh up --reset --seed roster — mesh + 10 services, fresh synthetic roster
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
# creds for CodeArtifact. The 7 sibling repos no longer need pre-cloning — step 1
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

# Resolve a sibling repo's checkout path, honoring the per-repo override env
# vars up.sh exposes (SOA/ROSTERING/PROGRAM_HUB/SAGA_DASH/SDS/QBOARD/RTSM/FLEEK)
# so bootstrap provisions the SAME checkout up.sh will run — e.g. a clean
# `git worktree` of main when your primary checkout is dirty. Defaults to
# $DEV/<name>. The name→var map is explicit because SDS doesn't follow the
# uppercase-with-dashes-to-underscores rule.
repo_path(){ # name
  case "$1" in
    soa)                 echo "${SOA:-$DEV/soa}" ;;
    rostering)           echo "${ROSTERING:-$DEV/rostering}" ;;
    program-hub)         echo "${PROGRAM_HUB:-$DEV/program-hub}" ;;
    saga-dash)           echo "${SAGA_DASH:-$DEV/saga-dash}" ;;
    student-data-system) echo "${SDS:-$DEV/student-data-system}" ;;
    qboard)              echo "${QBOARD:-$DEV/qboard}" ;;
    rtsm)                echo "${RTSM:-$DEV/rtsm}" ;;
    fleek)               echo "${FLEEK:-$DEV/fleek}" ;;
    *)                   echo "$DEV/$1" ;;
  esac
}
# True when a repo's resolved path differs from the $DEV/<name> default —
# i.e. the user pointed it at an alternate checkout (e.g. a main worktree).
repo_overridden(){ [[ "$(repo_path "$1")" != "$DEV/$1" ]]; }

# Step 1 — the real one-time machine bootstrap: make sure all seven sibling repos
# are cloned AND installed, and fully provision (clone if missing, then
# co:login + install) any that aren't, so the run continues without a manual
# re-run. "Installed" = node_modules exists where a package.json does — this
# catches the cloned-long-ago-but-never-installed repo (it used to sail
# through and die much later at service launch). Idempotent and fast on
# re-runs (directory-existence checks only). Fails fast when non-interactive.
ensure_repos(){
  local need=() kv dir name reason rest ans
  for name in soa rostering program-hub saga-dash student-data-system qboard rtsm; do
    kv="$(repo_path "$name"):$name"
    dir=${kv%:*}
    # `.git` is a DIR in a normal clone but a FILE (a `gitdir:` pointer) in a
    # `git worktree` — accept either so an overridden worktree isn't mistaken
    # for "needs clone" (which would `git clone` over a populated worktree).
    if [[ ! -e "$dir/.git" ]]; then
      need+=("$kv:clone")
    elif [[ -f "$dir/package.json" && ! -d "$dir/node_modules" ]]; then
      need+=("$kv:install")
    fi
  done
  if [[ ${#need[@]} -eq 0 ]]; then ok "all 7 sibling repos present + installed"; return 0; fi

  err "${#need[@]} sibling repo(s) need provisioning under $DEV:"
  for kv in "${need[@]}"; do
    reason=${kv##*:}; rest=${kv%:*}
    printf "    %-20s → %s (%s)\n" "${rest#*:}" "${rest%:*}" "$reason"
  done

  if [[ ! -t 0 ]]; then
    err "non-interactive — provision them (git clone git@github.com:saga-ed/<repo>.git; pnpm co:login && pnpm install), then re-run"
    exit 1
  fi
  printf "  Provision the repo(s) above now? [y/N] "; read -r ans || ans=
  [[ "${ans:-}" == [yY]* ]] || { err "cannot continue without all sibling repos provisioned"; exit 1; }

  for kv in "${need[@]}"; do
    reason=${kv##*:}; rest=${kv%:*}; dir=${rest%:*}; name=${rest#*:}
    if [[ "$reason" == clone ]]; then
      say "cloning $name → $dir…"
      git clone "git@github.com:saga-ed/$name.git" "$dir" \
        || { err "clone failed for $name — clone it by hand, then re-run"; exit 1; }
    fi
    say "provisioning $name (co:login + install)…"
    ( cd "$dir" && pnpm co:login ) || warn "co:login failed in $name — continuing (install may 401 without a valid CodeArtifact token)"
    if ( cd "$dir" && pnpm install ); then
      ok "$name provisioned"
    else
      err "$name: pnpm install failed (likely CodeArtifact auth). Run 'pnpm co:login && pnpm install' in $dir, then re-run."
      exit 1
    fi
  done
  ok "repos ensured"
}

step "1/4 ensure repos — clone + install any missing of the 7 siblings"
ensure_repos

if [[ $DO_REFRESH == 1 ]]; then
  step "2/4 refresh-suite — apply local overlay if present (else everyone on main)"
  "$DIR/refresh-suite.sh" || { echo "refresh-suite failed — resolve above, then re-run"; exit 1; }
else
  step "2/4 refresh-suite — SKIPPED (--no-refresh)"
fi

step "3/4 up.sh — mesh + 10 services + reset + seed $SEED_MODE"
"$DIR/up.sh" up --reset --seed "$SEED_MODE" || { echo "up.sh failed — tail /tmp/sds-synthetic/*.log"; exit 1; }

step "4/4 verify — assert all green"
"$DIR/verify.sh" || { echo "verification failed — see reds above"; exit 1; }

printf "\n\033[32m✓ bootstrap complete — you're in the team's synthetic-dev state.\033[0m\n"
echo "  Log in: http://localhost:3010/demo#auth as dev@saga.org, then http://localhost:8900"
echo "  Or:     ./up.sh --login   (mints a session + opens an auto-logged-in Chromium)"

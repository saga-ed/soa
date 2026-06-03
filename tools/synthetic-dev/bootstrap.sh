#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# bootstrap.sh — one command to land in the team's exact synthetic-dev state.
#
# Chains the three steps a new engineer (e.g. Adam) needs:
#   1. refresh-suite.sh   — rebuild local/integration = main + the pinned PRs
#   2. up.sh up --reset --seed roster — mesh + 6 services, fresh synthetic roster
#   3. verify.sh          — assert every service is green and the roster seeded
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
# Prereqs (see getting-started.md): Docker running, the 5 sibling repos cloned,
# CodeArtifact auth (`pnpm co:login`), and `gh` authenticated.
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

if [[ $DO_REFRESH == 1 ]]; then
  step "1/3 refresh-suite — pinned in-flight PRs onto local/integration"
  "$DIR/refresh-suite.sh" || { echo "refresh-suite failed — resolve above, then re-run"; exit 1; }
else
  step "1/3 refresh-suite — SKIPPED (--no-refresh)"
fi

step "2/3 up.sh — mesh + 6 services + reset + seed $SEED_MODE"
"$DIR/up.sh" up --reset --seed "$SEED_MODE" || { echo "up.sh failed — tail /tmp/sds-synthetic/*.log"; exit 1; }

step "3/3 verify — assert all green"
"$DIR/verify.sh" || { echo "verification failed — see reds above"; exit 1; }

printf "\n\033[32m✓ bootstrap complete — you're in the team's synthetic-dev state.\033[0m\n"
echo "  Log in: http://localhost:3010/demo#auth as dev@saga.org, then http://localhost:8900"
echo "  Or:     ./up.sh --login   (mints a session + opens an auto-logged-in Chromium)"

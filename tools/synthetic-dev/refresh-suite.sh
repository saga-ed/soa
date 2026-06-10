#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# refresh-suite.sh — reproduce the team's exact in-flight integration state.
#
# Reads integration-suite.tsv (the PINNED set of not-yet-landed PRs) and drives
# refresh-integration.sh once per repo with that repo's PR numbers, so anyone
# who runs this lands in the SAME state — independent of who authored the PRs.
#
# This is the author-independent companion to refresh-integration.sh: that
# script defaults to `gh pr list --author @me` (per-author, and picks up the
# full open set); this one pins explicit PR numbers from the manifest so the
# curated subset is reproduced verbatim. See decisions/d1.8.
#
# Usage:
#   ./refresh-suite.sh              rebuild local/integration in every manifest repo
#   ./refresh-suite.sh --list       print the pinned suite and exit (no changes)
#   DEV=~/work ./refresh-suite.sh   non-default sibling-repo parent
#
# After this, run ./up.sh up --reset --seed roster (up.sh's prep builds the
# integration code) then ./verify.sh. Repos here end up ON local/integration —
# up.sh's check_branches will WARN about that; it's expected for this workflow.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="$SCRIPT_DIR/integration-suite.tsv"
REFRESH="$SCRIPT_DIR/refresh-integration.sh"

say()  { printf "\033[34m→\033[0m %s\n" "$*"; }
ok()   { printf "\033[32m✓\033[0m %s\n" "$*"; }
err()  { printf "\033[31m✗\033[0m %s\n" "$*"; }

[[ -f "$MANIFEST" ]] || { err "manifest not found: $MANIFEST"; exit 1; }
[[ -x "$REFRESH"  ]] || { err "refresh-integration.sh not found/executable: $REFRESH"; exit 1; }

# Strip comments + blank lines; keep "<repo>\t<prs>" rows.
rows="$(grep -vE '^\s*(#|$)' "$MANIFEST" || true)"

if [[ "${1:-}" == "--list" ]]; then
  printf "\033[1mPinned integration suite (%s):\033[0m\n" "$MANIFEST"
  if [[ -z "$rows" ]]; then
    echo "  (none — every repo stays on origin/main)"
  else
    while IFS=$'\t' read -r repo prs; do
      [[ -z "${repo:-}" ]] && continue
      printf "  %-20s PRs: %s\n" "$repo" "$prs"
    done <<<"$rows"
  fi
  exit 0
fi

# An empty manifest is a VALID, common state: every pinned PR has landed, so the
# whole stack just runs on origin/main. Treat it as success (not an error), so
# bootstrap proceeds — there's simply nothing to replay onto local/integration.
if [[ -z "$rows" ]]; then
  ok "no pinned PRs — every repo stays on origin/main (nothing to refresh)"
  exit 0
fi

failed=0
while IFS=$'\t' read -r repo prs; do
  [[ -z "${repo:-}" ]] && continue
  repo="${repo//[[:space:]]/}"; prs="${prs//[[:space:]]/}"
  [[ -z "$prs" ]] && { say "$repo — no PRs pinned, skipping"; continue; }
  say "refreshing $repo → origin/main + PRs $prs"
  if "$REFRESH" --prs "$prs" "$repo"; then
    ok "$repo refreshed"
  else
    err "$repo refresh reported issues (see above)"
    failed=1
  fi
done <<<"$rows"

printf "\n"
if [[ $failed -eq 0 ]]; then
  ok "suite applied — every repo on local/integration with its pinned PRs"
  echo "  next: ./up.sh up --reset --seed roster  &&  ./verify.sh"
else
  err "suite applied with issues — resolve conflicts above, then re-run"
fi
exit $failed

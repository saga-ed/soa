#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# refresh-integration.sh — rebuild a local-only `local/integration` branch in
# each named repo as `origin/main` + a merge of every open PR you author.
#
# Why: you can ship many small, atomic PRs (each its own branch off main) AND
# keep your dev environment running against the union of everything in flight.
# Run the synthetic-dev stack against `local/integration` in each repo; rerun
# this script when main moves, when you push to a PR, or when one merges.
#
# Usage:
#   ./refresh-integration.sh saga-dash                          # one repo
#   ./refresh-integration.sh saga-dash program-hub rostering    # several
#   ./refresh-integration.sh --prs 95,108 saga-dash             # explicit PR set
#   ./refresh-integration.sh --prs fix/foo,fix/bar saga-dash    # explicit branches
#   AUTHOR=someuser ./refresh-integration.sh saga-dash          # someone else's PRs
#   BASE=develop    ./refresh-integration.sh saga-dash          # non-main base
#   DEV=~/work      ./refresh-integration.sh saga-dash          # non-default $DEV
#
# Default discovery is `gh pr list --state open --author <AUTHOR>` per repo,
# which will include stale/old open PRs. Use --prs to pin the set explicitly
# (numbers resolve via `gh pr view` to head refs; bare names are used as-is).
# --prs applies to ALL repos given on the line.
#
# Behaviour per repo:
#   1. Skip if the working tree is dirty (commit/stash first).
#   2. `git fetch -q origin`.
#   3. `git checkout -B local/integration origin/<BASE>` (disposable; recreate).
#   4. List open PRs authored by $AUTHOR (default @me), merge each origin
#      branch in order with --no-ff. Conflicts are aborted and reported so
#      the rest still merge (best-effort).
#   5. Print a summary of merged / conflicted branches.
#
# Caveats:
#   - `local/integration` is local-only — DO NOT push it.
#   - If two open PRs touch the same lines you'll see a conflict here; resolve
#     in the integration branch (the PR branches stay clean).
#   - Requires `gh` authenticated; `gh pr list` runs in each repo dir.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

DEV=${DEV:-$HOME/dev}
AUTHOR=${AUTHOR:-@me}
BASE=${BASE:-main}
INT=local/integration

say()  { printf "\033[34m→\033[0m %s\n" "$*"; }
ok()   { printf "\033[32m✓\033[0m %s\n" "$*"; }
warn() { printf "\033[33m⚠\033[0m %s\n" "$*"; }
err()  { printf "\033[31m✗\033[0m %s\n" "$*"; }

# ── arg parsing (flags then repo names) ──────────────────────────────
PRS_OVERRIDE=""
REPOS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prs)      PRS_OVERRIDE="$2"; shift 2 ;;
    --prs=*)    PRS_OVERRIDE="${1#--prs=}"; shift ;;
    -h|--help)  sed -n '2,40p' "$0"; exit 0 ;;
    --)         shift; while [[ $# -gt 0 ]]; do REPOS+=("$1"); shift; done ;;
    -*)         err "unknown flag: $1"; exit 1 ;;
    *)          REPOS+=("$1"); shift ;;
  esac
done
[[ ${#REPOS[@]} -ge 1 ]] || { sed -n '2,40p' "$0"; exit 1; }

# Resolve --prs (numbers → head refs via `gh pr view`, plain names kept as-is).
# Resolution is per-repo: head-ref of PR #95 in saga-dash is not the same as in
# program-hub, so we re-resolve inside the per-repo loop below.
overall_failed=0

for name in "${REPOS[@]}"; do
  repo="$DEV/$name"
  printf "\n\033[1m=== %s ===\033[0m\n" "$name"

  if [[ ! -d "$repo/.git" ]]; then
    err "$repo is not a git repo — skipping"
    overall_failed=1
    continue
  fi

  cd "$repo"

  # Untracked files (e.g. runtime auth dirs) survive `checkout -B`; only block
  # on tracked modifications — those a checkout could overwrite.
  if [[ -n $(git status --porcelain | grep -v '^??' || true) ]]; then
    warn "modified/staged changes in $name — skipping (commit/stash first)"
    overall_failed=1
    continue
  fi

  say "fetching origin…"
  if ! git fetch -q origin; then
    err "fetch failed — skipping $name"
    overall_failed=1
    continue
  fi

  if ! git rev-parse --verify --quiet "origin/$BASE" >/dev/null; then
    err "origin/$BASE does not exist in $name — skipping"
    overall_failed=1
    continue
  fi

  say "(re)creating $INT from origin/$BASE…"
  git checkout -B "$INT" "origin/$BASE" >/dev/null 2>&1

  if [[ -n "$PRS_OVERRIDE" ]]; then
    # Resolve each comma-separated token: numeric → PR head ref (per this repo),
    # else used verbatim as a branch name.
    branches=""
    IFS=',' read -ra tokens <<<"$PRS_OVERRIDE"
    for tok in "${tokens[@]}"; do
      tok="${tok// /}"
      [[ -z "$tok" ]] && continue
      if [[ "$tok" =~ ^[0-9]+$ ]]; then
        ref=$(gh pr view "$tok" --json headRefName --jq '.headRefName' 2>/dev/null || true)
        if [[ -n "$ref" ]]; then branches+="$ref"$'\n'
        else warn "PR #$tok not found in $name — skipping"; fi
      else
        branches+="$tok"$'\n'
      fi
    done
  else
    branches=$(gh pr list --state open --author "$AUTHOR" \
                --json headRefName --jq '.[].headRefName' 2>/dev/null || true)
  fi

  if [[ -z "$branches" ]]; then
    ok "no PRs to merge — $INT == origin/$BASE"
    continue
  fi

  merged=()
  conflicted=()
  missing=()
  while IFS= read -r b; do
    [[ -z "$b" ]] && continue
    if ! git rev-parse --verify --quiet "origin/$b" >/dev/null; then
      missing+=("$b")
      continue
    fi
    say "merging $b…"
    if git merge --no-ff --no-edit "origin/$b" >/dev/null 2>&1; then
      merged+=("$b")
    else
      git merge --abort 2>/dev/null || true
      conflicted+=("$b")
      warn "conflict on $b — aborted; resolve interactively with: git merge origin/$b"
    fi
  done <<<"$branches"

  ok "merged: ${merged[*]:-(none)}"
  [[ ${#conflicted[@]} -gt 0 ]] && { warn "conflicted: ${conflicted[*]}"; overall_failed=1; }
  [[ ${#missing[@]}    -gt 0 ]] && { warn "missing on origin: ${missing[*]}"; overall_failed=1; }
done

printf "\n"
if [[ $overall_failed -eq 0 ]]; then
  ok "all repos refreshed cleanly. Dev stack should pick up changes via HMR."
else
  warn "completed with issues — see above."
fi
exit $overall_failed

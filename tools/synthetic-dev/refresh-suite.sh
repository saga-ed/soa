#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# refresh-suite.sh — overlay your in-flight PRs onto a main-based synthetic-dev.
#
# synthetic-dev runs every repo on origin/main by DEFAULT. This script is how you
# optionally overlay your OWN not-yet-landed PRs: for each repo it rebuilds a
# local-only `local/integration` branch = origin/main + a --no-ff merge of each
# given PR, so the stack runs against the union of main + your work in flight.
#
# Two ways to say which PRs:
#   • Personal overlay file — integration-suite.local.tsv (.gitignored). One row
#     per repo: "<repo><TAB><comma-separated PR#s>". Run with no args to apply it.
#     Absent/empty file = the default: every repo stays on main (clean no-op).
#     Copy integration-suite.example.tsv → integration-suite.local.tsv to start.
#   • Ad-hoc — `--prs <#s|branches> <repo...>` overlays an explicit set without
#     touching the file (numbers resolve to PR head refs via `gh pr view`; bare
#     names are used as branches verbatim).
#
# The overlay is per-developer, never committed — so your in-flight PRs never
# land on a teammate. (Supersedes the old shared, source-controlled manifest +
# the separate refresh-integration.sh; see README.md / getting-started.md.)
#
# Usage:
#   ./refresh-suite.sh                       apply integration-suite.local.tsv (no-op if absent)
#   ./refresh-suite.sh --list                print your overlay file and exit
#   ./refresh-suite.sh --reset [repo...]     back out: overlaid repos → main (all, or named)
#   ./refresh-suite.sh --prs 165 saga-dash               ad-hoc: one repo, one PR
#   ./refresh-suite.sh --prs 410,432 rostering           ad-hoc: several PRs
#   ./refresh-suite.sh --prs fix/foo saga-dash           ad-hoc: an explicit branch
#   BASE=develop ./refresh-suite.sh --prs 5 saga-dash    non-main base
#   DEV=~/work   ./refresh-suite.sh                      non-default sibling parent
#
# After this, run ./up.sh up --reset --seed roster (up.sh's prep builds the
# overlaid code) then ./verify.sh. Overlaid repos end up ON local/integration —
# up.sh's check_branches WARNs about that; it's expected for this workflow.
#
# Caveats:
#   - `local/integration` is local-only — DO NOT push it.
#   - Two PRs touching the same lines conflict here; that merge is aborted and
#     reported (the rest still apply). Resolve in local/integration, or drop the
#     PR. The PR branches themselves stay clean.
#   - Requires `gh` authenticated (numeric PR# → branch resolution runs per repo).
#   - When an overlaid PR merges to main, drop it from your set; when a repo has
#     no overlay left, `git checkout main` there to leave local/integration.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="$SCRIPT_DIR/integration-suite.local.tsv"
EXAMPLE="$SCRIPT_DIR/integration-suite.example.tsv"
DEV=${DEV:-$HOME/dev}
BASE=${BASE:-main}
INT=local/integration
# Repos this stack overlays (the ones up.sh/verify.sh posture-check); soa +
# student-data-system are always on main and never overlaid.
MANAGED_REPOS="rostering program-hub saga-dash"

say()  { printf "\033[34m→\033[0m %s\n" "$*"; }
ok()   { printf "\033[32m✓\033[0m %s\n" "$*"; }
warn() { printf "\033[33m⚠\033[0m %s\n" "$*"; }
err()  { printf "\033[31m✗\033[0m %s\n" "$*"; }

usage(){ sed -n '23,31p' "$0" | sed 's/^# \{0,1\}//'; }

# ── engine: rebuild ONE repo's local/integration = origin/BASE + the given
# PR#s/branches. Echoes progress; returns non-zero if anything didn't apply.
refresh_repo(){ # name  prs_csv
  local name=$1 prs=$2
  local repo="$DEV/$name"
  printf "\n\033[1m=== %s ===\033[0m\n" "$name"

  if [[ ! -d "$repo/.git" ]]; then
    err "$repo is not a git repo — skipping"; return 1
  fi
  cd "$repo"

  # Untracked files (e.g. runtime auth dirs) survive `checkout -B`; only block on
  # tracked modifications — those a checkout could overwrite.
  if [[ -n $(git status --porcelain | grep -v '^??' || true) ]]; then
    warn "modified/staged changes in $name — skipping (commit/stash first)"; return 1
  fi

  say "fetching origin…"
  git fetch -q origin || { err "fetch failed — skipping $name"; return 1; }

  if ! git rev-parse --verify --quiet "origin/$BASE" >/dev/null; then
    err "origin/$BASE does not exist in $name — skipping"; return 1
  fi

  say "(re)creating $INT from origin/$BASE…"
  git checkout -B "$INT" "origin/$BASE" >/dev/null 2>&1

  # Resolve each comma-separated token: numeric → PR head ref (per this repo),
  # else used verbatim as a branch name.
  local branches="" tok ref
  IFS=',' read -ra tokens <<<"$prs"
  for tok in "${tokens[@]}"; do
    tok="${tok// /}"; [[ -z "$tok" ]] && continue
    if [[ "$tok" =~ ^[0-9]+$ ]]; then
      ref=$(gh pr view "$tok" --json headRefName --jq '.headRefName' 2>/dev/null || true)
      if [[ -n "$ref" ]]; then branches+="$ref"$'\n'
      else warn "PR #$tok not found in $name — skipping"; fi
    else
      branches+="$tok"$'\n'
    fi
  done

  if [[ -z "$branches" ]]; then
    ok "no PRs to merge — $INT == origin/$BASE"; return 0
  fi

  local merged=() conflicted=() missing=() b
  while IFS= read -r b; do
    [[ -z "$b" ]] && continue
    if ! git rev-parse --verify --quiet "origin/$b" >/dev/null; then
      missing+=("$b"); continue
    fi
    say "merging $b…"
    if git merge --no-ff --no-edit "origin/$b" >/dev/null 2>&1; then
      merged+=("$b")
    else
      git merge --abort 2>/dev/null || true
      conflicted+=("$b")
      warn "conflict on $b — aborted; resolve with: git merge origin/$b"
    fi
  done <<<"$branches"

  ok "merged: ${merged[*]:-(none)}"
  local rc=0
  [[ ${#conflicted[@]} -gt 0 ]] && { warn "conflicted: ${conflicted[*]}"; rc=1; }
  [[ ${#missing[@]}    -gt 0 ]] && { warn "missing on origin: ${missing[*]}"; rc=1; }
  return $rc
}

# ── arg parse (flags then repo names) ────────────────────────────────
PRS_OVERRIDE=""; REPOS=(); LIST=0; RESET=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prs)     PRS_OVERRIDE="$2"; shift 2 ;;
    --prs=*)   PRS_OVERRIDE="${1#--prs=}"; shift ;;
    --list)    LIST=1; shift ;;
    --reset)   RESET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --)        shift; while [[ $# -gt 0 ]]; do REPOS+=("$1"); shift; done ;;
    -*)        err "unknown flag: $1"; usage; exit 1 ;;
    *)         REPOS+=("$1"); shift ;;
  esac
done

# ── --list: print the personal overlay file, then exit ───────────────
if [[ $LIST -eq 1 ]]; then
  printf "\033[1mPersonal overlay (%s):\033[0m\n" "$MANIFEST"
  if [[ -f "$MANIFEST" ]]; then
    rows="$(grep -vE '^\s*(#|$)' "$MANIFEST" || true)"
    if [[ -z "$rows" ]]; then
      echo "  (none — every repo stays on origin/main)"
    else
      while IFS=$'\t' read -r repo prs; do
        [[ -z "${repo:-}" ]] && continue
        printf "  %-20s PRs: %s\n" "${repo//[[:space:]]/}" "${prs//[[:space:]]/}"
      done <<<"$rows"
    fi
  else
    echo "  (no local overlay — every repo stays on origin/main; cp ${EXAMPLE##*/} ${MANIFEST##*/} to add one)"
  fi
  exit 0
fi

# ── --reset: back out the overlay — return repos to main ─────────────
# Moves any overlaid repo (currently on local/integration) back to main and
# deletes the disposable local/integration branch. With no repos given, resets
# every managed repo; otherwise just the named ones. Leaves your
# integration-suite.local.tsv alone — delete/empty it (or drop a row) to make the
# backout stick across the next refresh.
if [[ $RESET -eq 1 ]]; then
  targets=("${REPOS[@]}")
  [[ ${#targets[@]} -eq 0 ]] && read -ra targets <<<"$MANAGED_REPOS"
  failed=0
  for name in "${targets[@]}"; do
    dir="$DEV/$name"
    [[ -d "$dir/.git" ]] || { warn "$name — not a git repo at $dir; skipping"; continue; }
    cur=$(git -C "$dir" branch --show-current 2>/dev/null)
    if [[ "$cur" != "$INT" ]]; then
      ok "$name already on '${cur:-?}' (not overlaid)"
      git -C "$dir" rev-parse --verify --quiet "$INT" >/dev/null 2>&1 \
        && git -C "$dir" branch -D "$INT" >/dev/null 2>&1 \
        && say "$name — removed stale $INT branch"
      continue
    fi
    if [[ -n $(git -C "$dir" status --porcelain | grep -v '^??' || true) ]]; then
      warn "$name — uncommitted changes on $INT; commit/stash first, skipping"; failed=1; continue
    fi
    if git -C "$dir" checkout "$BASE" >/dev/null 2>&1; then
      git -C "$dir" branch -D "$INT" >/dev/null 2>&1
      ok "$name → $BASE ($INT removed)"
    else
      err "$name — couldn't checkout $BASE; resolve manually"; failed=1
    fi
  done
  printf "\n"
  [[ $failed -eq 0 ]] && ok "backed out — repos on $BASE (your overlay file is untouched)" \
                      || err "backout had issues — see above"
  exit $failed
fi

# ── ad-hoc: --prs <set> <repo...> overlays an explicit set, bypassing the file
if [[ -n "$PRS_OVERRIDE" ]]; then
  [[ ${#REPOS[@]} -ge 1 ]] || { err "--prs needs at least one repo, e.g. --prs 165 saga-dash"; exit 1; }
  failed=0
  for name in "${REPOS[@]}"; do refresh_repo "$name" "$PRS_OVERRIDE" || failed=1; done
  printf "\n"
  if [[ $failed -eq 0 ]]; then ok "overlay applied — listed repo(s) on local/integration"
  else err "overlay applied with issues — resolve above, then re-run"; fi
  exit $failed
fi

# A bare repo with no --prs has no PR source (we don't auto-discover open PRs).
# Steer to the explicit form or the file.
if [[ ${#REPOS[@]} -ge 1 ]]; then
  err "no PRs given for: ${REPOS[*]}"
  echo "  use --prs, e.g.  ./refresh-suite.sh --prs 165 ${REPOS[0]}"
  echo "  or list them in ${MANIFEST##*/} and run with no args."
  exit 1
fi

# ── file-driven (no args): apply integration-suite.local.tsv ─────────
# No (or empty) overlay is the VALID, common DEFAULT: the whole stack just runs
# on origin/main. Treat it as success — nothing to replay onto local/integration.
if [[ -f "$MANIFEST" ]]; then
  rows="$(grep -vE '^\s*(#|$)' "$MANIFEST" || true)"
else
  rows=""
fi
if [[ -z "$rows" ]]; then
  ok "no local overlay — every repo stays on origin/main (nothing to refresh)"
  exit 0
fi

failed=0
while IFS=$'\t' read -r repo prs; do
  [[ -z "${repo:-}" ]] && continue
  repo="${repo//[[:space:]]/}"; prs="${prs//[[:space:]]/}"
  [[ -z "$prs" ]] && { say "$repo — no PRs listed, skipping"; continue; }
  refresh_repo "$repo" "$prs" || failed=1
done <<<"$rows"

printf "\n"
if [[ $failed -eq 0 ]]; then
  ok "overlay applied — every listed repo on local/integration with its PRs"
  echo "  next: ./up.sh up --reset --seed roster  &&  ./verify.sh"
else
  err "overlay applied with issues — resolve conflicts above, then re-run"
fi
exit $failed

#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# clone-repos.sh — get every sibling repo the synthetic-dev stack needs onto
# this machine, so `ss` / bootstrap.sh has something to drive.
#
# For each repo: report it if already present, `gh repo clone` it if not.
# Idempotent — safe to re-run any time a new repo joins the mesh.
#
# This script is deliberately SELF-CONTAINED (no repo files, no pnpm, no node)
# so it can run before anything is checked out:
#
#   gh api -H 'Accept: application/vnd.github.raw' \
#     /repos/saga-ed/soa/contents/tools/synthetic-dev/clone-repos.sh | bash
#
# Usage:
#   ./clone-repos.sh                 clone any missing of the 7 required repos
#   ./clone-repos.sh --with-optional also clone coach + fleek
#   ./clone-repos.sh --dry-run       report what it WOULD clone, clone nothing
#   DEV=~/work ./clone-repos.sh      non-default sibling-repo parent
#
# It does NOT install deps. Once the checkouts exist, run bootstrap.sh (or
# `ss stack bootstrap`), which does co:login + pnpm install + brings the stack up.
#
# Prereq: `gh` authenticated (`gh auth status`). Unlike bootstrap.sh's SSH
# clone, `gh repo clone` rides your existing gh auth — no SSH key setup needed.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

ORG=saga-ed
WITH_OPTIONAL=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --with-optional) WITH_OPTIONAL=1; shift ;;
        --dry-run)       DRY_RUN=1; shift ;;
        -h|--help)       sed -n '2,26p' "$0"; exit 0 ;;
        *) echo "unknown: $1 (use --help)"; exit 1 ;;
    esac
done

say(){  printf "\033[34m→\033[0m %s\n" "$*"; }
ok(){   printf "\033[32m✓\033[0m %s\n" "$*"; }
warn(){ printf "\033[33m⚠\033[0m %s\n" "$*"; }
err(){  printf "\033[31m✗\033[0m %s\n" "$*"; }

command -v gh >/dev/null 2>&1 || { err "gh not found — install the GitHub CLI: https://cli.github.com"; exit 1; }
gh auth status >/dev/null 2>&1 || { err "gh is not authenticated — run 'gh auth login', then re-run"; exit 1; }

DEV=${DEV:-$HOME/dev}

# The 7 repos `up.sh` requires, in the order bootstrap.sh's step-1 loop lists them.
REQUIRED=(soa rostering program-hub saga-dash student-data-system qboard rtsm)
# Not provisioned by bootstrap; cloned only under --with-optional.
OPTIONAL=(coach fleek)

REPOS=("${REQUIRED[@]}")
[[ $WITH_OPTIONAL == 1 ]] && REPOS+=("${OPTIONAL[@]}")

# Resolve a repo's checkout path, honoring the per-repo override env vars up.sh
# exposes, so we provision the SAME checkout up.sh will run. Defaults to
# $DEV/<name>. The map is explicit because SDS doesn't follow the
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
        coach)               echo "${COACH:-$DEV/coach}" ;;
        fleek)               echo "${FLEEK:-$DEV/fleek}" ;;
        *)                   echo "$DEV/$1" ;;
    esac
}

mkdir -p "$DEV" || { err "cannot create $DEV"; exit 1; }
say "sibling-repo parent: $DEV"

present=0; cloned=0; failed=0; skipped=0

for name in "${REPOS[@]}"; do
    dir="$(repo_path "$name")"

    # `.git` is a DIR in a normal clone but a FILE (a `gitdir:` pointer) in a
    # `git worktree` — `-e` accepts either, so an overridden worktree isn't
    # mistaken for "needs clone" (which would clone over a populated checkout).
    if [[ -e "$dir/.git" ]]; then
        ok "$(printf '%-20s' "$name") present  → $dir"
        present=$((present + 1))
        continue
    fi

    # A non-empty directory with no `.git` is someone else's business — a
    # half-finished clone, a stray unpack. Cloning into it would fail anyway.
    if [[ -e "$dir" ]] && [[ -n "$(ls -A "$dir" 2>/dev/null)" ]]; then
        warn "$(printf '%-20s' "$name") SKIPPED — $dir exists and is non-empty, but has no .git"
        skipped=$((skipped + 1))
        continue
    fi

    if [[ $DRY_RUN == 1 ]]; then
        say "$(printf '%-20s' "$name") would clone → $dir"
        cloned=$((cloned + 1))
        continue
    fi

    say "cloning $name → $dir…"
    if gh repo clone "$ORG/$name" "$dir"; then
        ok "$name cloned"
        cloned=$((cloned + 1))
    else
        err "$name: clone failed"
        failed=$((failed + 1))
    fi
done

printf "\n"
if [[ $DRY_RUN == 1 ]]; then
    say "dry run: $present present, $cloned to clone, $skipped skipped"
    exit 0
fi

say "$present present, $cloned cloned, $skipped skipped, $failed failed"

if [[ $skipped -gt 0 ]]; then
    warn "clear or move the skipped director$([[ $skipped -eq 1 ]] && echo y || echo ies) above, then re-run"
fi
if [[ $failed -gt 0 ]]; then
    err "clone failed for $failed repo(s) — check 'gh auth status' and your org access, then re-run"
    exit 1
fi

ok "all repos present under $DEV"
printf "\nNext: install deps and stand the stack up —\n"
printf "    cd %s && pnpm install\n" "$(repo_path soa)"
printf "    ./tools/synthetic-dev/bootstrap.sh        # or: ss stack bootstrap\n"

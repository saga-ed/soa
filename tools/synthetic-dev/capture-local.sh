#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# capture-local.sh — snapshot the developer's local mesh checkouts into a
# workspace.json.
#
# Local → cloud direction of the bidirectional config capture/replay tooling:
# walks the same sibling-repo paths check_branches() already knows, reads each
# repo's checked-out commit, and emits a workspace.json (the same manifest
# shape capture-sandbox.sh produces, read by both `up.sh --workspace` and
# apply-local.sh) so a developer's in-progress local state can be pushed to a
# cloud sandbox for full-mesh validation instead of "whatever's on main."
#
# Usage:
#   ./capture-local.sh                 → prints workspace.json to stdout
#   ./capture-local.sh -o out.json      → writes to out.json
#   ./capture-local.sh --allow-dirty    → capture repos with uncommitted
#                                          changes anyway (their sha then
#                                          reflects HEAD, NOT the working tree —
#                                          apply only ever pins a committed sha)
#
# What this does NOT do (see docs/promotion-pipeline.md's non-goals):
#   - No dbProfile capture. up.sh has no "what did I seed this local DB from"
#     tracker for a running database, so a captured manifest carries no
#     dbProfile — the same seed profile the cloud sandbox was already using
#     stays in place. Add a local marker file if this is needed later.
#   - No push, no PR, no dispatch. This only walks disk and reads git state —
#     apply-local.sh does the actual switchboard calls.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

err(){ printf "\033[31m✗\033[0m %s\n" "$*" >&2; }
warn(){ printf "\033[33m⚠\033[0m %s\n" "$*" >&2; }
say(){ printf "\033[34m→\033[0m %s\n" "$*" >&2; }

usage(){
  echo "Usage: $0 [-o <output-file>] [--allow-dirty]" >&2
  exit 1
}

OUT=""
ALLOW_DIRTY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--output) OUT="${2:-}"; [[ -z "$OUT" ]] && { err "-o needs a file path"; exit 1; }; shift 2 ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    -h|--help) usage ;;
    *) err "unknown arg '$1'"; usage ;;
  esac
done

command -v jq >/dev/null 2>&1 || { err "capture-local.sh needs jq (brew/apt install jq)"; exit 1; }

DEV=${DEV:-$HOME/dev}
SOA=${SOA:-$DEV/soa}
ROSTERING=${ROSTERING:-$DEV/rostering}
PROGRAM_HUB=${PROGRAM_HUB:-$DEV/program-hub}
SAGA_DASH=${SAGA_DASH:-$DEV/saga-dash}
COACH=${COACH:-$DEV/coach}
SDS=${SDS:-$DEV/student-data-system}
QBOARD=${QBOARD:-$DEV/qboard}
RTSM=${RTSM:-$DEV/rtsm}

# repo dir → services it hosts (the reverse of up.sh's svc_repo_dir; git SHAs
# are per-repo, so every service sharing a repo shares one captured sha).
# soa is deliberately excluded — it's shared infra/packages, not a
# switchboard-registered service with a variant of its own.
REPO_SERVICES=(
  "$ROSTERING:iam-api,sis-api"
  "$PROGRAM_HUB:programs-api,scheduling-api,sessions-api,content-api"
  "$SAGA_DASH:saga-dash"
  "$COACH:coach-api,coach-web"
  "$SDS:ads-adm-api"
  "$QBOARD:connect-api,connect-web"
  "$RTSM:rtsm-api"
)

HOSTNAME=$(hostname 2>/dev/null || echo "unknown-host")
SERVICES_JSON="{}"
_had_dirty=0
_had_missing=0

for kv in "${REPO_SERVICES[@]}"; do
  repo_dir="${kv%%:*}"
  svc_csv="${kv#*:}"

  if [[ ! -e "$repo_dir/.git" ]]; then
    warn "'$repo_dir' not cloned — skipping ${svc_csv//,/, }"
    _had_missing=1
    continue
  fi

  if [[ -n "$(git -C "$repo_dir" status --porcelain 2>/dev/null)" ]]; then
    _had_dirty=1
    if [[ "$ALLOW_DIRTY" -ne 1 ]]; then
      err "'$repo_dir' has uncommitted changes — refusing to capture (commit/stash, or pass --allow-dirty to capture HEAD anyway)"
      exit 1
    fi
    warn "'$repo_dir' has uncommitted changes — capturing HEAD only (working-tree diffs are NOT included)"
  fi

  sha=$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null)
  if [[ -z "$sha" ]]; then
    err "'$repo_dir' — 'git rev-parse HEAD' failed (detached/unborn?)"
    exit 1
  fi

  IFS=',' read -r -a svcs <<<"$svc_csv"
  for svc in "${svcs[@]}"; do
    SERVICES_JSON=$(jq -c --arg svc "$svc" --arg sha "$sha" \
      '. + {($svc): {mode: "local-source", sha: $sha}}' <<<"$SERVICES_JSON")
  done
  say "$repo_dir → ${svc_csv//,/, } @ ${sha:0:12}"
done

SVC_COUNT=$(jq 'length' <<<"$SERVICES_JSON")
if [[ "$SVC_COUNT" -eq 0 ]]; then
  err "no services captured — check DEV/\$REPO env vars and that repos are cloned"
  exit 1
fi

WORKSPACE_JSON=$(jq -nc \
  --arg host "$HOSTNAME" \
  --argjson services "$SERVICES_JSON" \
  '{
    version: 1,
    capturedFrom: ("local:" + $host),
    services: $services
  }')

if [[ -n "$OUT" ]]; then
  echo "$WORKSPACE_JSON" | jq . > "$OUT"
  say "wrote $SVC_COUNT service(s) to $OUT"
else
  echo "$WORKSPACE_JSON" | jq .
fi

if [[ "$_had_missing" -eq 1 ]]; then
  warn "one or more sibling repos were missing — captured manifest is a partial mesh snapshot"
fi
if [[ "$_had_dirty" -eq 1 && "$ALLOW_DIRTY" -eq 1 ]]; then
  warn "one or more repos had uncommitted changes not reflected in the captured sha — commit before applying if that matters"
fi

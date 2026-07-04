#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# apply-local.sh — push a captured local workspace.json to a live cloud
# sandbox composition, so the full mesh can validate a change in progress.
#
# Local → cloud direction of the bidirectional config capture/replay tooling
# (see capture-local.sh for the other half of this pair). Consumes a
# workspace.json produced by capture-local.sh and, for every service it names
# that is also a component of the target composition:
#
#   1. re-registers that service's ALREADY-BOUND variant with the captured
#      sha (PUT /api/v1/services/{service}/variants/{variantId} — same call
#      CI's switchboard-register step makes), then
#   2. calls the composition update endpoint (POST
#      /api/v1/compositions/{name}/update) to redeploy, which re-dispatches
#      each selected component's create workflow using the variant's now-
#      current registration.
#
# Two calls, in that order, are load-bearing: /update does NOT accept a sha —
# it only re-dispatches whatever gitRef is presently registered for the
# component's existing variantId (routes.py's _resolve_updatable_variant).
# There is no endpoint that repoints a composition component to a DIFFERENT
# variantId or an unregistered sha — apply only works against a sha that has
# already passed through CI registration for the variantId the composition
# already has bound (in practice: any main-reachable, already-deployed commit).
#
# Usage:
#   ./apply-local.sh <composition-name> <workspace.json>
#   ./apply-local.sh sandbox-foo my-workspace.json
#   ./apply-local.sh sandbox-foo my-workspace.json --db-profile keep
#
# Env:
#   SWITCHBOARD_API_URL       default: https://switchboard-api.wootdev.com
#   SWITCHBOARD_CI_API_KEY    bearer token for the registry PUT (registry-side
#                             secret — see auth.py: registry routes and
#                             sandbox/composition routes validate against
#                             DIFFERENT secrets, this is NOT the same key as
#                             SANDBOX_CI_API_KEY below)
#   SANDBOX_CI_API_KEY        bearer token for the composition /update call
#                             (sandbox-side secret)
#
# What this does NOT do:
#   - Does not create a new sandbox/composition — only updates an EXISTING
#     one's already-bound components. Use the switchboard UI/API to create
#     one first.
#   - Does not touch services the workspace.json doesn't mention, or services
#     the composition doesn't already have as a component — those are left
#     exactly as they are (no implicit reset-all-data fan-out beyond what the
#     composition's OWN update endpoint does for its non-selected components).
#   - Does not compute/guess an artifactRef — it reuses the captured sha
#     verbatim as both gitRef and artifactRef's tag component (`{service}:{sha}`,
#     matching the ECR tagging convention register.py's callers use); if a
#     sha was never built/pushed to ECR under that tag, the redeploy will fail
#     at the workflow level, not here.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

err(){ printf "\033[31m✗\033[0m %s\n" "$*" >&2; }
warn(){ printf "\033[33m⚠\033[0m %s\n" "$*" >&2; }
say(){ printf "\033[34m→\033[0m %s\n" "$*" >&2; }

usage(){
  echo "Usage: $0 <composition-name> <workspace.json> [--db-profile <profile>]" >&2
  exit 1
}

[[ $# -ge 2 ]] || usage
COMPOSITION=$1; WORKSPACE=$2; shift 2
DB_PROFILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --db-profile) DB_PROFILE="${2:-}"; [[ -z "$DB_PROFILE" ]] && { err "--db-profile needs a value"; exit 1; }; shift 2 ;;
    *) err "unknown arg '$1'"; usage ;;
  esac
done

command -v jq >/dev/null 2>&1 || { err "apply-local.sh needs jq"; exit 1; }
command -v curl >/dev/null 2>&1 || { err "apply-local.sh needs curl"; exit 1; }
[[ -r "$WORKSPACE" ]] || { err "cannot read '$WORKSPACE'"; exit 1; }

API_URL=${SWITCHBOARD_API_URL:-https://switchboard-api.wootdev.com}

# ── preflight: both bearer secrets present (two DIFFERENT keys — see auth.py) ──
if [[ -z "${SWITCHBOARD_CI_API_KEY:-}" ]]; then
  err "SWITCHBOARD_CI_API_KEY not set (registry PUT auth — this is the switchboard/ci-api-key secret, NOT the sandbox one)"
  exit 1
fi
if [[ -z "${SANDBOX_CI_API_KEY:-}" ]]; then
  err "SANDBOX_CI_API_KEY not set (composition /update auth — this is the sandbox-api/ci-api-key secret, NOT the registry one)"
  exit 1
fi

# ── fetch the composition's current service→variantId map ──────────────────
say "fetching composition '$COMPOSITION' from $API_URL…"
COMP_RESP="$(mktemp)"; trap 'rm -f "$COMP_RESP"' EXIT
comp_status=$(curl -sS -o "$COMP_RESP" -w '%{http_code}' "$API_URL/api/v1/compositions/$COMPOSITION")
if [[ "$comp_status" == "404" ]]; then
  err "composition '$COMPOSITION' not found — apply only updates an EXISTING composition, it does not create one"
  exit 1
fi
if [[ "$comp_status" != "200" ]]; then
  err "GET /compositions/$COMPOSITION failed (HTTP $comp_status): $(cat "$COMP_RESP")"
  exit 1
fi
COMP_SERVICES=$(jq -c '.services // {}' "$COMP_RESP")

# ── intersect the workspace manifest with the composition's actual components ──
WS_SERVICES=$(jq -c '.services // {}' "$WORKSPACE")
SELECTED=$(jq -nc --argjson comp "$COMP_SERVICES" --argjson ws "$WS_SERVICES" \
  '[$ws | keys[] | select(. as $s | $comp | has($s))]')
SEL_COUNT=$(jq 'length' <<<"$SELECTED")
if [[ "$SEL_COUNT" -eq 0 ]]; then
  err "no overlap between '$WORKSPACE' services and '$COMPOSITION' components — nothing to apply"
  exit 1
fi

SKIPPED=$(jq -nc --argjson comp "$COMP_SERVICES" --argjson ws "$WS_SERVICES" \
  '[$ws | keys[] | select(. as $s | ($comp | has($s)) | not)]')
if [[ "$(jq 'length' <<<"$SKIPPED")" -gt 0 ]]; then
  while IFS= read -r svc; do
    warn "'$svc' is in the workspace manifest but not a component of '$COMPOSITION' — skipping"
  done < <(jq -r '.[]' <<<"$SKIPPED")
fi

# ── step 1: re-register each selected service's bound variant with its sha ──
_reg_failed=()
while IFS= read -r svc; do
  variant_id=$(jq -r --arg s "$svc" '.[$s]' <<<"$COMP_SERVICES")
  sha=$(jq -r --arg s "$svc" '.services[$s].sha // empty' "$WORKSPACE")
  if [[ -z "$sha" ]]; then
    warn "'$svc' has no sha in the workspace manifest — skipping (nothing to re-register)"
    continue
  fi

  say "registering $svc/$variant_id @ ${sha:0:12}…"
  REG_PAYLOAD=$(jq -nc --arg gitRef "$sha" --arg artifactRef "$svc:$sha" \
    '{gitRef: $gitRef, artifactRef: $artifactRef, registeredBy: "apply-local"}')
  reg_resp="$(mktemp)"
  reg_status=$(curl -sS -o "$reg_resp" -w '%{http_code}' \
    -X PUT "$API_URL/api/v1/services/$svc/variants/$variant_id" \
    -H "Authorization: Bearer $SWITCHBOARD_CI_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$REG_PAYLOAD")
  if [[ "$reg_status" -lt 200 || "$reg_status" -ge 300 ]]; then
    err "registering $svc/$variant_id failed (HTTP $reg_status): $(cat "$reg_resp")"
    _reg_failed+=("$svc")
  fi
  rm -f "$reg_resp"
done < <(jq -r '.[]' <<<"$SELECTED")

if [[ ${#_reg_failed[@]} -gt 0 ]]; then
  err "re-registration failed for: ${_reg_failed[*]} — aborting before dispatching an update with stale registrations"
  exit 1
fi

# ── step 2: update the composition, redeploying every successfully-registered service ──
UPDATE_SERVICES=$(jq -nc --argjson sel "$SELECTED" --argjson ws "$WS_SERVICES" \
  '[$sel[] | select(. as $s | $ws[$s].sha != null and $ws[$s].sha != "")]')
if [[ "$(jq 'length' <<<"$UPDATE_SERVICES")" -eq 0 ]]; then
  err "no service had a sha to apply — nothing to update"
  exit 1
fi

DB_PROFILES_JSON="{}"
if [[ -n "$DB_PROFILE" ]]; then
  DB_PROFILES_JSON=$(jq -nc --argjson svcs "$UPDATE_SERVICES" --arg p "$DB_PROFILE" \
    '[$svcs[] | {key:., value:$p}] | from_entries')
fi

UPDATE_PAYLOAD=$(jq -nc --argjson services "$UPDATE_SERVICES" --argjson dbProfiles "$DB_PROFILES_JSON" \
  '{services: $services, dbProfiles: $dbProfiles, resetAllData: false}')

say "dispatching update for $(jq -r '. | join(", ")' <<<"$UPDATE_SERVICES") on '$COMPOSITION'…"
UPD_RESP="$(mktemp)"
upd_status=$(curl -sS -o "$UPD_RESP" -w '%{http_code}' \
  -X POST "$API_URL/api/v1/compositions/$COMPOSITION/update" \
  -H "Authorization: Bearer $SANDBOX_CI_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$UPDATE_PAYLOAD")
if [[ "$upd_status" -lt 200 || "$upd_status" -ge 300 ]]; then
  err "POST /compositions/$COMPOSITION/update failed (HTTP $upd_status): $(cat "$UPD_RESP")"
  rm -f "$UPD_RESP"
  exit 1
fi

say "update dispatched — status: $(jq -r '.status' "$UPD_RESP")"
jq -r '.components[] | "  \(.service // "?"): \(.status // "?")"' "$UPD_RESP" 2>/dev/null || true
rm -f "$UPD_RESP"

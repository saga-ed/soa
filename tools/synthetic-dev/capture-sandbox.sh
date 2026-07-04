#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# capture-sandbox.sh — snapshot a live cloud sandbox into a workspace.json.
#
# Cloud → local direction of the bidirectional config capture/replay tooling:
# reads the dev-platform control plane's queryState for a sandbox identifier,
# and emits a workspace.json (up.sh --workspace <file>'s input format) with one
# local-source row per service, each pinned to the exact git sha and DB seed
# profile that sandbox is running — so `./up.sh --workspace <file>` reproduces
# it locally instead of "whatever's on main right now."
#
# Usage:
#   ./capture-sandbox.sh <sandbox-name>              → prints workspace.json to stdout
#   ./capture-sandbox.sh <sandbox-name> -o out.json   → writes to out.json
#   ./capture-sandbox.sh pr-42                        → any queryState identifier works
#                                                        (pr-N, sandbox-<name>, main...),
#                                                        not just sandbox- ones
#
# Env:
#   CONTROL_PLANE_FUNCTION   Lambda function name (default: dev-platform-control-plane-dev)
#   AWS_PROFILE              defaults to 'saga-dev' (Observer tier — queryState is read-only)
#
# What this does NOT do (see docs/promotion-pipeline.md's non-goals):
#   - No AWS SSO / gh auth setup — preflight below fails fast with the fix, not
#     a raw 403.
#   - No secrets, no `pnpm install`, no clone-if-missing — this only produces a
#     manifest; `./up.sh --workspace` does the actual repo/DB work.
#   - Only services queryState actually reports (kind=ecr with a serviceName
#     attr) are captured. A sandbox riding on a service the ledger hasn't
#     ingested yet (rare — the ingest loop runs every 15m) is silently absent
#     from the output, not an error — the same "shadow, not authoritative"
#     posture the ledger has everywhere else.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

err(){ printf "\033[31m✗\033[0m %s\n" "$*" >&2; }
warn(){ printf "\033[33m⚠\033[0m %s\n" "$*" >&2; }
say(){ printf "\033[34m→\033[0m %s\n" "$*" >&2; }

usage(){
  echo "Usage: $0 <identifier> [-o <output-file>]" >&2
  echo "  identifier: a queryState identifier — sandbox-<name>, pr-<N>, main, ..." >&2
  exit 1
}

[[ $# -ge 1 ]] || usage
IDENTIFIER=$1; shift
OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--output) OUT="${2:-}"; [[ -z "$OUT" ]] && { err "-o needs a file path"; exit 1; }; shift 2 ;;
    *) err "unknown arg '$1'"; usage ;;
  esac
done

CONTROL_PLANE_FUNCTION=${CONTROL_PLANE_FUNCTION:-dev-platform-control-plane-dev}
export AWS_PROFILE=${AWS_PROFILE:-saga-dev}

# ── preflight: fail fast with the fix, not a raw 403 mid-invoke ─────────────
command -v jq >/dev/null 2>&1 || { err "capture-sandbox.sh needs jq (brew/apt install jq)"; exit 1; }
command -v aws >/dev/null 2>&1 || { err "capture-sandbox.sh needs the aws CLI"; exit 1; }
if ! aws sts get-caller-identity >/dev/null 2>&1; then
  err "AWS auth failed for profile '$AWS_PROFILE' — run: aws sso login --profile $AWS_PROFILE"
  exit 1
fi

# ── invoke queryState via the control plane's direct-invoke action ─────────
# (the HTTP route is ALB-OIDC-gated at the edge for browser/operator use;
# query-state is the IAM-gated CLI-friendly path — see handler.py.)
say "querying $CONTROL_PLANE_FUNCTION for '$IDENTIFIER' (profile: $AWS_PROFILE)…"
RESP_FILE="$(mktemp)"; trap 'rm -f "$RESP_FILE"' EXIT
PAYLOAD=$(jq -nc --arg id "$IDENTIFIER" '{action: "query-state", identifier: $id}')
if ! aws lambda invoke \
      --function-name "$CONTROL_PLANE_FUNCTION" \
      --cli-binary-format raw-in-base64-out \
      --payload "$PAYLOAD" \
      "$RESP_FILE" >/dev/null 2>&1; then
  err "lambda invoke failed — check function name ('$CONTROL_PLANE_FUNCTION') and IAM permissions for profile '$AWS_PROFILE'"
  exit 1
fi
if jq -e '.errorMessage' "$RESP_FILE" >/dev/null 2>&1; then
  err "control plane returned an error: $(jq -r '.errorMessage' "$RESP_FILE")"
  exit 1
fi
if jq -e '. == null' "$RESP_FILE" >/dev/null 2>&1; then
  err "no environment found for identifier '$IDENTIFIER' — check the name (queryState returns 404/null for unknown identifiers)"
  exit 1
fi

# ── fold resources[] into one row per service ───────────────────────────────
# ecr resources carry serviceName + gitRef in attrs (join key + sha source —
# NOT artifactRef, whose tag is only "usually" the sha by CI convention).
# db / sandbox-composition resources carry dbProfile, keyed by resourceId
# (== serviceName for both those sources — see ledger_ingest.py).
SERVICES_JSON=$(jq -c '
  (.resources // [])
  | (
      [ .[] | select(.kind == "ecr") | {
          service: (.attrs.serviceName // ""),
          sha: (.attrs.gitRef // ""),
          artifactRef: (.attrs.artifactRef // "")
        } | select(.service != "") ]
    ) as $ecrs
  | (
      [ .[] | select(.kind == "db") | {
          service: .resourceId,
          dbProfile: (.attrs.dbProfile // "")
        } | select(.dbProfile != "") ]
    ) as $dbs
  | ($ecrs | map(.service)) as $svcs
  | [ $svcs[] as $s
      | { key: $s,
          value: (
            ($ecrs | map(select(.service == $s)) | .[0] // {}) as $e
            | ($dbs | map(select(.service == $s)) | .[0] // {}) as $d
            | { mode: "local-source" }
            + (if ($e.sha // "") != "" then {sha: $e.sha} else {} end)
            + (if ($d.dbProfile // "") != "" then {dbProfile: $d.dbProfile} else {} end)
          )
        }
    ]
  | from_entries
' "$RESP_FILE")

SVC_COUNT=$(jq 'length' <<<"$SERVICES_JSON")
if [[ "$SVC_COUNT" -eq 0 ]]; then
  warn "'$IDENTIFIER' has no ecr resources with a serviceName attr — nothing to capture. (An older ledger ingest cycle, or a sandbox riding on a not-yet-ingested service?)"
fi

WORKSPACE_JSON=$(jq -nc \
  --arg identifier "$IDENTIFIER" \
  --argjson services "$SERVICES_JSON" \
  '{
    version: 1,
    capturedFrom: ("sandbox:" + $identifier),
    services: $services
  }')

if [[ -n "$OUT" ]]; then
  echo "$WORKSPACE_JSON" | jq . > "$OUT"
  say "wrote $SVC_COUNT service(s) to $OUT"
else
  echo "$WORKSPACE_JSON" | jq .
fi

# services present in resources but missing a gitRef — flag so a captured
# manifest with a mode:"local-source" row and no `sha` isn't a silent surprise
# (up.sh treats a missing sha as "leave the repo as-is", not an error).
MISSING_SHA=$(jq -r 'to_entries[] | select(.value.sha == null) | .key' <<<"$SERVICES_JSON")
if [[ -n "$MISSING_SHA" ]]; then
  while IFS= read -r svc; do
    warn "'$svc' has no gitRef on its ecr resource — captured without a sha pin (up.sh will leave that repo on whatever's checked out)"
  done <<<"$MISSING_SHA"
fi

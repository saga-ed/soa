#!/usr/bin/env bash
#
# fetch-rum-config.sh
#
# Reads RUM SSM params and writes them to $GITHUB_ENV so the subsequent Build
# step picks them up via vite.config.ts loadEnv.
#
# Copy this script into your repo's .github/scripts/ directory and call it
# from the build job, between AWS credential setup and `pnpm build`:
#
#   - name: Fetch RUM config from SSM
#     env:
#       SSM_PREFIX: /myapp/rum
#       RUM_ENV_DEFAULT: dev
#     run: ./.github/scripts/fetch-rum-config.sh
#
# Inputs (env):
#   SSM_PREFIX        e.g. /dash/rum, /janus/rum, /qboard/rum
#   RUM_ENV_DEFAULT   Fallback for ${SSM_PREFIX}/env when ParameterNotFound (dev|prod)
#   GITHUB_SHA        Used to derive VITE_APP_VERSION (short SHA)
#   GITHUB_ENV        GitHub-provided
#
# Outputs (to $GITHUB_ENV):
#   VITE_DD_RUM_APPLICATION_ID
#   VITE_DD_RUM_CLIENT_TOKEN
#   VITE_DD_ENV
#   VITE_APP_VERSION
#
# ParameterNotFound is tolerated on NON-prod — initRum() no-ops on empty
# applicationId, so a freshly bootstrapped account that hasn't seeded SSM yet
# still ships. Other AWS errors (AccessDenied, Throttling, wrong region) fail
# the build loudly so an IAM regression can't silently ship prod without RUM.
#
# When RUM_ENV_DEFAULT=prod the script additionally HARD-FAILS the build if
# application-id or client-token is empty, or if either is present but
# malformed (see the shape check below). Rationale: a green prod build that
# ships no RUM is indistinguishable from a healthy one until someone notices
# the dashboard is empty — which took weeks in saga-dash.
#
# Heredoc-delimiter form prevents a multi-line SSM value from injecting extra
# entries into $GITHUB_ENV.

set -euo pipefail

: "${SSM_PREFIX:?SSM_PREFIX is required (e.g. /dash/rum)}"
: "${RUM_ENV_DEFAULT:?RUM_ENV_DEFAULT is required (dev|prod)}"

get_ssm() {
  local name="$1" default="$2" value err_log
  err_log=$(mktemp)
  if value=$(aws ssm get-parameter --name "$name" --query Parameter.Value --output text 2>"$err_log"); then
    rm -f "$err_log"
    printf '%s' "$value"
    return 0
  fi
  if grep -q "ParameterNotFound" "$err_log"; then
    rm -f "$err_log"
    printf '%s' "$default"
    return 0
  fi
  cat "$err_log" >&2
  if grep -q "AccessDenied" "$err_log"; then
    echo "::error::AccessDenied fetching SSM $name — check the deploy role's ssm:GetParameter policy"
  elif grep -q "ThrottlingException" "$err_log"; then
    echo "::error::SSM throttled fetching $name — re-run the workflow"
  else
    echo "::error::Unexpected error fetching SSM parameter $name (see log above)"
  fi
  rm -f "$err_log"
  return 1
}

APP_ID=$(get_ssm "${SSM_PREFIX}/application-id" "") || exit 1
TOKEN=$(get_ssm "${SSM_PREFIX}/client-token" "") || exit 1
ENV_TAG=$(get_ssm "${SSM_PREFIX}/env" "$RUM_ENV_DEFAULT") || exit 1

if [ -n "$TOKEN" ]; then
  echo "::add-mask::$TOKEN"
fi

# Shape-check both values before they reach the build. Presence alone is not
# enough: a malformed value sails past an is-it-empty test, the build goes green,
# and initRum() then calls Datadog with a credential it will reject — prod stays
# dark in exactly the way this script is supposed to prevent, but harder to spot.
# This is not hypothetical: saga-dash's /dash/rum/client-token was once seeded as
# the literal placeholder "<same as dev>" copied out of a runbook.
#
# Datadog formats: application-id is a UUID; client tokens are "pub" + 32 hex.
# Only enforced on prod builds — non-prod may legitimately be unset/partial.
if [ "$RUM_ENV_DEFAULT" = "prod" ]; then
  if [ -n "$APP_ID" ] && ! printf '%s' "$APP_ID" | grep -qiE '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'; then
    echo "::error::${SSM_PREFIX}/application-id is not a valid UUID (got ${#APP_ID} chars starting '${APP_ID:0:4}'). Check the value in the production account, region ${AWS_REGION:-us-west-2}."
    exit 1
  fi
  if [ -n "$TOKEN" ] && ! printf '%s' "$TOKEN" | grep -qE '^pub[0-9a-f]{32}$'; then
    # Never echo the token itself — report only its shape.
    echo "::error::${SSM_PREFIX}/client-token is not a valid Datadog client token (expected 'pub' + 32 hex chars, got ${#TOKEN} chars starting '${TOKEN:0:3}'). A placeholder was likely copied verbatim from a runbook."
    exit 1
  fi
fi

{
  echo "VITE_DD_RUM_APPLICATION_ID<<EOF_RUM"
  echo "$APP_ID"
  echo "EOF_RUM"
  echo "VITE_DD_RUM_CLIENT_TOKEN<<EOF_RUM"
  echo "$TOKEN"
  echo "EOF_RUM"
  echo "VITE_DD_ENV<<EOF_RUM"
  echo "$ENV_TAG"
  echo "EOF_RUM"
  echo "VITE_APP_VERSION=${GITHUB_SHA:0:7}"
} >> "$GITHUB_ENV"

if [ -z "$APP_ID" ] || [ -z "$TOKEN" ]; then
  # On a production build a missing application-id OR client-token means the
  # deploy ships with no observability at all — initRum() no-ops and prod goes
  # dark silently. That is exactly how saga-dash's prod ran unmonitored for
  # weeks: ParameterNotFound is tolerated above, so the build stayed green.
  # Non-prod keeps warning (local/preview builds legitimately run without RUM).
  missing=""
  [ -z "$APP_ID" ] && missing="${SSM_PREFIX}/application-id"
  [ -z "$TOKEN" ] && missing="${missing:+$missing and }${SSM_PREFIX}/client-token"
  if [ "$RUM_ENV_DEFAULT" = "prod" ]; then
    echo "::error::Datadog RUM is not configured for a PRODUCTION build ($missing empty or missing). Seed it in the production account (region ${AWS_REGION:-us-west-2})."
    exit 1
  fi
  echo "::warning::Datadog RUM not configured ($missing empty) — initRum() will no-op in this build"
fi

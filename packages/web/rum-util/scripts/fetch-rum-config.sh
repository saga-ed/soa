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
# ParameterNotFound is tolerated — initRum() no-ops on empty applicationId, so
# a freshly bootstrapped account that hasn't seeded SSM yet still ships. Other
# AWS errors (AccessDenied, Throttling, wrong region) fail the build loudly so
# an IAM regression can't silently ship prod without RUM.
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

if [ -z "$APP_ID" ]; then
  echo "::warning::Datadog RUM not configured (${SSM_PREFIX}/application-id empty) — initRum() will no-op in this build"
fi

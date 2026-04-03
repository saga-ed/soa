#!/bin/bash
# CodeArtifact login for @saga-ed packages.
# Always writes to ~/.npmrc (user-level) via --location=user.
# Safe to run from any directory — never creates project-level tokens.
#
# Usage: bash scripts/co-login.sh
# Skip in CI: CI=true bash scripts/co-login.sh

set -e

# CI provides its own auth
[[ -n "$CI" || -n "$GITHUB_ACTIONS" ]] && exit 0

# Deployed tarball (not in a git repo) — skip
git rev-parse --is-inside-work-tree &>/dev/null || exit 0

DOMAIN="saga"
OWNER="531314149529"
REPO="saga_js"
REGISTRY="//saga-${OWNER}.d.codeartifact.us-west-2.amazonaws.com/npm/${REPO}/"

if ! command -v aws &>/dev/null; then
    echo "ERROR: AWS CLI not found. Install: https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html" >&2
    exit 1
fi

TOKEN=$(aws codeartifact get-authorization-token \
    --domain "$DOMAIN" --domain-owner "$OWNER" \
    --query authorizationToken --output text 2>/dev/null) || {
    echo "ERROR: Failed to get CodeArtifact token. Run 'aws sso login' first." >&2
    exit 1
}

npm config set --location=user "${REGISTRY}:_authToken" "$TOKEN"

# Ensure scoped registry is set (idempotent)
npm config set --location=user "@saga-ed:registry" "https:${REGISTRY}"

# Remove any stale global registry override
if grep -q "^registry=.*codeartifact" ~/.npmrc 2>/dev/null; then
    sed -i '/^registry=.*codeartifact/d' ~/.npmrc
fi

# Remove any stale @hipponot registry pointing to CodeArtifact
if grep -q "^@hipponot:registry=.*codeartifact" ~/.npmrc 2>/dev/null; then
    sed -i '/@hipponot:registry=.*codeartifact/d' ~/.npmrc
fi

echo "✅ CodeArtifact token refreshed (12h expiry)"

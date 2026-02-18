#!/usr/bin/env bash
#
# Validate a JWT access token against the local mock-oauth2-server's JWKS endpoint.
# Useful for verifying that token validation logic works correctly.
#
# Usage:
#   ./scripts/validate-token.sh <access_token>
#   ./scripts/validate-token.sh $(./scripts/get-token.sh 2>/dev/null | grep -A1 "Access Token:" | tail -1)
#
# Prerequisites:
#   - docker compose up -d  (from infra/service-auth/local/)
#   - curl and jq installed

set -euo pipefail

OAUTH_BASE_URL="${OAUTH_BASE_URL:-http://localhost:8090}"
ISSUER_ID="${ISSUER_ID:-service-auth}"
JWKS_ENDPOINT="${OAUTH_BASE_URL}/${ISSUER_ID}/jwks"
OPENID_CONFIG_ENDPOINT="${OAUTH_BASE_URL}/${ISSUER_ID}/.well-known/openid-configuration"

TOKEN="${1:-}"

if [ -z "${TOKEN}" ]; then
    echo "Usage: $0 <access_token>"
    echo ""
    echo "Tip: pipe from get-token.sh:"
    echo '  ./scripts/validate-token.sh $(./scripts/get-token.sh 2>/dev/null | grep -A1 "Access Token:" | tail -1)'
    exit 1
fi

echo "--- Token Validation ---"
echo ""

# Decode and display the token
HEADER=$(echo "${TOKEN}" | cut -d'.' -f1 | base64 -d 2>/dev/null)
PAYLOAD=$(echo "${TOKEN}" | cut -d'.' -f2 | base64 -d 2>/dev/null)

echo "Header:"
echo "${HEADER}" | jq . 2>/dev/null || echo "${HEADER}"
echo ""

echo "Payload:"
echo "${PAYLOAD}" | jq . 2>/dev/null || echo "${PAYLOAD}"
echo ""

# Extract key ID from header
KID=$(echo "${HEADER}" | jq -r '.kid' 2>/dev/null)
echo "Key ID (kid): ${KID}"

# Fetch JWKS
echo ""
echo "--- JWKS Verification ---"
echo "Fetching keys from: ${JWKS_ENDPOINT}"
JWKS=$(curl -s "${JWKS_ENDPOINT}")
MATCHING_KEY=$(echo "${JWKS}" | jq --arg kid "${KID}" '.keys[] | select(.kid == $kid)' 2>/dev/null)

if [ -n "${MATCHING_KEY}" ]; then
    echo "Matching key found in JWKS"
    echo "${MATCHING_KEY}" | jq '{kid, kty, alg, use}' 2>/dev/null
else
    echo "WARNING: No matching key found for kid=${KID}"
fi

# Check expiration
EXP=$(echo "${PAYLOAD}" | jq -r '.exp' 2>/dev/null)
NOW=$(date +%s)
if [ "${EXP}" -gt "${NOW}" ] 2>/dev/null; then
    REMAINING=$((EXP - NOW))
    echo ""
    echo "Token is VALID (expires in ${REMAINING}s)"
else
    echo ""
    echo "Token is EXPIRED"
fi

# Show issuer
ISS=$(echo "${PAYLOAD}" | jq -r '.iss' 2>/dev/null)
echo "Issuer: ${ISS}"

# Show scopes
SCOPE=$(echo "${PAYLOAD}" | jq -r '.scope // empty' 2>/dev/null)
if [ -n "${SCOPE}" ]; then
    echo "Scopes: ${SCOPE}"
fi

echo ""
echo "--- OpenID Configuration ---"
echo "Full config: ${OPENID_CONFIG_ENDPOINT}"
curl -s "${OPENID_CONFIG_ENDPOINT}" | jq '{issuer, token_endpoint, jwks_uri, scopes_supported, grant_types_supported}' 2>/dev/null

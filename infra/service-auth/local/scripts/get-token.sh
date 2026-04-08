#!/usr/bin/env bash
#
# Fetch an OAuth2 access token from the local mock-oauth2-server using
# the client_credentials grant — the same flow partners use in production.
#
# Usage:
#   ./scripts/get-token.sh                    # default: api/read api/write scopes
#   ./scripts/get-token.sh "api/read"         # specific scope
#   ./scripts/get-token.sh "api/webhooks.send" # webhook scope
#
# Prerequisites:
#   - docker compose up -d  (from infra/service-auth/local/)
#   - curl and jq installed

set -euo pipefail

OAUTH_BASE_URL="${OAUTH_BASE_URL:-http://localhost:8090}"
ISSUER_ID="${ISSUER_ID:-service-auth}"
TOKEN_ENDPOINT="${OAUTH_BASE_URL}/${ISSUER_ID}/oauth2/token"

# Any client_id/secret works with mock-oauth2-server — it accepts all credentials.
# These values mirror what you'd get from the Cognito ExamplePartnerAppClient.
CLIENT_ID="${CLIENT_ID:-example-partner}"
CLIENT_SECRET="${CLIENT_SECRET:-example-partner-secret}"

SCOPES="${1:-api/read api/write}"

echo "--- Service Auth: Local Token Request ---"
echo "Endpoint: ${TOKEN_ENDPOINT}"
echo "Client:   ${CLIENT_ID}"
echo "Scopes:   ${SCOPES}"
echo ""

RESPONSE=$(curl -s -X POST "${TOKEN_ENDPOINT}" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -u "${CLIENT_ID}:${CLIENT_SECRET}" \
    -d "grant_type=client_credentials&scope=${SCOPES}")

if ! echo "${RESPONSE}" | jq -e '.access_token' > /dev/null 2>&1; then
    echo "ERROR: Failed to obtain token"
    echo "${RESPONSE}" | jq . 2>/dev/null || echo "${RESPONSE}"
    exit 1
fi

ACCESS_TOKEN=$(echo "${RESPONSE}" | jq -r '.access_token')
EXPIRES_IN=$(echo "${RESPONSE}" | jq -r '.expires_in')

echo "Token obtained successfully (expires in ${EXPIRES_IN}s)"
echo ""
echo "Access Token:"
echo "${ACCESS_TOKEN}"
echo ""
echo "--- Decoded JWT Header ---"
echo "${ACCESS_TOKEN}" | cut -d'.' -f1 | base64 -d 2>/dev/null | jq . 2>/dev/null || echo "(install jq for decoded output)"
echo ""
echo "--- Decoded JWT Payload ---"
echo "${ACCESS_TOKEN}" | cut -d'.' -f2 | base64 -d 2>/dev/null | jq . 2>/dev/null || echo "(install jq for decoded output)"
echo ""
echo "--- Usage Examples ---"
echo ""
echo "# Call a protected endpoint:"
echo "curl -H 'Authorization: Bearer ${ACCESS_TOKEN}' http://localhost:3000/api/resources"
echo ""
echo "# Send a webhook:"
echo "curl -X POST -H 'Authorization: Bearer ${ACCESS_TOKEN}' -H 'Content-Type: application/json' \\"
echo "  -d '{\"event\": \"test\"}' http://localhost:3000/webhooks/events"
echo ""
echo "# Export as env var:"
echo "export SERVICE_AUTH_TOKEN='${ACCESS_TOKEN}'"

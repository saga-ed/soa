#!/bin/bash
# morning-auth.sh - Daily JumpCloud + AWS SSO authentication
# Run this first thing in the morning to refresh all credentials

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}                    Morning Authentication                      ${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"

# Check if AWS SSO session is still valid
check_aws_session() {
    # Try to get caller identity - if it works, session is valid
    if aws sts get-caller-identity --profile default &>/dev/null; then
        return 0
    fi
    return 1
}

# Get SSO token expiration time
get_sso_expiry() {
    local cache_dir="$HOME/.aws/sso/cache"
    local latest_token=$(ls -t "$cache_dir"/*.json 2>/dev/null | head -1)

    if [[ -n "$latest_token" ]]; then
        local expires_at=$(python3 -c "import json; print(json.load(open('$latest_token')).get('expiresAt', 'unknown'))" 2>/dev/null)
        if [[ "$expires_at" != "unknown" && "$expires_at" != "None" ]]; then
            echo "$expires_at"
            return 0
        fi
    fi
    echo "unknown"
}

echo ""
echo -e "${YELLOW}Step 1: Checking current AWS SSO session...${NC}"

if check_aws_session; then
    expiry=$(get_sso_expiry)
    echo -e "${GREEN}✓ AWS SSO session is still valid${NC}"
    echo -e "  Expires: ${expiry}"
    echo ""
    read -p "Do you want to refresh anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${GREEN}Using existing session. You're all set!${NC}"
        exit 0
    fi
fi

echo ""
echo -e "${YELLOW}Step 2: Logging out of JumpCloud...${NC}"
xdg-open "https://console.jumpcloud.com/logout" 2>/dev/null &
sleep 2

echo -e "${YELLOW}Step 3: Opening JumpCloud login...${NC}"
echo -e "  ${BLUE}→ Complete the JumpCloud login + MFA in your browser${NC}"
echo ""
xdg-open "https://console.jumpcloud.com/login" 2>/dev/null &

echo -e "${YELLOW}Waiting for you to complete JumpCloud authentication...${NC}"
echo -e "Press ${GREEN}Enter${NC} when you've logged in to JumpCloud"
read -r

echo ""
echo -e "${YELLOW}Step 4: Running AWS SSO login...${NC}"
echo ""

# Run AWS SSO login - this will open browser for the final auth step
if aws sso login --profile default; then
    echo ""
    echo -e "${GREEN}✓ AWS SSO login successful${NC}"

    # Verify and show account info
    echo ""
    echo -e "${BLUE}Verifying credentials...${NC}"
    aws sts get-caller-identity --profile default

    # Step 5: Refresh CodeArtifact tokens
    echo ""
    echo -e "${YELLOW}Step 5: Refreshing AWS CodeArtifact tokens...${NC}"

    echo -e "${BLUE}  Fetching CodeArtifact authorization token...${NC}"
    CODEARTIFACT_AUTH_TOKEN=$(aws codeartifact get-authorization-token \
      --domain saga --domain-owner 531314149529 \
      --query authorizationToken --output text 2>&1)

    if [ $? -eq 0 ]; then
      # Only saga_js is active (saga_nimbee and saga_soa are retired)
      npm config set //saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/:_authToken="$CODEARTIFACT_AUTH_TOKEN"
      echo -e "${GREEN}  ✓ saga_js auth token configured${NC}"

      # Safety: remove any stale default registry pointing to CodeArtifact
      if grep -q "^registry=.*codeartifact" ~/.npmrc 2>/dev/null; then
        echo -e "${YELLOW}  Removing stale CodeArtifact default registry from ~/.npmrc${NC}"
        sed -i '/^registry=.*codeartifact/d' ~/.npmrc
      fi
    else
      echo -e "${RED}  ✗ Failed to get CodeArtifact token${NC}"
    fi

    echo -e "${GREEN}  CodeArtifact token valid for 12 hours${NC}"

    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}✓ Authentication complete!${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"

    expiry=$(get_sso_expiry)
    echo ""
    echo -e "${GREEN}AWS SSO session expires: ${expiry}${NC}"
else
    echo ""
    echo -e "${RED}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${RED}✗ AWS SSO login failed${NC}"
    echo -e "${RED}═══════════════════════════════════════════════════════════════${NC}"
    exit 1
fi

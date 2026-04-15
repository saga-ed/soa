#!/bin/bash
# morning-auth.sh - Daily JumpCloud + AWS SSO authentication
# Run this first thing in the morning to refresh all credentials

set -e

VERSION="1.1.0"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

SKIP_AWS_CLI_UPDATE=0
for arg in "$@"; do
    case "$arg" in
        --no-update)
            SKIP_AWS_CLI_UPDATE=1
            ;;
        -h|--help)
            cat <<EOF
morning-auth.sh v${VERSION} - Daily JumpCloud + AWS SSO authentication

Usage: $(basename "$0") [--no-update] [-h|--help]

  --no-update   Skip AWS CLI version check (useful when GitHub API is unreachable)
  -h, --help    Show this help
EOF
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg" >&2
            exit 2
            ;;
    esac
done

echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}             Morning Authentication  v${VERSION}                    ${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"

print_aws_cli_update_steps() {
    cat <<'EOF'

To update AWS CLI v2 on Ubuntu 24.04:

  curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "/tmp/awscliv2.zip"
  unzip -o /tmp/awscliv2.zip -d /tmp
  sudo /tmp/aws/install --update

Reference: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html

EOF
}

auto_update_aws_cli() {
    local tmp
    tmp=$(mktemp -d)

    echo -e "${BLUE}  Downloading latest AWS CLI...${NC}"
    if ! curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "$tmp/awscliv2.zip"; then
        echo -e "${RED}  ✗ Download failed${NC}"
        rm -rf "$tmp"
        return 1
    fi

    echo -e "${BLUE}  Extracting...${NC}"
    if ! unzip -qo "$tmp/awscliv2.zip" -d "$tmp"; then
        echo -e "${RED}  ✗ Extraction failed (is 'unzip' installed? 'sudo apt install unzip')${NC}"
        rm -rf "$tmp"
        return 1
    fi

    echo -e "${BLUE}  Installing (requires sudo)...${NC}"
    if sudo "$tmp/aws/install" --update; then
        echo -e "${GREEN}  ✓ AWS CLI updated to $(aws --version 2>&1 | awk '{print $1}')${NC}"
        rm -rf "$tmp"
        return 0
    else
        echo -e "${RED}  ✗ Install failed${NC}"
        rm -rf "$tmp"
        return 1
    fi
}

check_aws_cli_version() {
    if ! command -v aws &>/dev/null; then
        echo -e "${RED}✗ AWS CLI is not installed${NC}"
        print_aws_cli_update_steps
        exit 1
    fi

    local installed
    installed=$(aws --version 2>&1 | awk '{print $1}' | cut -d/ -f2)
    echo -e "  Installed: aws-cli/${installed}"

    local latest
    latest=$(curl -fsSL --max-time 5 "https://api.github.com/repos/aws/aws-cli/tags?per_page=20" 2>/dev/null \
        | python3 -c "
import sys, json, re
try:
    tags = [t['name'] for t in json.load(sys.stdin)]
    v2 = [t for t in tags if re.fullmatch(r'2\.\d+\.\d+', t)]
    v2.sort(key=lambda s: tuple(int(p) for p in s.split('.')), reverse=True)
    print(v2[0] if v2 else '')
except Exception:
    print('')
" 2>/dev/null || echo "")

    if [[ -z "$latest" ]]; then
        echo -e "  ${YELLOW}Could not fetch latest version (offline or rate-limited); skipping check${NC}"
        return 0
    fi

    echo -e "  Latest:    aws-cli/${latest}"

    if [[ "$installed" == "$latest" ]]; then
        echo -e "${GREEN}✓ AWS CLI is up to date${NC}"
        return 0
    fi

    echo -e "${YELLOW}⚠ A newer AWS CLI is available: ${installed} → ${latest}${NC}"
    read -p "Auto-update now? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        if ! auto_update_aws_cli; then
            print_aws_cli_update_steps
        fi
    else
        print_aws_cli_update_steps
    fi
}

echo ""
if [[ $SKIP_AWS_CLI_UPDATE -eq 1 ]]; then
    echo -e "${YELLOW}Skipping AWS CLI version check (--no-update)${NC}"
else
    echo -e "${YELLOW}Checking AWS CLI version...${NC}"
    check_aws_cli_version
fi

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

    if bash "$(dirname "$0")/co-login.sh"; then
      echo -e "${GREEN}  ✓ CodeArtifact configured (12h expiry)${NC}"
    else
      echo -e "${RED}  ✗ Failed to get CodeArtifact token${NC}"
    fi

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

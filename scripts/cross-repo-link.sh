#!/bin/bash
#
# Cross-Repo SOA Package Linking Tool
#
# A unified script to toggle between local SOA package linking and published versions.
# This script lives in SOA and can be used by any consuming repo (thrive, coach, etc.)
#
# Usage from consuming repo:
#   ../soa/scripts/cross-repo-link.sh [on|off|status]
#
# Or symlink/alias in consuming repo:
#   ./scripts/soa-link.sh -> ../../soa/scripts/cross-repo-link.sh
#
# Configuration:
#   Each consuming repo must have a `soa-link.json` config file specifying which
#   packages to link and their paths in SOA.
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_error() { echo -e "${RED}❌ $1${NC}"; }

# Determine script and repo locations
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOA_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# The consuming repo is the current working directory (or passed as argument)
CONSUMER_ROOT="${CONSUMER_ROOT:-$(pwd)}"
CONFIG_FILE="$CONSUMER_ROOT/soa-link.json"
PACKAGE_JSON="$CONSUMER_ROOT/package.json"

# Check prerequisites
if ! command -v jq &> /dev/null; then
    log_error "jq is required but not installed."
    echo "Install with: sudo apt-get install jq"
    exit 1
fi

if [ ! -f "$PACKAGE_JSON" ]; then
    log_error "Not in a valid project directory: $CONSUMER_ROOT"
    echo "package.json not found"
    exit 1
fi

# Create default config if it doesn't exist
create_default_config() {
    log_info "Creating default soa-link.json configuration..."

    cat > "$CONFIG_FILE" << 'EOF'
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "_comment": "SOA package linking configuration",
  "soaPath": "../soa",
  "packages": {
    "@saga-ed/soa-api-core": "packages/node/api-core",
    "@saga-ed/soa-api-util": "packages/node/api-util",
    "@saga-ed/soa-config": "packages/core/config",
    "@saga-ed/soa-db": "packages/node/db",
    "@saga-ed/soa-logger": "packages/node/logger",
    "@saga-ed/soa-rabbitmq": "packages/node/rabbitmq",
    "@saga-ed/soa-pubsub-server": "packages/node/pubsub-server",
    "@saga-ed/soa-pubsub-client": "packages/node/pubsub-client",
    "@saga-ed/soa-redis-core": "packages/node/redis-core",
    "@saga-ed/soa-aws-util": "packages/node/aws-util",
    "@saga-ed/soa-test-util": "packages/node/test-util"
  }
}
EOF

    log_success "Created $CONFIG_FILE"
    log_info "Edit this file to specify which packages your project uses"
}

# Get packages used by this project from its package.json files
detect_used_packages() {
    local packages_in_config=$(jq -r '.packages | keys[]' "$CONFIG_FILE" 2>/dev/null)
    local used_packages=()

    # Search all package.json files in the project for @saga-ed packages
    while IFS= read -r pkg_json; do
        for pkg in $packages_in_config; do
            if grep -q "\"$pkg\"" "$pkg_json" 2>/dev/null; then
                if [[ ! " ${used_packages[*]} " =~ " ${pkg} " ]]; then
                    used_packages+=("$pkg")
                fi
            fi
        done
    done < <(find "$CONSUMER_ROOT" -name "package.json" -not -path "*/node_modules/*" 2>/dev/null)

    echo "${used_packages[@]}"
}

# Check if local linking is currently active
is_linked() {
    local first_pkg=$(jq -r '.packages | keys[0]' "$CONFIG_FILE" 2>/dev/null)
    if [ -n "$first_pkg" ] && [ "$first_pkg" != "null" ]; then
        jq -e ".pnpm.overrides[\"$first_pkg\"]" "$PACKAGE_JSON" &> /dev/null
    else
        return 1
    fi
}

# Get current status
get_status() {
    if is_linked; then
        echo "linked"
    else
        echo "registry"
    fi
}

# Enable local SOA linking
enable_link() {
    if is_linked; then
        log_info "Local SOA linking is already enabled"
        return 0
    fi

    # Get SOA path from config
    local soa_path=$(jq -r '.soaPath // "../soa"' "$CONFIG_FILE")
    local soa_abs_path="$CONSUMER_ROOT/$soa_path"

    # Verify SOA exists
    if [ ! -d "$soa_abs_path/packages" ]; then
        log_error "SOA packages not found at: $soa_abs_path/packages"
        log_error "Update soa-link.json with correct soaPath"
        exit 1
    fi

    log_success "Found SOA at: $soa_abs_path"
    log_info "Enabling local SOA package linking..."

    # Build overrides object from config
    local overrides=$(jq -r --arg soa "$soa_path" '
        .packages | to_entries | map({
            key: .key,
            value: ("link:" + $soa + "/" + .value)
        }) | from_entries
    ' "$CONFIG_FILE")

    # Merge overrides into package.json
    jq --argjson new_overrides "$overrides" '
        .pnpm.overrides = ((.pnpm.overrides // {}) + $new_overrides)
    ' "$PACKAGE_JSON" > "$PACKAGE_JSON.tmp"
    mv "$PACKAGE_JSON.tmp" "$PACKAGE_JSON"

    log_info "Running pnpm install..."
    cd "$CONSUMER_ROOT"
    pnpm install

    echo ""
    log_success "Local SOA linking ENABLED"
    echo ""
    log_warning "Do not commit package.json with local overrides!"
    echo "Run '$0 off' before committing."
}

# Disable local SOA linking
disable_link() {
    if ! is_linked; then
        log_info "Local SOA linking is already disabled"
        return 0
    fi

    log_info "Disabling local SOA package linking..."

    # Get all package names from config and remove them from overrides
    local packages=$(jq -r '.packages | keys[]' "$CONFIG_FILE")

    local jq_filter="."
    for pkg in $packages; do
        jq_filter="$jq_filter | del(.pnpm.overrides[\"$pkg\"])"
    done

    jq "$jq_filter" "$PACKAGE_JSON" > "$PACKAGE_JSON.tmp"
    mv "$PACKAGE_JSON.tmp" "$PACKAGE_JSON"

    log_info "Running pnpm install..."
    cd "$CONSUMER_ROOT"
    pnpm install

    echo ""
    log_success "Local SOA linking DISABLED"
    echo "Packages will be fetched from registry"
}

# Show usage
show_usage() {
    echo "Usage: $0 [on|off|status|init]"
    echo ""
    echo "Cross-repo SOA package linking tool"
    echo ""
    echo "Commands:"
    echo "  on      Enable local SOA package linking"
    echo "  off     Disable local SOA package linking"
    echo "  status  Show current state"
    echo "  init    Create default soa-link.json config"
    echo "  (none)  Toggle current state"
    echo ""
    echo "Configuration:"
    echo "  Create a soa-link.json file in your project root:"
    echo ""
    echo "  {"
    echo "    \"soaPath\": \"../soa\","
    echo "    \"packages\": {"
    echo "      \"@saga-ed/soa-api-core\": \"packages/node/api-core\","
    echo "      \"@saga-ed/soa-logger\": \"packages/node/logger\""
    echo "    }"
    echo "  }"
    echo ""
    echo "Environment variables:"
    echo "  CONSUMER_ROOT  Project directory (default: current directory)"
}

# Main
case "${1:-toggle}" in
    on|enable|link)
        if [ ! -f "$CONFIG_FILE" ]; then
            log_error "Configuration file not found: $CONFIG_FILE"
            log_info "Run '$0 init' to create a default configuration"
            exit 1
        fi
        enable_link
        ;;
    off|disable|unlink)
        if [ ! -f "$CONFIG_FILE" ]; then
            log_error "Configuration file not found: $CONFIG_FILE"
            exit 1
        fi
        disable_link
        ;;
    status)
        if [ ! -f "$CONFIG_FILE" ]; then
            echo "SOA linking: NOT CONFIGURED"
            echo "Run '$0 init' to create configuration"
            exit 0
        fi
        status=$(get_status)
        if [ "$status" = "linked" ]; then
            echo "SOA packages: LINKED (local)"
            soa_path=$(jq -r '.soaPath // "../soa"' "$CONFIG_FILE")
            echo "Source: $CONSUMER_ROOT/$soa_path/packages/*"
            echo ""
            echo "Linked packages:"
            jq -r '.packages | to_entries[] | "  \(.key) -> \(.value)"' "$CONFIG_FILE"
        else
            echo "SOA packages: REGISTRY"
        fi
        ;;
    init)
        create_default_config
        ;;
    toggle)
        if [ ! -f "$CONFIG_FILE" ]; then
            log_error "Configuration file not found: $CONFIG_FILE"
            log_info "Run '$0 init' to create a default configuration"
            exit 1
        fi
        if is_linked; then
            disable_link
        else
            enable_link
        fi
        ;;
    -h|--help|help)
        show_usage
        ;;
    *)
        log_error "Unknown command: $1"
        show_usage
        exit 1
        ;;
esac

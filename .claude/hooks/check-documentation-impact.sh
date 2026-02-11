#!/bin/bash
# check-documentation-impact.sh
# PostToolUse hook to check if file changes affect documentation
#
# This hook runs after Edit/Write operations and checks if:
# 1. A CLAUDE.md file was modified (should validate tokens)
# 2. A new directory was created that might need CLAUDE.md
# 3. Files were changed that might affect documented patterns

set -euo pipefail

# Read hook input from stdin
INPUT=$(cat)

# Extract file path from tool input
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [ -z "$FILE_PATH" ]; then
    exit 0
fi

# Check if this is a CLAUDE.md file
if [[ "$FILE_PATH" == *"/CLAUDE.md" ]] || [[ "$FILE_PATH" == "CLAUDE.md" ]]; then
    # Run token validation
    SCRIPT_DIR="$(dirname "$0")/../skills/documentation-system/scripts"
    if [ -f "$SCRIPT_DIR/validate_tokens.sh" ]; then
        RESULT=$("$SCRIPT_DIR/validate_tokens.sh" "$FILE_PATH" 2>&1 || true)
        if echo "$RESULT" | grep -q "OVER BUDGET"; then
            echo '{"systemMessage": "CLAUDE.md file is over token budget. Consider extracting content to docs/ files."}'
            exit 0
        fi
    fi
    echo '{"additionalContext": "CLAUDE.md modified - token budget validated."}'
    exit 0
fi

# Check if this is a new project directory that might need CLAUDE.md
DIR_PATH=$(dirname "$FILE_PATH")
if [[ "$DIR_PATH" == *"/apps/"* ]] || [[ "$DIR_PATH" == *"/packages/"* ]]; then
    if [[ ! -f "$DIR_PATH/CLAUDE.md" ]]; then
        # Check if this looks like a project root (has package.json, tsconfig.json, or docker-compose.yml)
        if [ -f "$DIR_PATH/package.json" ] || [ -f "$DIR_PATH/tsconfig.json" ] || [ -f "$DIR_PATH/docker-compose.yml" ]; then
            echo '{"additionalContext": "Note: This directory has build config but no CLAUDE.md. Consider creating one using the documentation-system skill."}'
            exit 0
        fi
    fi
fi

# Check if this affects documented patterns (package.json, tsconfig.json in key locations)
if [[ "$FILE_PATH" == *"/package.json" ]] || [[ "$FILE_PATH" == *"/tsconfig.json" ]]; then
    # Check if there's a CLAUDE.md in this directory
    if [ -f "$DIR_PATH/CLAUDE.md" ]; then
        echo '{"additionalContext": "Build configuration changed. Verify CLAUDE.md Command Discovery section is still accurate."}'
        exit 0
    fi
fi

# No documentation action needed
exit 0

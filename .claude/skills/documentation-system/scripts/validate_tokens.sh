#!/bin/bash

# Token validation script for CLAUDE.md files
# Usage: ./validate_tokens.sh [file_path]
#        ./validate_tokens.sh (validates all CLAUDE.md files in repo)
#        ./validate_tokens.sh --ci (CI-friendly output, no colors)

set -euo pipefail

# Check for CI mode
CI_MODE=false
if [ "${1:-}" = "--ci" ]; then
    CI_MODE=true
    shift
fi

# Colors for output (disabled in CI mode)
if [ "$CI_MODE" = true ]; then
    GREEN=''
    YELLOW=''
    RED=''
    NC=''
else
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    RED='\033[0;31m'
    NC='\033[0m' # No Color
fi

# Token budget thresholds
STRICT_BUDGET=800
MAX_BUDGET=1000

# Find repo root
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo ".")

echo "=== CLAUDE.md Token Budget Validation ==="
echo ""
echo "Target: ~500 tokens (375 words)"
echo "Acceptable: ≤800 tokens (strict) or ≤1000 tokens (maximum)"
echo ""

validate_file() {
    local file=$1

    if [ ! -f "$file" ]; then
        echo -e "${RED}Error: File not found: $file${NC}"
        return 1
    fi

    # Count words
    words=$(wc -w < "$file")

    # Calculate tokens (1 token ≈ 0.75 words, so multiply by 4/3)
    tokens=$((words * 4 / 3))

    # Get relative path for cleaner output
    if [[ "$file" == "$REPO_ROOT"* ]]; then
        relpath="${file#$REPO_ROOT/}"
    else
        relpath="$file"
    fi

    # Determine status
    if [ $tokens -le $STRICT_BUDGET ]; then
        status="${GREEN}✅ GOOD${NC}"
        emoji="✅"
        show_in_ci=false
    elif [ $tokens -le $MAX_BUDGET ]; then
        status="${YELLOW}🟡 ACCEPTABLE${NC}"
        emoji="🟡"
        show_in_ci=true
    else
        status="${RED}⚠️  OVER BUDGET${NC}"
        emoji="⚠️"
        show_in_ci=true
    fi

    # Print result (compact in CI mode - only show files needing attention)
    if [ "$CI_MODE" = false ] || [ "$show_in_ci" = true ]; then
        printf "%-65s %4d words (~%4d tokens) " "$relpath" "$words" "$tokens"
        echo -e "$status"
    fi

    # Return exit code based on status
    if [ $tokens -gt $MAX_BUDGET ]; then
        return 1
    else
        return 0
    fi
}

# Main execution
if [ $# -eq 0 ]; then
    # No arguments - validate all CLAUDE.md files
    cd "$REPO_ROOT"

    files=$(find . -name "CLAUDE.md" -not -path "*/node_modules/*" -not -path "*/.git/*" | sort)

    if [ -z "$files" ]; then
        echo "No CLAUDE.md files found in repository."
        exit 0
    fi

    total=0
    over_budget=0
    acceptable=0
    good=0

    while IFS= read -r file; do
        if validate_file "$file"; then
            words=$(wc -w < "$file")
            tokens=$((words * 4 / 3))
            if [ $tokens -le $STRICT_BUDGET ]; then
                good=$((good + 1))
            else
                acceptable=$((acceptable + 1))
            fi
        else
            over_budget=$((over_budget + 1))
        fi
        total=$((total + 1))
    done <<< "$files"

    echo ""
    echo "=== Summary ==="
    echo "Total files: $total"
    echo -e "${GREEN}✅ Within strict budget (≤800): $good${NC}"
    echo -e "${YELLOW}🟡 Acceptable (801-1000): $acceptable${NC}"
    echo -e "${RED}⚠️  Over budget (>1000): $over_budget${NC}"
    echo ""

    if [ $over_budget -gt 0 ]; then
        echo -e "${RED}Action required: $over_budget file(s) exceed the 1000 token maximum.${NC}"
        echo "See guides/token-validation.md for refactoring guidance."
        exit 1
    elif [ $acceptable -gt 0 ]; then
        echo -e "${YELLOW}Consider refactoring: $acceptable file(s) could be more concise.${NC}"
        exit 0
    else
        echo -e "${GREEN}All files within strict token budget! ✅${NC}"
        exit 0
    fi

elif [ $# -eq 1 ]; then
    # Single file argument
    file=$1

    if validate_file "$file"; then
        words=$(wc -w < "$file")
        tokens=$((words * 4 / 3))

        echo ""
        if [ $tokens -le $STRICT_BUDGET ]; then
            echo -e "${GREEN}✅ File is within strict budget${NC}"
        else
            echo -e "${YELLOW}🟡 File is acceptable but could be more concise${NC}"
            echo "Consider extracting details to docs/ directory"
            echo "See: .claude/skills/documentation-system/guides/token-validation.md"
        fi
        exit 0
    else
        words=$(wc -w < "$file")
        tokens=$((words * 4 / 3))

        echo ""
        echo -e "${RED}⚠️  File exceeds maximum token budget${NC}"
        echo ""
        echo "Current: $tokens tokens ($words words)"
        echo "Maximum: $MAX_BUDGET tokens"
        echo "Over by: $((tokens - MAX_BUDGET)) tokens"
        echo ""
        echo "Refactoring required. See:"
        echo "  .claude/skills/documentation-system/guides/token-validation.md"
        echo ""
        echo "Quick tips:"
        echo "  1. Extract detailed content to docs/ directory"
        echo "  2. Use bullet points instead of paragraphs"
        echo "  3. Link to full documentation instead of duplicating"
        echo "  4. Show only 3-5 key commands, not all commands"
        echo "  5. Keep code examples concise"
        exit 1
    fi
else
    echo "Usage: $0 [--ci] [file_path]"
    echo ""
    echo "Options:"
    echo "  --ci                        # CI-friendly output (no colors)"
    echo ""
    echo "Examples:"
    echo "  $0                          # Validate all CLAUDE.md files"
    echo "  $0 /path/to/CLAUDE.md       # Validate specific file"
    echo "  $0 --ci                     # Validate all files (CI mode)"
    exit 1
fi

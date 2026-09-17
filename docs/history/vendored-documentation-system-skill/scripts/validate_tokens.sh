#!/bin/bash
# Validate token budget for CLAUDE.md files
# Target: ~500 tokens (~375 words)
# Maximum: 1000 tokens (~750 words)

set -e

TARGET_TOKENS=500
MAX_TOKENS=1000
WORDS_PER_TOKEN=0.75  # Rough estimate: 1 token ≈ 0.75 words

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

count_tokens() {
    local file="$1"
    local words=$(wc -w < "$file")
    # Rough token estimate: words * 4/3
    echo $(( (words * 4 + 2) / 3 ))
}

check_file() {
    local file="$1"
    local tokens=$(count_tokens "$file")
    local words=$(wc -w < "$file")

    if [ "$tokens" -gt "$MAX_TOKENS" ]; then
        echo -e "${RED}FAIL${NC} $file: ~$tokens tokens ($words words) - OVER MAXIMUM"
        return 1
    elif [ "$tokens" -gt "$TARGET_TOKENS" ]; then
        echo -e "${YELLOW}WARN${NC} $file: ~$tokens tokens ($words words) - over target"
        return 0
    else
        echo -e "${GREEN}PASS${NC} $file: ~$tokens tokens ($words words)"
        return 0
    fi
}

main() {
    local search_dir="${1:-.}"
    local failed=0
    local warned=0
    local passed=0

    echo "Validating CLAUDE.md token budgets..."
    echo "Target: ~$TARGET_TOKENS tokens, Maximum: $MAX_TOKENS tokens"
    echo ""

    while IFS= read -r file; do
        if check_file "$file"; then
            ((passed++))
        else
            ((failed++))
        fi
    done < <(find "$search_dir" -name "CLAUDE.md" -type f)

    echo ""
    echo "Summary: $passed passed, $failed failed"

    if [ "$failed" -gt 0 ]; then
        exit 1
    fi
}

main "$@"

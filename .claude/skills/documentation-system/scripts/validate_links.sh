#!/bin/bash

# Link validation script for CLAUDE.md files
# Validates internal markdown links and file references
# Usage: ./validate_links.sh

set -euo pipefail

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Find repo root
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo ".")

echo "=== Documentation Link Validation ==="
echo ""

total_files=0
total_links=0
broken_links=0
files_with_broken_links=0

# Function to validate links in a file
validate_file_links() {
    local file=$1
    local file_dir=$(dirname "$file")
    local has_broken=false
    local file_broken_count=0

    # Get relative path for cleaner output
    if [[ "$file" == "$REPO_ROOT"* ]]; then
        relpath="${file#$REPO_ROOT/}"
    else
        relpath="$file"
    fi

    # Extract markdown links: [text](url)
    # This regex matches [...](...) patterns
    local links=$(grep -oP '\[.*?\]\(\K[^)]+' "$file" 2>/dev/null || true)

    if [ -z "$links" ]; then
        return 0
    fi

    while IFS= read -r link; do
        # Skip external links (http://, https://, mailto:, etc.)
        if [[ "$link" =~ ^https?:// ]] || [[ "$link" =~ ^mailto: ]] || [[ "$link" =~ ^# ]]; then
            continue
        fi

        total_links=$((total_links + 1))

        # Handle relative paths
        # Remove any anchor fragments (#section)
        link_path="${link%%#*}"

        # Skip empty paths (anchor-only links like #section)
        if [ -z "$link_path" ]; then
            continue
        fi

        # Resolve relative path
        if [[ "$link_path" == /* ]]; then
            # Absolute path from repo root
            target="$REPO_ROOT$link_path"
        else
            # Relative path from current file
            target="$file_dir/$link_path"
        fi

        # Normalize path (resolve .. and .)
        target=$(cd "$file_dir" && realpath -m "$link_path" 2>/dev/null || echo "$target")

        # Check if target exists
        if [ ! -e "$target" ]; then
            if [ "$has_broken" = false ]; then
                echo -e "${RED}✗ $relpath${NC}"
                has_broken=true
            fi
            echo -e "  ${RED}Broken link: $link${NC}"
            echo -e "  ${YELLOW}  Expected: $target${NC}"
            broken_links=$((broken_links + 1))
            file_broken_count=$((file_broken_count + 1))
        fi
    done <<< "$links"

    if [ "$has_broken" = true ]; then
        files_with_broken_links=$((files_with_broken_links + 1))
        return 1
    else
        echo -e "${GREEN}✓ $relpath${NC} (all links valid)"
        return 0
    fi
}

# Find all CLAUDE.md and SKILL.md files
cd "$REPO_ROOT"
files=$(find . \( -name "CLAUDE.md" -o -name "SKILL.md" \) \
    -not -path "*/node_modules/*" \
    -not -path "*/.git/*" \
    -not -path "*/vendor/*" \
    | sort)

if [ -z "$files" ]; then
    echo "No CLAUDE.md or SKILL.md files found."
    exit 0
fi

echo "Validating links in documentation files..."
echo ""

# Validate each file
while IFS= read -r file; do
    total_files=$((total_files + 1))
    validate_file_links "$file" || true
done <<< "$files"

# Summary
echo ""
echo "=== Summary ==="
echo "Files checked: $total_files"
echo "Links validated: $total_links"

if [ $broken_links -gt 0 ]; then
    echo -e "${RED}✗ Broken links: $broken_links (in $files_with_broken_links file(s))${NC}"
    echo ""
    echo "Action required: Fix broken links before merging."
    echo "Tips:"
    echo "  - Check file paths are relative to the current file's directory"
    echo "  - Verify linked files exist in the repository"
    echo "  - Use ../ to navigate up directory levels"
    echo "  - Parent context links should point to ../CLAUDE.md or ../../CLAUDE.md"
    exit 1
else
    echo -e "${GREEN}✓ All links valid${NC}"
    exit 0
fi

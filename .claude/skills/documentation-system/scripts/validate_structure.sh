#!/bin/bash

# Structure validation script for CLAUDE.md and SKILL.md files
# Validates adherence to hierarchical documentation standards
# Usage: ./validate_structure.sh

set -euo pipefail

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Find repo root
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo ".")

echo "=== Documentation Structure Validation ==="
echo ""

total_files=0
total_issues=0
files_with_issues=0

# Function to check if file has required section
has_section() {
    local file=$1
    local section=$2
    grep -q "^## $section" "$file"
}

# Function to check for parent context
check_parent_context() {
    local file=$1

    # Root CLAUDE.md doesn't need parent context
    if [[ "$file" == "$REPO_ROOT/CLAUDE.md" ]]; then
        return 0
    fi

    if grep -q "^\*\*Parent Context:\*\*" "$file"; then
        return 0
    else
        return 1
    fi
}

# Function to check for documentation directive
check_doc_directive() {
    local file=$1

    if grep -q "^\*\*Documentation Directive:\*\*" "$file"; then
        return 0
    else
        return 1
    fi
}

# Function to check for last updated date
check_last_updated() {
    local file=$1

    if grep -q "^\*Target:.*Last updated:" "$file"; then
        return 0
    else
        return 1
    fi
}

# Function to check convention deviations formatting
check_convention_warnings() {
    local file=$1
    local issues=0

    # Check if there are Convention Deviations sections
    if ! has_section "$file" "Convention Deviations"; then
        return 0  # No convention deviations section, that's fine
    fi

    # Extract Convention Deviations section
    local conv_section=$(sed -n '/^## Convention Deviations/,/^## /p' "$file")

    # Check for ⚠️ markers in subsections
    local subsections=$(echo "$conv_section" | grep -c "^\*\*⚠️" || true)

    if [ "$subsections" -eq 0 ]; then
        # Check if section has content but no warnings
        local has_content=$(echo "$conv_section" | grep -c "^-" || true)
        if [ "$has_content" -gt 0 ]; then
            return 1  # Has content but no warning markers
        fi
    fi

    return 0
}

# Function to check SKILL.md specific requirements
validate_skill_file() {
    local file=$1
    local relpath=$2
    local issues=0
    local has_issues=false

    # Check for YAML frontmatter
    if ! head -n 1 "$file" | grep -q "^---$"; then
        if [ "$has_issues" = false ]; then
            echo -e "${RED}✗ $relpath${NC}"
            has_issues=true
        fi
        echo "  ${RED}Missing YAML frontmatter (must start with ---)${NC}"
        ((issues++))
    else
        # Check for required fields in frontmatter
        if ! grep -q "^name:" "$file"; then
            if [ "$has_issues" = false ]; then
                echo -e "${RED}✗ $relpath${NC}"
                has_issues=true
            fi
            echo "  ${RED}Missing 'name:' field in frontmatter${NC}"
            issues=$((issues + 1))
        fi

        if ! grep -q "^description:" "$file"; then
            if [ "$has_issues" = false ]; then
                echo -e "${RED}✗ $relpath${NC}"
                has_issues=true
            fi
            echo "  ${RED}Missing 'description:' field in frontmatter${NC}"
            issues=$((issues + 1))
        fi
    fi

    # Check for README.md in same directory (violates progressive disclosure)
    local skill_dir=$(dirname "$file")
    if [ -f "$skill_dir/README.md" ]; then
        if [ "$has_issues" = false ]; then
            echo -e "${RED}✗ $relpath${NC}"
            has_issues=true
        fi
        echo "  ${YELLOW}Warning: README.md found alongside SKILL.md (violates progressive disclosure)${NC}"
        ((issues++))
    fi

    if [ "$has_issues" = false ]; then
        echo -e "${GREEN}✓ $relpath${NC}"
    fi

    return $issues
}

# Function to validate CLAUDE.md file
validate_claude_file() {
    local file=$1
    local relpath=$2
    local issues=0
    local warnings=0
    local has_issues=false

    # Check for Parent Context (unless root)
    if [[ "$file" != "$REPO_ROOT/CLAUDE.md" ]]; then
        if ! check_parent_context "$file"; then
            if [ "$has_issues" = false ]; then
                echo -e "${RED}✗ $relpath${NC}"
                has_issues=true
            fi
            echo "  ${RED}Missing Parent Context section${NC}"
            issues=$((issues + 1))
        fi
    fi

    # Check for required sections
    local required_sections=("Responsibilities" "Tech Stack" "Command Discovery")
    for section in "${required_sections[@]}"; do
        if ! has_section "$file" "$section"; then
            if [ "$has_issues" = false ]; then
                echo -e "${RED}✗ $relpath${NC}"
                has_issues=true
            fi
            echo "  ${YELLOW}Warning: Missing recommended section '## $section'${NC}"
            warnings=$((warnings + 1))
        fi
    done

    # Check for Documentation Directive
    if ! check_doc_directive "$file"; then
        if [ "$has_issues" = false ]; then
            echo -e "${RED}✗ $relpath${NC}"
            has_issues=true
        fi
        echo "  ${YELLOW}Warning: Missing Documentation Directive${NC}"
        ((warnings++))
    fi

    # Check for Last Updated date
    if ! check_last_updated "$file"; then
        if [ "$has_issues" = false ]; then
            echo -e "${RED}✗ $relpath${NC}"
            has_issues=true
        fi
        echo "  ${YELLOW}Warning: Missing Last Updated date${NC}"
        ((warnings++))
    fi

    # Check Convention Deviations formatting
    if ! check_convention_warnings "$file"; then
        if [ "$has_issues" = false ]; then
            echo -e "${RED}✗ $relpath${NC}"
            has_issues=true
        fi
        echo "  ${YELLOW}Warning: Convention Deviations should use ⚠️ markers${NC}"
        ((warnings++))
    fi

    if [ "$has_issues" = false ]; then
        echo -e "${GREEN}✓ $relpath${NC}"
    fi

    # Count warnings as issues for return code
    return $((issues + warnings))
}

# Find all CLAUDE.md and SKILL.md files
cd "$REPO_ROOT"
claude_files=$(find . -name "CLAUDE.md" \
    -not -path "*/node_modules/*" \
    -not -path "*/.git/*" \
    -not -path "*/vendor/*" \
    | sort)

skill_files=$(find . -name "SKILL.md" \
    -not -path "*/node_modules/*" \
    -not -path "*/.git/*" \
    -not -path "*/vendor/*" \
    | sort)

echo "Validating CLAUDE.md files..."
echo ""

# Validate CLAUDE.md files
if [ -n "$claude_files" ]; then
    while IFS= read -r file; do
        total_files=$((total_files + 1))

        # Get relative path
        if [[ "$file" == "$REPO_ROOT"* ]]; then
            relpath="${file#$REPO_ROOT/}"
        else
            relpath="$file"
        fi

        if ! validate_claude_file "$file" "$relpath"; then
            file_issues=$?
            total_issues=$((total_issues + file_issues))
            files_with_issues=$((files_with_issues + 1))
        fi
    done <<< "$claude_files"
fi

echo ""
echo "Validating SKILL.md files..."
echo ""

# Validate SKILL.md files
if [ -n "$skill_files" ]; then
    while IFS= read -r file; do
        total_files=$((total_files + 1))

        # Get relative path
        if [[ "$file" == "$REPO_ROOT"* ]]; then
            relpath="${file#$REPO_ROOT/}"
        else
            relpath="$file"
        fi

        if ! validate_skill_file "$file" "$relpath"; then
            file_issues=$?
            total_issues=$((total_issues + file_issues))
            files_with_issues=$((files_with_issues + 1))
        fi
    done <<< "$skill_files"
fi

# Summary
echo ""
echo "=== Summary ==="
echo "Files checked: $total_files"

if [ $total_issues -gt 0 ]; then
    echo -e "${RED}✗ Issues found: $total_issues (in $files_with_issues file(s))${NC}"
    echo ""
    echo "Action recommended: Fix structure issues to improve documentation quality."
    echo ""
    echo "Common fixes:"
    echo "  - Add Parent Context: **Parent Context:** Part of [...](...)"
    echo "  - Add Documentation Directive at end of file"
    echo "  - Add Last Updated: *Target: ~500 tokens | Last updated: YYYY-MM-DD*"
    echo "  - Use ⚠️ for Convention Deviations subsections"
    echo "  - Add YAML frontmatter to SKILL.md files"
    echo ""
    echo "See: .claude/skills/documentation-system/ for templates and guides"

    # Exit with warning code (0) for now, but log issues
    # Change to exit 1 to make these hard failures
    exit 0
else
    echo -e "${GREEN}✓ All structure requirements met${NC}"
    exit 0
fi

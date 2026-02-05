#!/bin/bash
set -e

# Quick PR workflow for repos with branch protection on main
# Usage: quick-pr.sh [branch-name] [commit-message]
#   branch-name: optional, defaults to "patch/auto-<timestamp>"
#   commit-message: optional, defaults to "quick patch"

BRANCH_NAME="${1:-patch/auto-$(date +%Y%m%d-%H%M%S)}"
COMMIT_MSG="${2:-quick patch}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Quick PR Workflow${NC}"
echo "=================="

# Check for uncommitted changes
if git diff --quiet && git diff --cached --quiet; then
    echo -e "${RED}No changes to commit${NC}"
    exit 1
fi

# Show what will be committed
echo -e "\n${YELLOW}Changes to be committed:${NC}"
git status --short

# Confirm
echo ""
read -p "Create PR with branch '$BRANCH_NAME'? [Y/n] " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Nn]$ ]]; then
    echo "Aborted"
    exit 0
fi

# Create and switch to new branch
echo -e "\n${GREEN}Creating branch: $BRANCH_NAME${NC}"
git checkout -b "$BRANCH_NAME"

# Stage and commit all changes
echo -e "${GREEN}Committing changes...${NC}"
git add -A
git commit -m "$COMMIT_MSG"

# Push to origin
echo -e "${GREEN}Pushing to origin...${NC}"
git push -u origin "$BRANCH_NAME"

# Create PR
echo -e "${GREEN}Creating PR...${NC}"
PR_URL=$(gh pr create --title "$COMMIT_MSG" --body "Auto-generated PR for quick merge to main" --base main 2>&1)

echo -e "\n${GREEN}Done!${NC}"
echo -e "PR created: ${YELLOW}$PR_URL${NC}"
echo ""
echo "Next steps:"
echo "  1. Approve the PR in GitHub"
echo "  2. Merge the PR"
echo "  3. Run: git checkout main && git pull"

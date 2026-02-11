# Navigation Patterns

This guide explains how to create and maintain navigation links between CLAUDE.md files in the hierarchy.

## Navigation Principles

1. **Every child knows its parent** - Use "Parent Context" section
2. **Every parent lists its children** - Link to subprojects/components
3. **Documentation flows downward** - Root → Domain → Tier → Project → Leaf
4. **Context flows upward** - Leaf understands full hierarchy path

## Link Types

### 1. Parent → Child Links

**Purpose:** Help agents navigate from general to specific

**Location:** In parent CLAUDE.md files

**Pattern:**
```markdown
## [Section describing children]

**Key [Projects|Components|Sectors]:**
- `[child_a]/` - [One-line description] (see [CLAUDE.md](./child_a/CLAUDE.md))
- `[child_b]/` - [One-line description] (see [CLAUDE.md](./child_b/CLAUDE.md))
- `[child_c]/` - [One-line description]
```

**Example (from /edu/js/app/CLAUDE.md):**
```markdown
## Key Applications

| Application | Purpose | Tech | Status |
|-------------|---------|------|--------|
| [saga_api](./saga_api/CLAUDE.md) | Main GraphQL/REST API | Express + Apollo | **Primary** |
| [adm_api](./adm_api/CLAUDE.md) | Attendance API | tRPC + Prisma | Modern |
| [rtps](./rtps/CLAUDE.md) | Real-time presence | Socket.IO | Active |
```

### 2. Child → Parent Links

**Purpose:** Provide context about where this component fits

**Location:** In child CLAUDE.md files, "Parent Context" section

**Pattern:**
```markdown
**Parent Context:** Part of [parent_name](../CLAUDE.md), which [brief parent description].
```

**Example (from saga_api/CLAUDE.md):**
```markdown
**Parent Context:** Part of [JavaScript applications](../CLAUDE.md), which includes all Node.js server applications.
```

**Example (from saga_api/sectors/iam/CLAUDE.md):**
```markdown
**Parent Context:** Part of [saga_api](../../CLAUDE.md), which is a sector-based GraphQL/REST API server.
```

### 3. Links to docs/

**Purpose:** Point to detailed documentation

**Location:** Throughout CLAUDE.md, typically in "Detailed Documentation" section

**Pattern:**
```markdown
For [detailed topic], see [docs/filename.md](./docs/filename.md).
```

**Example:**
```markdown
## Command Discovery

**Quick reference:**
```bash
pnpm build
pnpm test
```

For comprehensive commands, see [docs/development.md](./docs/development.md).
```

### 4. Links to decisions/

**Purpose:** Reference Architecture Decision Records

**Location:** In "Convention Deviations" or "Key Design Decisions" sections

**Pattern:**
```markdown
**Rationale:** See `decisions/NNN-decision-name.md`
```

or

```markdown
## Key Design Decisions

- `decisions/001-[decision].md` - [Brief description]
- `decisions/002-[decision].md` - [Brief description]

Full index: [decisions/README.md](./decisions/README.md)
```

**Example:**
```markdown
**⚠️ This project uses snake_case in TypeScript!**

**Rationale:** See `decisions/001-adopt-snake-case-convention.md`
```

### 5. Sibling References

**Purpose:** Cross-reference related components at same level

**Location:** In "Dependencies" section or contextually where relevant

**Pattern:**
```markdown
## Dependencies

**Internal:**
- Sibling: [component_a](../component_a/CLAUDE.md), [component_b](../component_b/CLAUDE.md)
```

**Example (from saga_api/sectors/observations/CLAUDE.md):**
```markdown
## Dependencies

**Internal:**
- Sibling sectors: IAM (user management), LMS (session data), ARS (event queries)
```

## Path Patterns by Level

### Root → Domain
```markdown
<!-- In / CLAUDE.md -->
**Key Projects:**
- `edu/js/` - JavaScript/TypeScript projects
```

Relative path: `./edu/js/CLAUDE.md` or `edu/js/CLAUDE.md`

### Domain → Tier
```markdown
<!-- In /edu/js/CLAUDE.md -->
**Tiers:**
- `app/` - Applications (see [CLAUDE.md](./app/CLAUDE.md))
- `lib/` - Libraries (see [CLAUDE.md](./lib/CLAUDE.md))
```

Relative path from domain: `./app/CLAUDE.md`

### Tier → Project
```markdown
<!-- In /edu/js/app/CLAUDE.md -->
**Key Applications:**
- `saga_api/` - Main API (see [CLAUDE.md](./saga_api/CLAUDE.md))
```

Relative path from tier: `./saga_api/CLAUDE.md`

### Project → Sub-Project
```markdown
<!-- In saga_api/CLAUDE.md -->
**Sectors:**
- `iam/` - Identity & Access Management (see [CLAUDE.md](./sectors/iam/CLAUDE.md))
```

Relative path from project: `./sectors/iam/CLAUDE.md`

### Child → Parent (any level)
```markdown
<!-- In child CLAUDE.md -->
**Parent Context:** Part of [parent_name](../CLAUDE.md)
```

Always use `../CLAUDE.md` to go up one level.

## Relative vs Absolute Paths

**Use relative paths** for navigation within the hierarchy:
- `./child/CLAUDE.md` (parent to child)
- `../CLAUDE.md` (child to parent)
- `../sibling/CLAUDE.md` (sibling to sibling)

**Use absolute paths from repo root** for cross-hierarchy references:
- `[root docs](../../../../docs/development.md)` when deep in hierarchy
- Or calculate relative: `../../../../../../docs/development.md`

**Prefer shorter, clearer paths:**
- If relative path is very long (`../../../../...`), mention it's at root
- Keep navigation simple

## Common Patterns

### Pattern 1: Hierarchy Path in Parent Context

Show the full path to help agents understand context:

```markdown
**Parent Context:** Part of [saga_api](../../CLAUDE.md) (sector-based API) → [JavaScript applications](../../../../CLAUDE.md) → [nimbee workspace](../../../../../CLAUDE.md)
```

**Simplified (preferred):**
```markdown
**Parent Context:** Part of [saga_api](../../CLAUDE.md), which is a sector-based GraphQL/REST API server.
```

### Pattern 2: Bidirectional Navigation

In parent, list children with links:
```markdown
## Sectors

- [IAM](./sectors/iam/CLAUDE.md) - Identity & Access Management
- [ARS](./sectors/ars/CLAUDE.md) - Audience Response System
```

In each child, link back to parent:
```markdown
**Parent Context:** Part of [saga_api](../../CLAUDE.md)
```

### Pattern 3: Documentation Hub

Create a central docs/README.md as navigation hub:

```markdown
<!-- In docs/README.md -->
# saga_api Documentation

## Quick Navigation

### Getting Started
- [Development Guide](./development.md)
- [Architecture Overview](./architecture.md)

### Reference
- [API Documentation](./api.md)
- [Conventions](./conventions.md)

### Guides
- [Testing](./testing.md)
- [Deployment](./deployment.md)
```

Link to it from CLAUDE.md:
```markdown
## Detailed Documentation

- [All Docs](./docs/README.md) - Complete documentation index
```

## Checking Links

### Manual Check
```bash
# Find all markdown links in a file
grep -o '\[.*\](.*)' CLAUDE.md

# Check if linked files exist
for link in $(grep -o '](\..*\.md)' CLAUDE.md | sed 's/](\.\///; s/)$//'); do
  if [ ! -f "$link" ]; then
    echo "Broken link: $link"
  fi
done
```

### Automated Check

Create a link validation script:
```bash
#!/bin/bash
# validate_links.sh

find . -name "CLAUDE.md" | while read file; do
  dir=$(dirname "$file")
  grep -o '\](\..*\.md)' "$file" | sed 's/](\.\///; s/)$//' | while read link; do
    full_path="$dir/$link"
    if [ ! -f "$full_path" ]; then
      echo "Broken link in $file: $link"
    fi
  done
done
```

## Maintaining Links

### When Creating New Files

1. **Add parent reference** in child's Parent Context
2. **Add child listing** in parent's appropriate section
3. **Validate paths** are correct
4. **Check all links work** before committing

### When Moving Files

1. **Update all parent → child links** in parent CLAUDE.md
2. **Update Parent Context** in child CLAUDE.md
3. **Update sibling references** if any
4. **Update docs/ links** if documentation moved

### When Renaming

1. **Find all references** to old name:
   ```bash
   grep -r "old_name" . --include="*.md"
   ```
2. **Update all links** to use new name
3. **Update all text references** to new name

## Examples of Good Navigation

### Example 1: Root Level
```markdown
# Nimbee Development

## Tech Domains

- [JavaScript/TypeScript](./edu/js/CLAUDE.md) - Node.js applications and libraries
- [Ruby](./edu/ruby/CLAUDE.md) - Ruby applications and gems
```

### Example 2: Domain Level
```markdown
# JavaScript Projects

**Parent Context:** Part of [nimbee workspace](../../CLAUDE.md)

## Structure

- [Applications](./app/CLAUDE.md) - Server applications
- [Libraries](./lib/CLAUDE.md) - Shared libraries
```

### Example 3: Leaf Level
```markdown
# IAM Sector

**Parent Context:** Part of [saga_api](../../CLAUDE.md), which is a sector-based GraphQL/REST API server.

## Detailed Documentation

- [saga_api Architecture](../../docs/architecture.md)
- [saga_api Conventions](../../docs/conventions.md)
```

## Navigation Checklist

When creating or updating CLAUDE.md files:

- [ ] Parent Context section points to correct parent
- [ ] Parent's relevant section lists this child
- [ ] All links use correct relative paths
- [ ] Links to docs/ directory are correct
- [ ] Links to decisions/ directory are correct
- [ ] Sibling references (if any) are correct
- [ ] No broken links
- [ ] Paths are as simple as possible

## Quick Reference: Common Mistakes

Don't:
- Use absolute paths like `/home/user/nimbee/...`
- Break links when moving files without updating
- Forget Parent Context in child files
- Use inconsistent path formats
- Create circular references

Do:
- Use relative paths (`./`, `../`)
- Update all links when restructuring
- Always include Parent Context (except root)
- Be consistent with path formats
- Test links before committing

---

*Good navigation makes the documentation system discoverable and useful.*

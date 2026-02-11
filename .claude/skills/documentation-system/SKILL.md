---
name: documentation-system
description: |
  Maintain the hierarchical CLAUDE.md documentation system for soa.

  AUTO-INVOKE when:
  - Creating/modifying CLAUDE.md files
  - Adding new projects, sectors, or components that need documentation
  - Making architectural changes that affect documented patterns
  - Refactoring code that impacts conventions documented in CLAUDE.md
  - Adding new build commands, dependencies, or workflows
  - Creating Architecture Decision Records (ADRs)
  - After significant code changes to verify documentation accuracy

  ALWAYS validate token budgets after CLAUDE.md edits.
  ALWAYS check for broken links when modifying documentation structure.
---

# Documentation System Skill

> Maintain and extend the hierarchical CLAUDE.md documentation system

## Automatic Triggers

This skill should be invoked automatically when:

| Trigger | Action |
|---------|--------|
| New project/package created | Create CLAUDE.md using appropriate template |
| CLAUDE.md modified | Validate token budget, check links |
| Architecture changed | Update affected CLAUDE.md files |
| Convention added/changed | Document in CLAUDE.md Convention Deviations |
| Build commands changed | Update Command Discovery section |
| Major decision made | Create ADR in decisions/ directory |
| Code refactoring | Verify documentation still accurate |

**After any CLAUDE.md edit, always run:**
```bash
.claude/skills/documentation-system/scripts/validate_tokens.sh
```

## Purpose

This skill helps you create, maintain, and validate the hierarchical CLAUDE.md documentation system throughout the soa repository. Use this skill when:

- Creating new CLAUDE.md files for projects/components
- Updating existing CLAUDE.md files
- Validating token budgets
- Creating Architecture Decision Records (ADRs)
- Maintaining documentation consistency

## Quick Start

**When to use this skill:**
1. Adding a new project that needs documentation
2. Refactoring existing documentation to match the hierarchy
3. Validating all CLAUDE.md files are under token budget
4. Creating an ADR for a major technical decision
5. Unsure how to structure documentation

**Before you start:**
- Read `guides/when-to-document.md` - Understand when documentation is needed
- Check the hierarchy level you're working at (root, category, runtime, project)
- Review existing CLAUDE.md files at similar levels for examples

## Documentation Hierarchy

The soa repository uses a 4-level hierarchy:

```
1. Root (/)                                    - Workspace-wide context
2. Category (/apps/, /packages/)               - Application vs package grouping
3. Runtime (/apps/node/, /apps/web/, /apps/core/, /packages/node/, /packages/core/, /packages/web/) - Runtime/platform tier
4. Project (/apps/node/gql-api/, /packages/node/db/) - Individual application/package
```

**Each level has specific responsibilities and token budgets (target: ~500 tokens, max: 1000).**

## Creating New Documentation

### Step 1: Determine the Level

Identify which level you're documenting:
- **Root**: Only one - workspace overview
- **Category**: Applications vs packages (`apps/`, `packages/`)
- **Runtime**: Runtime/platform tier (`apps/node/`, `apps/web/`, `apps/core/`, `packages/node/`, `packages/core/`, `packages/web/`)
- **Project**: Individual deployable application or package

### Step 2: Use the Appropriate Template

Templates are in `templates/` directory:
- `claude-md-root.md` - Root level
- `claude-md-tier.md` - Category/runtime tier
- `claude-md-project.md` - Individual project
- `claude-md-leaf.md` - Leaf level (most detailed)

**Copy the template and customize:**
```bash
# Example: Creating CLAUDE.md for a new application
cp .claude/skills/documentation-system/templates/claude-md-project.md \
   apps/node/new_app/CLAUDE.md
```

### Step 3: Fill in the Template

All templates have these sections:
- **Title & tagline** - Brief description
- **Responsibilities** - What this level handles
- **Parent Context** - Link to parent (except root)
- **Tech Stack** - Technologies used
- **Command Discovery** - Where to find commands
- **Convention Deviations** - Explicit non-standard patterns
- **Common Workflows** - Typical tasks
- **Documentation Directive** - How to update in future
- **Detailed Documentation** - Links to docs/

### Step 4: Create Supporting Documentation

Create `docs/` directory for detailed content:
```bash
mkdir -p path/to/project/docs
```

Common docs/ files:
- `README.md` - Navigation index
- `architecture.md` - Design and structure
- `development.md` - Build, test, deploy commands
- `conventions.md` - Code style and patterns
- `troubleshooting.md` - Common issues

### Step 5: Validate Token Budget

Run the validation script:
```bash
.claude/skills/documentation-system/scripts/validate_tokens.sh path/to/CLAUDE.md
```

**Target:** ~500 tokens (~375 words)
**Maximum:** 1000 tokens (~750 words)

If over budget:
1. Move detailed content to docs/ files
2. Use bullet points instead of paragraphs
3. Link to detailed docs instead of explaining inline
4. Remove redundant information

See `guides/token-validation.md` for details.

## Creating Architecture Decision Records (ADRs)

When documenting major technical decisions:

### Step 1: Use the ADR Template
```bash
cp .claude/skills/documentation-system/templates/adr-template.md \
   path/to/project/decisions/NNN-decision-name.md
```

### Step 2: Number Sequentially

ADRs are numbered starting from 001:
- `001-first-decision.md`
- `002-second-decision.md`
- etc.

### Step 3: Fill in All Sections

Required sections:
- **Context** - Why this decision is needed
- **Considered Options** - All options evaluated (with pros/cons)
- **Decision** - What was chosen
- **Rationale** - Why this option
- **Consequences** - Impact and trade-offs
- **Implementation Notes** - How to implement (optional)

### Step 4: Update decisions/README.md

Add entry to the index table.

## Maintaining Existing Documentation

See `guides/maintenance.md` for:
- When to update vs create new files
- How to refactor oversized CLAUDE.md files
- Keeping parent/child links in sync
- Updating convention deviations

## Navigation Patterns

See `guides/navigation.md` for:
- Parent -> Child links
- Child -> Parent links (Parent Context)
- Cross-references between siblings
- Links to docs/ and decisions/

## Common Patterns

### Progressive Disclosure

**Problem:** CLAUDE.md file too large (>1000 tokens)

**Solution:**
1. Identify detailed content that can be extracted
2. Create docs/ file for that content
3. Replace with brief summary + link in CLAUDE.md
4. Validate token count

**Example:**
```markdown
<!-- Before (in CLAUDE.md) -->
## Build Commands

### TypeScript Packages
npm run build compiles TypeScript to JavaScript...
[500 words of build detail]

<!-- After (in CLAUDE.md) -->
## Command Discovery

Commands in `package.json` scripts. See `docs/development.md` for details.

**Quick reference:**
```bash
npm run build
npm test
```

<!-- Moved to docs/development.md -->
[Detailed build documentation with all options]
```

### Convention Deviations

Always use warning markers to mark deviations:

```markdown
## Convention Deviations

**This project uses snake_case in TypeScript!**

```typescript
// Correct
const user_id = "123";

// Incorrect
const userId = "123";
```

**Rationale:** See `decisions/001-adopt-snake-case.md`
```

### Documentation Directive

All CLAUDE.md files should guide future updates:

```markdown
## Documentation Directive

**If you discover critical or unconventional information:**
1. Add to this CLAUDE.md (if essential and keeps us under 500 tokens)
2. Or create detailed docs in `./docs/` and link from here
3. For major decisions, create ADRs in `decisions/` directory

**Examples of critical information:**
- [Examples specific to this component]
```

## Files in This Skill

- **SKILL.md** (this file) - Main skill documentation
- **templates/**
  - `claude-md-root.md` - Root level template
  - `claude-md-tier.md` - Tier level template
  - `claude-md-project.md` - Project level template
  - `claude-md-leaf.md` - Leaf level template
  - `adr-template.md` - Architecture Decision Record template
- **guides/**
  - `when-to-document.md` - Decision guide for creating docs
  - `token-validation.md` - Token budget management
  - `navigation.md` - Hierarchy navigation patterns
  - `maintenance.md` - Updating existing documentation
- **scripts/**
  - `validate_tokens.sh` - Token validation script
  - `validate_links.sh` - Link validation script
  - `validate_structure.sh` - Structure validation script

## Examples

See existing CLAUDE.md files for examples:
- Root: `/CLAUDE.md`
- Category: `/apps/CLAUDE.md`, `/packages/CLAUDE.md`
- Runtime: `/apps/node/CLAUDE.md`, `/apps/web/CLAUDE.md`, `/apps/core/CLAUDE.md`
- Project: `/apps/node/gql-api/CLAUDE.md`, `/packages/node/db/CLAUDE.md`

## Quick Reference

**Token Budget:**
- Target: ~500 tokens (~375 words)
- Maximum: 1000 tokens (~750 words)
- Use progressive disclosure if over budget

**File Naming:**
- Always `CLAUDE.md` (uppercase, exact spelling)
- Always in project root directory
- Supporting docs in `docs/` subdirectory

**Required Sections:**
1. Title & tagline
2. Responsibilities
3. Parent Context (except root)
4. Tech Stack
5. Command Discovery
6. Convention Deviations
7. Documentation Directive
8. Detailed Documentation links

**Remember:**
- Keep CLAUDE.md concise (navigational entry point)
- Put details in docs/ files
- Document decisions in decisions/ ADRs
- Mark non-standard patterns with warnings
- Include parent/child navigation
- Validate token budgets

## Post-Change Documentation Checklist

After making code changes, consider whether documentation needs updating:

- [ ] Did I add a new project/package? -> Create CLAUDE.md
- [ ] Did I change build commands? -> Update Command Discovery
- [ ] Did I add a new convention? -> Document in Convention Deviations
- [ ] Did I make an architectural decision? -> Create ADR
- [ ] Did I change dependencies? -> Update Tech Stack section
- [ ] Did I modify a documented workflow? -> Update relevant docs
- [ ] Are all CLAUDE.md files under token budget? -> Run validate_tokens.sh
- [ ] Are all links valid? -> Run validate_links.sh

---

*For detailed guidance, see the guides/ directory.*

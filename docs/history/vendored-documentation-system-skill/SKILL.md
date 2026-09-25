# Documentation System Skill

Manages hierarchical CLAUDE.md documentation across SOA, thrive, and coach repositories.

## Overview

This skill provides templates and validation for the 5-level CLAUDE.md hierarchy:

1. **Root** (`/CLAUDE.md`) - Repo-wide context
2. **Category** (`/packages/CLAUDE.md`, `/apps/CLAUDE.md`) - Packages vs Apps
3. **Runtime Tier** (`/apps/web/`, `/apps/node/`, `/packages/core/`) - By runtime
4. **Project** (`/apps/node/trpc-api/CLAUDE.md`) - Individual app/package
5. **Leaf** (`/apps/node/trpc-api/sectors/iam/`) - Sub-components (if needed)

## Token Budget

- **Target**: ~500 tokens (~375 words)
- **Maximum**: 1000 tokens (~750 words)
- Use progressive disclosure: extract details to `claude/` or `docs/`

## Required Sections

Every CLAUDE.md should include:

1. **Title & tagline** - What this is
2. **Responsibilities** - What it does
3. **Parent Context** - Link to parent tier (except root)
4. **Tech Stack** - Key technologies
5. **Convention Deviations** - Mark with `⚠️`

## Templates

See `templates/` directory:
- `claude-md-root.md` - Root CLAUDE.md
- `claude-md-tier-web.md` - Web runtime tier
- `claude-md-tier-node.md` - Node runtime tier
- `claude-md-tier-core.md` - Core/agnostic tier

## Validation

Run validation scripts in `scripts/`:
- `validate_tokens.sh` - Check token budget
- `validate_links.sh` - Check markdown links

## Cross-Repo Pattern

Thrive and coach reference SOA documentation:

```markdown
## Shared Documentation

See [soa/claude/frontend/sveltekit/](~/dev/soa/claude/frontend/sveltekit/) for:
- Project setup patterns
- Routing conventions
```

# Hierarchical Claude Configuration for SOA, Thrive & Coach

## What We're Doing

We're implementing a structured documentation system that helps Claude Code understand our codebases better. Instead of one large CLAUDE.md file that tries to explain everything, we're creating a hierarchy of smaller, focused files that provide context at each level of the codebase.

## Why It Matters

- **Progressive disclosure**: Claude only loads the context it needs for the current task
- **Better answers**: Runtime-specific documentation means Claude understands whether you're working on a frontend app or backend service
- **Easier maintenance**: Smaller files (~500 tokens each) are easier to keep accurate
- **Cross-repo consistency**: thrive and coach reference soa's patterns, reducing duplication

## The Five-Level Hierarchy

```
Level 1: /CLAUDE.md
         Repo-wide context (tech stack, conventions, key commands)
              │
Level 2: /apps/CLAUDE.md  &  /packages/CLAUDE.md
         Category overviews
              │
Level 3: /apps/web/CLAUDE.md  &  /apps/node/CLAUDE.md
         Runtime-specific context (this is the key innovation)
              │
Level 4: /apps/node/trpc-api/CLAUDE.md
         Individual project documentation
              │
Level 5: /apps/node/trpc-api/sectors/iam/CLAUDE.md
         Leaf-level details (only where needed)
```

## Runtime Discrimination

The key insight is that **frontend apps and backend services need different context**.

**Frontend (`apps/web/`):**
- Browser runtime (DOM, localStorage, fetch)
- Vite build tooling
- Amplify deployment
- Client-side auth patterns
- `VITE_*` environment variables

**Backend (`apps/node/`):**
- Node.js 20+ runtime
- Docker containerization
- ECS deployment
- Database connections (MongoDB, Redis)
- Server-side auth, health endpoints

**Packages:**
- Runtime-agnostic (or with documented constraints)
- ESM-only exports
- Peer dependency patterns

## Cross-Repo Strategy

**soa** is the source of truth. thrive and coach reference soa's documentation:

```markdown
# In thrive/CLAUDE.md:

## Shared Infrastructure

Uses infrastructure from [saga-soa](~/dev/soa):
- See [soa/claude/frontend/sveltekit/](~/dev/soa/claude/frontend/sveltekit/) for SvelteKit patterns
- See [soa/claude/tooling/pnpm.md](~/dev/soa/claude/tooling/pnpm.md) for pnpm installation rules
- See [soa/packages/node/](~/dev/soa/packages/node/) for Node.js packages
```

This keeps documentation DRY while allowing project-specific overrides.

## Context Loading

Claude loads context progressively:

1. **Always loaded**: Root CLAUDE.md
2. **Auto-detected**: When editing test files, testing context loads automatically
3. **On-demand**: Slash commands (`/testing`, `/deploy`) for explicit context

## Token Budget

Each CLAUDE.md file targets ~500 tokens (~375 words). Detailed information goes in `claude/` subdirectories and is linked from CLAUDE.md.

## What Gets Documented Where

| Information | Location |
|-------------|----------|
| Tech stack overview | Root CLAUDE.md |
| Build/test commands | Root CLAUDE.md |
| Runtime APIs | Tier CLAUDE.md (web/ or node/) |
| Deployment patterns | claude/deployment.md |
| Code conventions | claude/conventions.md |
| Architecture decisions | claude/decisions/*.md (ADRs) |
| Project-specific gotchas | Project CLAUDE.md |

## Validation

CI validates documentation on every PR:
- Token budget checks
- Link validation
- Required sections present

## Next Steps

1. Review this summary with team
2. Pair session with test engineers on testing approach
3. Implement Phase 1 (infrastructure setup) in soa
4. Roll out to thrive and coach

---

*Based on research from nimbee PR 7876. Full plan: [claude/gh_t54/plan.md](../claude/gh_t54/plan.md)*

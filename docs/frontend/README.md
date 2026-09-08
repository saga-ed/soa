# Frontend Framework Documentation

This directory contains Claude-readable context for frontend development patterns.

## Framework Strategy

| Framework | Status | Used In |
|-----------|--------|---------|
| **SvelteKit** | Primary | thrive, coach |
| **Next.js** | Legacy | soa (apps/web/docs, apps/web/web-client) |

## Directory Structure

- `nextjs/` - Legacy Next.js patterns (SOA internal apps only)
- `sveltekit/` - Primary SvelteKit patterns (thrive/coach web apps)
- `shared/` - Framework-agnostic patterns (API clients, auth, etc.)

## When to Use

- **New projects**: Use SvelteKit (see `sveltekit/`)
- **Existing SOA web apps**: Reference `nextjs/` for maintenance
- **Cross-cutting concerns**: Reference `shared/` for API patterns, auth flows

## Cross-Repo References

Thrive and Coach CLAUDE.md files should reference:
```markdown
See [soa/claude/frontend/sveltekit/](~/dev/soa/claude/frontend/sveltekit/) for:
- Project setup patterns
- Routing conventions
- Load function patterns
```

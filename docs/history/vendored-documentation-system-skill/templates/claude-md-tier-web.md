# Web Runtime Tier CLAUDE.md Template

> For apps/web/ or packages/web/ directories

# [Tier Name] - Web Runtime

[Brief description of web tier purpose]

## Parent Context

See [/CLAUDE.md](../../CLAUDE.md) for repository-wide context.

## Runtime Environment

**Type**: Frontend/Browser
**Target**: Browser (ES2020+)
**Build**: Vite/Next.js → Amplify deployment

## Framework

- [SvelteKit | Next.js] - [version]
- TypeScript strict mode

## Key Patterns

- See `claude/frontend/[framework]/` for framework-specific patterns
- See `claude/frontend/shared/` for cross-framework patterns

## Browser APIs Used

- LocalStorage for [purpose]
- Fetch API for API calls
- [Other browser APIs]

## Environment Variables

All env vars must be prefixed appropriately:
- `VITE_*` for Vite/SvelteKit
- `NEXT_PUBLIC_*` for Next.js

| Variable | Description |
|----------|-------------|
| `VITE_API_URL` | Backend API endpoint |

## Projects in This Tier

| Project | Description |
|---------|-------------|
| `[project-name]/` | [Brief description] |

## Convention Deviations

- ⚠️ [Any tier-specific deviations]

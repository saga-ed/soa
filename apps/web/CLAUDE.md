# SOA Web Applications

Frontend applications running in browser environment.

## Parent Context

See [/apps/CLAUDE.md](../CLAUDE.md) for apps overview.

## Runtime Environment

**Type**: Frontend/Browser
**Target**: Browser (ES2020+)
**Framework**: Next.js 15 (legacy)
**Build**: Next.js → AWS Amplify

## Projects

| Project | Framework | Description |
|---------|-----------|-------------|
| `docs/` | Next.js 15 | SOA documentation site |
| `web-client/` | Next.js 15 | Example client app |

## Key Patterns

See [claude/frontend/](../../claude/frontend/) for detailed patterns:
- `nextjs/` - Next.js specific patterns (legacy)
- `shared/` - API client, auth patterns

## Development

```bash
# Run docs app
pnpm --filter docs dev

# Run web-client
pnpm --filter web-client dev
```

## Environment Variables

All env vars must be prefixed with `NEXT_PUBLIC_*`:

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_API_URL` | Backend API endpoint |

## Convention Deviations

- ⚠️ Next.js is legacy - new projects should use SvelteKit

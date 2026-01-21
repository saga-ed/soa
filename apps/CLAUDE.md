# SOA Applications

Example applications demonstrating SOA package usage patterns.

## Parent Context

See [/CLAUDE.md](../CLAUDE.md) for repository-wide context.

## Structure

```
apps/
├── web/         # Frontend applications (browser runtime)
├── node/        # Backend applications (Node.js runtime)
├── core/        # Runtime-agnostic apps (if any)
└── projects/    # Legacy project directory
```

## Runtime Tiers

| Tier | Runtime | Description |
|------|---------|-------------|
| `web/` | Browser | Next.js/SvelteKit frontend apps |
| `node/` | Node.js | Express/tRPC backend APIs |
| `core/` | Agnostic | CLI tools, scripts (if any) |

## Key Patterns

- Apps import from `packages/` using workspace protocol
- Each app has its own `package.json` with specific dependencies
- Use `pnpm --filter [app-name] dev` to run individual apps

## See Also

- `web/CLAUDE.md` - Frontend app patterns
- `node/CLAUDE.md` - Backend API patterns

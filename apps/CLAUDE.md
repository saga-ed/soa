# SOA Applications

Example applications demonstrating SOA package usage patterns.

## Runtime Tiers

Apps import from `packages/` by runtime compatibility: `web/` (browser, Next.js/SvelteKit),
`node/` (Express/tRPC backend), `core/` (runtime-agnostic — currently empty except this
tier's own CLAUDE.md). `examples/` holds demo apps; `projects/` is a legacy directory.

Run an individual app with `pnpm --filter [app-name] dev`.

## See Also

- `web/CLAUDE.md` - Frontend app patterns
- `node/CLAUDE.md` - Backend API patterns

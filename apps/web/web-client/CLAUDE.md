# web-client

SOA example client app for testing and interacting with all API examples.

## Responsibilities

- Testing interface for REST, GraphQL (SDL), GraphQL (TypeGraphQL), and tRPC APIs
- Real-time API health monitoring with connection status dashboard
- Interactive endpoint testing with tRPC client integration
- Demonstrates @saga-ed/soa-ui component library usage

## Parent Context

See [/apps/web/CLAUDE.md](../CLAUDE.md) for web app patterns.

## Tech Stack

- **Framework**: Next.js 15 (App Router)
- **Runtime**: Browser (React 19)
- **UI**: @saga-ed/soa-ui components
- **API Client**: @trpc/client v11 with shared AppRouter types
- **Build**: Next.js + Turbopack (dev)

## Key Commands

```bash
pnpm dev          # Start dev server (port 3000, Turbopack)
pnpm build        # Build for production
pnpm start        # Run production server
pnpm lint         # Lint with ESLint (zero warnings)
pnpm check-types  # TypeScript type check
```

## Architecture

```
web-client/
├── app/                        # Next.js App Router
│   ├── layout.tsx             # Root layout
│   ├── page.tsx               # Dashboard with API health status
│   ├── rest-api/page.tsx      # REST API testing page
│   ├── gql-api/page.tsx       # GraphQL SDL testing page
│   ├── tgql-api/page.tsx      # TypeGraphQL testing page
│   └── trpc-api/
│       ├── page.tsx           # tRPC testing page
│       └── endpoints/page.tsx # tRPC endpoint explorer
├── src/services/              # API client services
│   ├── trpc-client-service.ts # Type-safe tRPC client
│   ├── trpc-curl-service.ts   # cURL-based tRPC client
│   ├── endpoints.ts           # Endpoint definitions
│   └── types.ts               # Service interfaces
└── public/                    # Static assets
```

**Features:**
- Dashboard with real-time health checks for all 4 API examples
- Per-API testing pages with interactive endpoint execution
- Shared `ServiceInterface` for consistent API client patterns

## Environment Variables

All client-side env vars must use `NEXT_PUBLIC_*` prefix.

API endpoints default to `localhost:4000-4003` for development.

## Convention Deviations

- Next.js is legacy - new projects should use SvelteKit
- Uses `app/` directory (Next.js convention) instead of `src/` for pages

## See Also

- `/apps/node/trpc-api/` - tRPC API consumed by this client
- `/apps/node/rest-api/` - REST API example
- `/packages/web/ui/` - React component library
- `/claude/frontend/nextjs/` - Next.js specific patterns

---

*Last updated: 2026-02-11*

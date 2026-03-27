# tRPC API

A modular tRPC-based API using sector-based architecture with static router composition and direct type export.

## Overview

This API implements a tRPC server with a sector-based organization. Each sector represents a distinct business domain and contains its own tRPC routers, Zod schemas, and business logic. The `AppRouter` type is exported directly from the static router composition — no code generation required.

## Architecture

### Sector-Based Organization

The API is organized into **sectors**, each representing a distinct business domain:

```
src/sectors/
├── project/
│   ├── trpc/
│   │   ├── project.router.ts    # Static tRPC router definition
│   │   ├── project.schemas.ts   # Zod schemas + TypeScript types
│   │   ├── project.types.ts     # Re-exports for sector interface
│   │   ├── project.data.ts      # Business logic/data access
│   │   └── index.ts             # Sector exports
│   └── rest/                    # REST endpoints (if needed)
└── run/
    └── trpc/                    # Same structure as project
```

### Static Router Composition

Sector routers are defined as plain module-level constants and statically imported into `app-router.ts`, which composes them into the `appRouter` and exports `type AppRouter = typeof appRouter`. This type is re-exported by the `trpc-types` sub-package for client consumption.

## Quick Start

```bash
# Install dependencies
pnpm install

# Start the development server
pnpm dev

# Build for production
pnpm build
```

## Type Sharing

The `trpc-types` sub-package directly re-exports the `AppRouter` type from `app-router.ts`. Clients import the type for end-to-end type safety:

```typescript
import type { AppRouter } from '@saga-ed/soa-trpc-types';
```

For details, see: **[trpc-types README](./trpc-types/README.md)**

## Scripts

- `pnpm dev` - Start development server with hot reload
- `pnpm build` - Build the API for production
- `pnpm test` - Run tests

## Development

The API uses dependency injection for clean separation of concerns and testability. Each sector can be developed independently. Services are injected via the tRPC context at request time from the Inversify DI container, keeping router definitions pure and statically analyzable.

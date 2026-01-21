# tRPC API

A modular tRPC-based API using sector-based architecture with dynamic router loading and type generation.

## Overview

This API implements a tRPC server with a sector-based organization. Each sector represents a distinct business domain and contains its own tRPC routers, Zod schemas, and business logic.

## Architecture

### Sector-Based Organization

The API is organized into **sectors**, each representing a distinct business domain:

```
src/sectors/
├── project/
│   ├── trpc/
│   │   ├── project.router.ts    # tRPC controller implementation
│   │   ├── project.schemas.ts   # Zod schemas + TypeScript types
│   │   ├── project.types.ts     # Re-exports for sector interface
│   │   ├── project.data.ts      # Business logic/data access
│   │   └── index.ts             # Sector exports
│   └── rest/                    # REST endpoints (if needed)
└── run/
    └── trpc/                    # Same structure as project
```

### Dynamic Router Loading

The API dynamically loads tRPC routers from sector directories at runtime, automatically discovering new sectors without manual configuration.

## Quick Start

```bash
# Install dependencies
pnpm install

# Start the development server
pnpm dev

# Build for production
pnpm build
```

## Type Generation

This API works with the companion `trpc-types` package which automatically generates TypeScript types from the tRPC router structure. For detailed information about type generation, router parsing, and usage examples, see:

**[📖 Detailed Documentation →](./trpc-types/README.md)**

## Scripts

- `pnpm dev` - Start development server with hot reload
- `pnpm build` - Build the API for production
- `pnpm test` - Run tests
- `pnpm generate` - Generate tRPC router types

## Development

The API uses dependency injection for clean separation of concerns and testability. Each sector can be developed independently and will be automatically discovered by the main application. 
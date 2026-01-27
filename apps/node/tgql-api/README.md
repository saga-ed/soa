# TypeGraphQL API

A modular TypeGraphQL-based API using sector-based architecture with dynamic resolver loading and type generation.

## Overview

This API implements a GraphQL server using TypeGraphQL decorators with a sector-based organization. Each sector represents a distinct business domain and contains its own GraphQL resolvers, types, and business logic.

## Architecture

### Sector-Based Organization

The API is organized into **sectors**, each representing a distinct business domain:

```
src/sectors/
├── user/
│   ├── gql/
│   │   ├── user.resolver.ts    # GraphQL resolver implementation
│   │   ├── user.type.ts        # Object type definitions
│   │   ├── user.input.ts       # Input type definitions
│   │   └── index.ts            # Sector exports
│   └── rest/                   # REST endpoints (if needed)
└── session/
    └── gql/                    # Same structure as user
```

### Dynamic Resolver Loading

The API dynamically loads GraphQL resolvers from sector directories at runtime, automatically discovering new sectors without manual configuration.

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

This API works with the companion `tgql-types` package which automatically generates TypeScript types from the GraphQL schema. For detailed information about type generation, schema building, and usage examples, see:

**[📖 Detailed Documentation →](./tgql-types/README.md)**

## Scripts

- `pnpm dev` - Start development server with hot reload
- `pnpm build` - Build the API for production
- `pnpm test` - Run tests
- `pnpm generate` - Generate GraphQL schema SDL

## Development

The API uses dependency injection for clean separation of concerns and testability. Each sector can be developed independently and will be automatically discovered by the main application. 
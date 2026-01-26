# saga-soa Project Overview

## Purpose
saga-soa is the base framework monorepo providing shared packages, patterns, and tooling for Saga microservices. It serves as the foundation for derived projects like Coach and Thrive.

## Tech Stack

| Category | Technology | Version |
|----------|------------|---------|
| Runtime | Node.js | >=24 |
| Package Manager | pnpm | 9.0.0 |
| Build System | Turborepo | ^2.5.4 |
| Language | TypeScript | 5.8.2 |
| Bundler | bunchee / tsup | varies |

## Database
- MongoDB (native driver 5.7.0)
- No ORM - direct collection operations
- Connection managed via `@saga-ed/soa-db`

## API Layer
- Express HTTP framework
- GraphQL with @apollo/server (SDL-first)
- tRPC for type-safe RPC
- Inversify for dependency injection

## Shared Packages

```
@saga-ed/soa-api-core      - Controller base classes, middleware
@saga-ed/soa-db            - MongoDB provider and utilities
@saga-ed/soa-logger        - Pino-based logging
@saga-ed/soa-config        - Configuration management
@saga-ed/soa-rabbitmq      - RabbitMQ messaging (optional)
@saga-ed/soa-pubsub-server - Real-time WebSocket events
```

## Project Structure

```
saga-soa/
├── apps/                 # Example applications
│   └── examples/        # Reference implementations
│       ├── gql-api/     # GraphQL SDL-first example
│       ├── rest-api/    # REST API example
│       └── trpc-api/    # tRPC example
├── packages/            # Shared libraries
│   ├── api-core/       # Base controllers, middleware
│   ├── db/             # MongoDB provider
│   ├── logger/         # Pino logging
│   ├── config/         # Configuration management
│   └── ...             # Other utilities
├── build-tools/        # Build configuration
├── docs/               # Documentation
└── memory-bank/        # Legacy context (migrating to .serena)
```

## Dependency Injection

- Inversify 6.2.2 for IoC
- Interface-based design with `I` prefix
- All services decorated with `@injectable()`
- Container configured per application

## Internal Dependencies

Use pnpm workspace dependencies, NOT TypeScript project references:
```json
{
  "dependencies": {
    "@saga-ed/soa-config": "workspace:*"
  }
}
```

## Testing
- Vitest 1.5.0 for unit/integration tests
- AAA pattern with comments required
- Mock implementations in `__tests__/` directories

## Derived Projects
- **Coach** (`~/dev/coach`) - Professional development platform
- **Thrive** (`~/dev/thrive`) - Schedule management (PostgreSQL variant)

## Related Memories
- `naming_conventions.md` - File and code naming patterns
- `inversify_patterns.md` - Dependency injection conventions
- `mongodb_patterns.md` - Database query patterns
- `turborepo_commands.md` - Build system commands

# Quickstart Guide

This guide covers how to go from a fresh checkout to a complete build and full test run for the `saga-ed/soa` monorepo.

## Prerequisites

- **Node.js**: v20+ (recommended: v22.x)
- **pnpm**: v9.0.0+ (the project uses pnpm workspaces)

### Installing pnpm

If you don't have pnpm installed:

```bash
# Using npm
npm install -g pnpm

# Or using corepack (Node.js 16.13+)
corepack enable
corepack prepare pnpm@latest --activate
```

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/saga-ed/soa.git
cd soa

# 2. Install dependencies
pnpm install

# 3. Build all packages
pnpm build

# 4. Run all tests
pnpm test
```

## Step-by-Step Guide

### 1. Clone the Repository

```bash
git clone https://github.com/saga-ed/soa.git
cd soa
```

### 2. Install Dependencies

```bash
pnpm install
```

This will install all dependencies for the entire monorepo, including:
- Root workspace dependencies
- All packages in `packages/*`
- All apps in `apps/*`
- All build tools in `build-tools/*`

Expected output:
```
Scope: all 20 workspace projects
...
Done in X.Xs
```

**Note**: You may see warnings about deprecated packages and peer dependencies. These are generally safe to ignore.

### 3. Build All Packages

```bash
pnpm build
```

This uses Turborepo to build all packages in the correct dependency order:

1. **Foundation packages** (no dependencies):
   - `@saga-ed/soa-typescript-config`
   - `@saga-ed/soa-eslint-config`
   - `@saga-ed/soa-pubsub-core`

2. **Core packages**:
   - `@saga-ed/soa-config`
   - `@saga-ed/soa-logger`
   - `@saga-ed/soa-trpc-codegen`
   - `@saga-ed/soa-tgql-codegen`

3. **Service packages**:
   - `@saga-ed/soa-api-core`
   - `@saga-ed/soa-db`
   - `@saga-ed/soa-pubsub-server`
   - `@saga-ed/soa-pubsub-client`

4. **Type packages** (generated):
   - `@saga-ed/soa-trpc-types`
   - `@saga-ed/soa-tgql-types`

5. **Applications**:
   - `rest-api`
   - `tgql-api`
   - `trpc-api`
   - `web-client`

Expected output:
```
• Running build in 18 packages
...
Tasks:    18 successful, 18 total
```

### 4. Run All Tests

```bash
pnpm test
```

This runs the Vitest test suite across all packages. Expected results:
- **~296 tests** across 38 test files
- Tests cover unit tests, integration tests, and type compatibility tests

Expected output:
```
Test Files  37 passed (37)
     Tests  296 passed (296)
```

## Individual Package Commands

### Building a Single Package

```bash
# Build a specific package
pnpm --filter @saga-ed/soa-api-core build

# Build a package and its dependencies
pnpm --filter @saga-ed/soa-api-core... build
```

### Testing a Single Package

```bash
# Test a specific package
pnpm --filter @saga-ed/soa-logger test

# Test with watch mode
pnpm --filter @saga-ed/soa-logger test:watch
```

### Running Example Apps

```bash
# Run the tRPC API example
pnpm --filter trpc-api dev

# Run the REST API example
pnpm --filter rest-api dev

# Run the GraphQL API example
pnpm --filter tgql-api dev

# Run the web client
pnpm --filter web-client dev
```

## Package Structure

```
soa/
├── packages/               # Shared libraries
│   ├── api-core/          # Express/tRPC/GraphQL server utilities
│   ├── config/            # Configuration management
│   ├── db/                # Database utilities (MongoDB)
│   ├── eslint-config/     # Shared ESLint configuration
│   ├── logger/            # Pino-based logging
│   ├── pubsub-client/     # PubSub client for real-time events
│   ├── pubsub-core/       # PubSub type definitions
│   ├── pubsub-server/     # PubSub server implementation
│   ├── tgql-codegen/      # TypeGraphQL code generator
│   ├── trpc-codegen/      # tRPC code generator
│   ├── typescript-config/ # Shared TypeScript configuration
│   └── ui/                # Shared UI components
├── apps/
│   ├── docs/              # Documentation site
│   └── examples/
│       ├── rest-api/      # REST API example
│       ├── tgql-api/      # TypeGraphQL API example
│       ├── trpc-api/      # tRPC API example
│       └── web-client/    # Next.js web client
└── build-tools/
    └── zod2ts/            # Zod to TypeScript converter
```

## Common Issues

### Peer Dependency Warnings

You may see warnings like:
```
WARN  Issues with peer dependencies found
└─┬ trpc-playground 1.0.4
  └── ✕ unmet peer @trpc/server@^10: found 11.4.3
```

These are expected due to some dependencies not yet supporting the latest versions. They don't affect functionality.

### Build Cache

If you encounter strange build issues after switching branches:

```bash
# Clean all build artifacts
pnpm clean

# Remove Turborepo cache
rm -rf .turbo

# Reinstall and rebuild
pnpm install
pnpm build
```

### Type Errors After Package Changes

If you modify package dependencies:

```bash
# Regenerate the lockfile
pnpm install

# Clean and rebuild
pnpm clean
pnpm build
```

## Development Workflow

1. **Make changes** to packages in `packages/`
2. **Build affected packages**: `pnpm build`
3. **Run tests**: `pnpm test`
4. **Type check**: `pnpm check-types`
5. **Lint**: `pnpm lint`

## NPM Registry Configuration

Packages use the `@saga-ed` scope and are published to AWS CodeArtifact:

```bash
# .npmrc
@saga-ed:registry=https://saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/
```

To install packages, authenticate with CodeArtifact first. See [CODEARTIFACT_SETUP.md](./CODEARTIFACT_SETUP.md) for details.

## Additional Resources

- [Express API Guide](./express-api-guide.md)
- [Library Guide](./library-guide.md)
- [Saga SOA TLDR](./saga-soa-tlrd.md)

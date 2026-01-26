# Turborepo Commands and Patterns

## Overview
All saga-derived monorepos use Turborepo for build orchestration, caching, and task management. This document covers common commands and patterns.

## Essential Commands

### Development
```bash
# Start all apps in dev mode
pnpm dev

# Start specific app
pnpm --filter @saga/api dev
pnpm --filter api dev  # Short form if unique

# Start multiple specific apps
pnpm --filter @saga/api --filter @saga/web dev
```

### Building
```bash
# Build all packages and apps
pnpm build

# Build specific package
pnpm --filter @saga/shared build

# Build package and its dependencies
pnpm --filter @saga/api... build

# Build package and its dependents
pnpm --filter ...@saga/shared build
```

### Type Checking
```bash
# Type check all packages
pnpm check-types

# Type check specific package
pnpm --filter @saga/api check-types
```

### Testing
```bash
# Run all tests
pnpm test

# Run tests for specific package
pnpm --filter @saga/api test

# Run tests in watch mode
pnpm --filter @saga/api test -- --watch

# Run tests with coverage
pnpm test -- --coverage
```

### Linting
```bash
# Lint all packages
pnpm lint

# Lint with auto-fix
pnpm lint -- --fix

# Lint specific package
pnpm --filter @saga/api lint
```

### Full Check (CI)
```bash
# Run all checks (lint, types, test, build)
pnpm check

# Equivalent to:
pnpm lint && pnpm check-types && pnpm test && pnpm build
```

## Filter Patterns

### Package Selection
```bash
# By exact name
pnpm --filter @saga/api <command>

# By pattern
pnpm --filter "@saga/*" <command>
pnpm --filter "./packages/*" <command>

# By directory
pnpm --filter ./apps/api <command>
```

### Dependency Filtering
```bash
# Package and all its dependencies
pnpm --filter @saga/api... build

# Package and all its dependents
pnpm --filter ...@saga/shared build

# Only dependencies (exclude the package itself)
pnpm --filter @saga/api^... build
```

### Excluding Packages
```bash
# All except specific package
pnpm --filter "!@saga/legacy" build

# Combine with pattern
pnpm --filter "@saga/*" --filter "!@saga/legacy" build
```

## Caching

### How Caching Works
Turborepo hashes:
- Source files
- Environment variables (configured)
- Dependencies
- Task configuration

If inputs haven't changed, cached output is restored.

### Cache Commands
```bash
# Clear local cache
pnpm turbo daemon clean

# Run without cache (force fresh)
pnpm build --force

# See cache status
pnpm turbo run build --dry-run
```

### Remote Caching
```bash
# Login to remote cache (Vercel)
pnpm turbo login

# Link to remote cache
pnpm turbo link

# Run with remote cache
pnpm build  # Automatically uses remote if configured
```

## Task Configuration

### turbo.json Structure
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "check-types": {
      "dependsOn": ["^build"]
    },
    "test": {
      "dependsOn": ["build"],
      "outputs": ["coverage/**"]
    },
    "lint": {},
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

### Task Dependencies
- `^build` - Run build in dependencies first
- `build` - Run build in same package first
- `["^build", "^check-types"]` - Multiple dependencies

### Outputs
Configure what to cache:
```json
{
  "build": {
    "outputs": ["dist/**", ".next/**", "!.next/cache/**"]
  }
}
```

## Common Workflows

### Clean Build
```bash
# Remove all build artifacts
pnpm clean  # If script exists

# Or manually
rm -rf node_modules/.cache
find . -name "dist" -type d -exec rm -rf {} +
find . -name ".turbo" -type d -exec rm -rf {} +

# Fresh install and build
pnpm install
pnpm build
```

### CI Pipeline
```bash
# Typical CI sequence
pnpm install --frozen-lockfile
pnpm check-types
pnpm lint
pnpm test
pnpm build
```

### Adding a New Package
```bash
# Create package directory
mkdir -p packages/new-package

# Initialize with package.json
cd packages/new-package
pnpm init

# Add to workspace (automatic with pnpm-workspace.yaml pattern)

# Install dependencies
pnpm --filter @saga/new-package add zod

# Build to verify
pnpm --filter @saga/new-package build
```

### Updating Dependencies
```bash
# Update all packages
pnpm update

# Update specific dependency across monorepo
pnpm update typescript --recursive

# Update in specific package
pnpm --filter @saga/api update express
```

## Troubleshooting

### Cache Issues
```bash
# If builds seem stale
pnpm turbo daemon clean
pnpm build --force
```

### Dependency Graph Issues
```bash
# Visualize dependency graph
pnpm turbo run build --graph

# Generate graph file
pnpm turbo run build --graph=graph.html
```

### Task Not Running
Check:
1. Package has the script in package.json
2. Package matches filter pattern
3. Task is defined in turbo.json
4. Dependencies completed successfully

```bash
# Debug with dry run
pnpm turbo run build --dry-run --filter @saga/api
```

## Environment Variables

### Configuring for Cache
```json
{
  "tasks": {
    "build": {
      "env": ["NODE_ENV", "API_URL"],
      "passThroughEnv": ["AWS_*"]
    }
  }
}
```

### Global Environment
```json
{
  "globalEnv": ["CI", "NODE_ENV"],
  "globalPassThroughEnv": ["AWS_*"]
}
```

## Performance Tips

1. **Parallelize independent tasks** - Turbo runs tasks in parallel by default
2. **Use remote caching** - Speeds up CI and team builds
3. **Minimize outputs** - Only cache what's needed
4. **Use filter** - Only run what you need during development
5. **Persistent tasks** - Mark long-running dev tasks as `persistent: true`

## Related Memories
- `typescript_conventions.md` - TypeScript configuration
- `vitest_testing.md` - Running tests with Turbo

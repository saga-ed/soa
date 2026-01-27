# TGQL Types

Auto-generated TypeScript types for the TypeGraphQL API based on TypeGraphQL decorators.

## Overview

This package automatically extracts type information from TypeGraphQL resolvers, object types, and input types to generate:

- Schema building utilities
- TypeScript interface definitions
- Operation type definitions for queries and mutations

## Scripts

- `pnpm generate` - Generate types once
- `pnpm dev` - Watch for changes and regenerate types
- `pnpm build` - Generate types and build the package
- `pnpm test` - Run tests

## Configuration

The generation is configured via `tgql-codegen.config.js`:

```javascript
module.exports = {
  source: {
    sectorsDir: '../src/sectors',
    resolverPattern: '*/gql/*.resolver.ts',
    typePattern: '*/gql/*.type.ts',
    inputPattern: '*/gql/*.input.ts'
  },
  generation: {
    outputDir: './generated',
    packageName: '@saga-ed/tgql-types',
    schemaName: 'AppSchema'
  }
};
```

## Generated Files

- `generated/schema.ts` - Main schema building utilities
- `generated/types/*.types.ts` - Type definitions for each sector
- `generated/index.ts` - Main export file

## Usage

```typescript
import { buildAppSchema, getSchemaSDL } from '@saga-ed/tgql-types';
import type { User, UserInput } from '@saga-ed/tgql-types';

// Build the GraphQL schema
const schema = await buildAppSchema();

// Get SDL string
const sdl = await getSchemaSDL();
```
# @hipponot/tgql-codegen

TypeGraphQL code generation utilities for the saga-soa monorepo. This tool provides a two-phase generation workflow for creating GraphQL SDL files and TypeScript types from TypeGraphQL resolvers.

## Overview

The tgql-codegen tool supports a two-phase generation process:

1. **Phase 1: SDL Emission** - Generates GraphQL Schema Definition Language (SDL) files from TypeGraphQL resolvers
2. **Phase 2: Type Generation** - Uses graphql-codegen to generate TypeScript types from the emitted SDL files

This approach provides proper client-side type generation while maintaining the benefits of TypeGraphQL's server-side schema definition.

## Installation

```bash
pnpm add @hipponot/tgql-codegen
```

## Configuration

Create a `tgql-codegen.config.js` file in your project:

```javascript
module.exports = {
  source: {
    sectorsDir: './src/sectors',
    resolverPattern: '*/gql/*.resolver.ts',
    typePattern: '*/gql/*.type.ts',
    inputPattern: '*/gql/*.input.ts'
  },
  generation: {
    outputDir: './generated',
    packageName: '@hipponot/tgql-types',
    schemaName: 'AppSchema'
  },
  sdl: {
    enabled: true,
    outputDir: './generated/schema',
    fileName: 'schema.graphql',
    emitBySector: true,
    sectorFileNamePattern: '{sector}.graphql'
  },
  graphqlCodegen: {
    enabled: true,
    schemaPath: './generated/schema/*.graphql',
    outputDir: './generated/types',
    plugins: ['typescript', 'typescript-operations'],
    config: {
      scalars: {
        ID: 'string',
        DateTime: 'Date'
      },
      avoidOptionals: {
        field: true,
        inputValue: false,
        object: false
      }
    }
  }
};
```

## CLI Commands

### Generate Both SDL and Types

```bash
# Generate both SDL files and TypeScript types
tgql-codegen generate

# With custom config file
tgql-codegen generate -c ./my-config.js

# With custom output directory
tgql-codegen generate -o ./my-generated
```

### SDL Generation Only

```bash
# Generate only SDL files
tgql-codegen generate --sdl-only

# Or use the dedicated SDL command
tgql-codegen emit-sdl

# Emit by sector (default)
tgql-codegen emit-sdl --by-sector

# Emit unified schema
tgql-codegen emit-sdl --unified

# With custom output directory
tgql-codegen emit-sdl -o ./my-schema
```

### Type Generation Only

```bash
# Generate only TypeScript types from existing SDL
tgql-codegen generate --types-only

# Or use the dedicated types command
tgql-codegen emit-types

# With custom schema path
tgql-codegen emit-types -s ./my-schema/*.graphql

# With custom output directory
tgql-codegen emit-types -o ./my-types
```

### Watch Mode

```bash
# Watch for changes and regenerate
tgql-codegen watch
```

## Two-Phase Workflow

### Phase 1: SDL Emission

The SDL emission phase:

1. **Parses TypeGraphQL resolvers** from your sectors
2. **Builds GraphQL schemas** using TypeGraphQL's `buildSchema`
3. **Emits SDL files** using GraphQL's `printSchema`
4. **Supports sector-based emission** or unified schema

**Output**: GraphQL SDL files (`.graphql`)

### Phase 2: Type Generation

The type generation phase:

1. **Reads emitted SDL files** from Phase 1
2. **Uses graphql-codegen** to generate TypeScript types
3. **Supports multiple client types** (Apollo, URQL, etc.)
4. **Generates operation types** for queries and mutations

**Output**: TypeScript type files (`.ts`)

## Configuration Options

### SDL Configuration

```javascript
sdl: {
  enabled: boolean,                    // Enable SDL generation
  outputDir: string,                   // Output directory for SDL files
  fileName?: string,                   // Filename for unified schema
  emitBySector: boolean,              // Emit separate files per sector
  sectorFileNamePattern?: string       // Pattern for sector filenames
}
```

### GraphQL CodeGen Configuration

```javascript
graphqlCodegen: {
  enabled: boolean,                    // Enable type generation
  schemaPath: string,                  // Path to SDL files
  documents?: string,                  // Path to GraphQL operations
  outputDir: string,                   // Output directory for types
  plugins: string[],                   // GraphQL CodeGen plugins
  config?: Record<string, any>         // Plugin configuration
}
```

## Supported GraphQL CodeGen Plugins

The tool supports all graphql-codegen plugins. Common ones include:

- `typescript` - Base TypeScript types
- `typescript-operations` - Types for queries/mutations
- `typescript-react-apollo` - React hooks for Apollo Client
- `typescript-urql` - URQL client types
- `typescript-graphql-request` - GraphQL Request client types

## Example Usage

### Basic Setup

```bash
# Generate both SDL and types
tgql-codegen generate

# This creates:
# - ./generated/schema/user.graphql
# - ./generated/schema/session.graphql
# - ./generated/types/index.ts
```

### Client-Side Usage

```typescript
// Import generated types
import type { User, Session, GetUserQuery, CreateUserMutation } from '@hipponot/tgql-types';

// Use with Apollo Client
import { useQuery, useMutation } from '@apollo/client';
import { gql } from '@apollo/client';

const GET_USER = gql`
  query GetUser($id: ID!) {
    user(id: $id) {
      id
      name
      email
    }
  }
`;

function UserComponent({ userId }: { userId: string }) {
  const { data, loading } = useQuery<GetUserQuery>(GET_USER, {
    variables: { id: userId }
  });
  
  // TypeScript will provide full type safety
  return <div>{data?.user?.name}</div>;
}
```

## Integration with Build Tools

### Package.json Scripts

```json
{
  "scripts": {
    "codegen": "tgql-codegen generate",
    "codegen:sdl": "tgql-codegen emit-sdl",
    "codegen:types": "tgql-codegen emit-types",
    "codegen:watch": "tgql-codegen watch"
  }
}
```

### Turbo Integration

```json
{
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "codegen": {
      "dependsOn": ["^build"],
      "outputs": ["generated/**"]
    }
  }
}
```

## Migration from Ad-Hoc Generation

If you were using the previous ad-hoc type generation:

1. **Update configuration** to enable both SDL and graphql-codegen
2. **Run the new generator** to create SDL files first
3. **Update imports** to use the new generated types
4. **Remove old type files** that were generated ad-hoc

The new approach provides:
- ✅ Proper GraphQL type generation
- ✅ Support for all GraphQL features
- ✅ Better client-side integration
- ✅ More accurate type definitions
- ✅ Support for GraphQL operations

## Troubleshooting

### Common Issues

1. **SDL files not found**: Ensure `sdl.enabled` is true and resolvers are properly parsed
2. **Type generation fails**: Check that SDL files exist and are valid GraphQL schema
3. **Import errors**: Verify output paths and ensure generated files are in the correct location

### Debug Mode

```bash
# Enable verbose logging
DEBUG=tgql-codegen tgql-codegen generate
```

## Contributing

This tool is part of the saga-soa monorepo. See the main repository for contribution guidelines.
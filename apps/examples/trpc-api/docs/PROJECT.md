# TRPC API Project Documentation

## Overview

This project implements a modular tRPC-based API using a sector-based architecture. The API dynamically loads tRPC routers from sector directories and provides strongly-typed client interfaces through a companion `trpc-types` package.

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

### Files in `sectors/*/trpc/`

Each sector's tRPC directory contains:

- **`*.router.ts`** - Main tRPC controller extending `AbstractTRPCController`
  - Implements the actual API endpoints (queries/mutations)
  - Uses dependency injection for logger and business logic
  - Defines the sector's `createRouter()` method

- **`*.schemas.ts`** - **Core type definitions** 
  - Zod schemas for runtime validation (`CreateProjectSchema`, `GetProjectSchema`, etc.)
  - TypeScript types derived from schemas (`CreateProjectInput`, `Project`, etc.)
  - This is the **single source of truth** for all type information

- **`*.types.ts`** - Re-export facade
  - Simply re-exports everything from `*.schemas.ts` 
  - Provides a stable import interface for the sector

- **`*.data.ts`** - Business logic implementation
  - Contains the actual CRUD operations
  - Isolated from tRPC concerns for testability

## Dynamic Router Loading

### Runtime (trpc-api)

The main application uses **fully dynamic router loading**:

```typescript
// main.ts
const trpcControllers = await controllerLoader.loadControllers(
  path.resolve(__dirname, './sectors/*/trpc/*.router.js'),
  AbstractTRPCController
);
```

**Key characteristics:**
- Uses glob patterns to discover sectors at runtime
- No hardcoded sector names or imports
- New sectors are automatically discovered and loaded
- Controllers are instantiated through dependency injection
- **Truly dynamic** - scales automatically with new sectors

### Static Type Generation (trpc-types)

The `trpc-types` subproject generates static types for client consumption using **fully dynamic generation**:

#### Dynamic Discovery & Analysis
```typescript
// scripts/generate-router.ts discovers sectors and parses router files
const sectors = await fs.readdir(TRPC_API_SECTORS_DIR);
for (const sector of sectors) {
  const sectorInfo = await parseSectorRouter(sector);  // ✅ Parse actual router files
  sectorInfos.push(sectorInfo);
}
```

#### Dynamic Code Generation
```typescript
// Generate dynamic imports based on discovered sectors
const imports = sectorInfos.map(sector => 
  `import * as ${sector.name}Schemas from './schemas/${sector.name}.schemas.js';`
).join('\n');

// Generate dynamic router structure based on parsed endpoints
const routerSections = sectorInfos.map(sector => {
  const endpointDefinitions = sector.endpoints.map(endpoint =>
    generateEndpointDefinition(endpoint, sector.name)
  ).join('\n');
  return `  ${sector.name}: t.router({\n${endpointDefinitions}\n  })`;
}).join(',\n');
```

## Type Sharing with web-client

### Flow Overview

1. **Source**: Sector schemas define types in `src/sectors/*/trpc/*.schemas.ts`
2. **Copy**: `trpc-types` copies schemas to `generated/schemas/`
3. **Generate**: Creates static `AppRouter` type matching runtime structure
4. **Export**: Publishes strongly-typed package for client consumption
5. **Consume**: `web-client` imports `AppRouter` type for `createTRPCClient<AppRouter>()`

### Benefits

- ✅ **Single Source of Truth**: All types originate from sector schemas
- ✅ **Runtime Safety**: Zod schemas validate requests at runtime  
- ✅ **Compile-time Safety**: TypeScript ensures client/server compatibility
- ✅ **Auto-completion**: Full IntelliSense in client code
- ✅ **Refactoring Safety**: Type changes are caught at build time

### Current Implementation

```typescript
// web-client usage
import { createTRPCClient } from '@trpc/client';
import type { AppRouter } from '@hipponot/trpc-types';

const client = createTRPCClient<AppRouter>({...});

// Fully typed API calls
const project = await client.project.getProjectById.query({ id: '123' });
const newRun = await client.run.createRun.mutate({ 
  projectId: '123', 
  name: 'test run' 
});
```

## Dynamic Parity Achievement

### ✅ Fully Dynamic Type Generation

The type generation now matches the runtime router loading approach:

- **Runtime (trpc-api)**: ✅ Truly dynamic - automatically handles new sectors
- **Type generation (trpc-types)**: ✅ **Fully dynamic** - discovers sectors, parses router files, and generates complete type structure

### Key Features

1. **Dynamic Sector Discovery**: 
   ```typescript
   // Automatically finds all sectors with tRPC directories
   const sectors = await fs.readdir(TRPC_API_SECTORS_DIR);
   ```

2. **Router File Parsing**:
   ```typescript
   // Parses actual router files to extract endpoint definitions
   async function parseSectorRouter(sectorName: string): Promise<SectorInfo> {
     const routerContent = await fs.readFile(routerFilePath, 'utf-8');
     // Extract endpoints with regex parsing of createRouter() method
   }
   ```

3. **Dynamic Code Generation**: All imports and router structure generated based on discovered sectors and parsed endpoints

### Zero Manual Maintenance

**Result**: Adding a new sector to `trpc-api` requires **no manual updates** to `trpc-types` other than running `npm run build`.

The system automatically:
- Discovers new sectors
- Copies their schemas
- Parses their router endpoints 
- Generates appropriate imports and type definitions
- Builds complete `AppRouter` type

## Build Pipeline

### Current Process

1. **`generate:schemas`** - Copy schemas from sectors to `generated/schemas/` (fully dynamic)
2. **`generate:router`** - Parse router files and generate dynamic AppRouter (fully dynamic) 
3. **`tsup`** - Build final package with proper exports

### Generated Artifacts

```
trpc-types/generated/           # ⚠️ In .gitignore - auto-generated
├── schemas/                    # Copied from sectors (✅ fully dynamic)
│   ├── project.schemas.ts
│   ├── run.schemas.ts  
│   └── index.ts
└── router.ts                   # Dynamic AppRouter (✅ fully dynamic)
```

## Future Enhancements

1. **Schema Validation**: Ensure generated types match runtime router structure  
2. **Hot Reload Support**: Watch for sector changes during development
3. **Documentation Generation**: Auto-generate API docs from sector definitions
4. **Enhanced Parsing**: Support more complex router patterns and middleware
5. **Build Optimization**: Cache parsing results for faster regeneration

This architecture now provides a **fully scalable, type-safe tRPC API** with complete dynamic parity between runtime and type generation. The system automatically adapts to new sectors without any manual intervention.
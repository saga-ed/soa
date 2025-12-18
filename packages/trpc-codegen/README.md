# tRPC Codegen

A powerful code generation tool for tRPC APIs that automatically discovers sectors, extracts schemas, and generates type-safe routers and TypeScript types.

## Features

- 🔍 **Automatic Sector Discovery**: Automatically finds and analyzes tRPC sectors in your project
- 📝 **Schema Extraction**: Copies and organizes Zod schemas from each sector
- 🚀 **Router Generation**: Generates a unified tRPC router with all sector endpoints
- 🔧 **Zod to TypeScript**: Converts Zod schemas to pure TypeScript types using zod2ts
- 📦 **Package Generation**: Creates a complete types package with proper exports
- 👀 **Watch Mode**: Regenerates code automatically when files change

## Installation

```bash
pnpm add -D @saga-ed/trpc-codegen
```

## Usage

### Basic Generation

```bash
# Generate from project root
trpc-codegen generate

# Generate with custom config
trpc-codegen generate --config ./my-config.js

# Generate with custom output directory
trpc-codegen generate --output-dir ./dist/types
```

### Watch Mode

```bash
# Watch for changes and regenerate automatically
trpc-codegen watch

# Watch with custom config
trpc-codegen watch --config ./my-config.js
```

### CLI Options

```bash
trpc-codegen generate [options]

Options:
  -c, --config <path>      Path to config file
  -p, --project <path>     Project directory path (default: current directory)
  -o, --output-dir <path>  Output directory for generated files
  --no-zod2ts              Disable Zod to TypeScript conversion (enabled by default)
```

## Configuration

Create a `codegen.config.js` file in your project:

```javascript
export default {
  // Source configuration
  source: {
    sectorsDir: 'src/sectors',
    routerPattern: '*/trpc/*-router.ts',
    schemaPattern: '*/trpc/schema/*-schemas.ts'
  },
  
  // Generation configuration  
  generation: {
    outputDir: './generated',
    packageName: '@my-app/types',
    routerName: 'AppRouter'
  },
  
  // Parsing configuration
  parsing: {
    endpointPattern: /(\w+):\s*t(?:[\s\n]*\.input\((\w+Schema)\))?[\s\S]*?\.(query|mutation)\(/g,
    routerMethodPattern: /createRouter\(\s*\)\s*\{[\s\S]*?return\s+router\(\s*\{([\s\S]*?)\}\s*\)\s*;?\s*\}/
  },

  // Zod2ts configuration
  zod2ts: {
    enabled: true,           // Enable/disable Zod to TypeScript conversion
    outputDir: './types'     // Output directory for generated TypeScript types
  }
}
```

### Default Configuration

If no config file is found, the tool uses these defaults:

```javascript
{
  source: {
    sectorsDir: 'src/sectors',
    routerPattern: '*/trpc/*-router.ts',
    schemaPattern: '*/trpc/*-schemas.ts'
  },
  generation: {
    outputDir: './generated',
    packageName: '@saga-ed/trpc-types',
    routerName: 'AppRouter'
  },
  parsing: {
    endpointPattern: /(\w+):\s*t(?:[\s\n]*\.input\((\w+Schema)\))?[\s\S]*?\.(query|mutation)\(/g,
    routerMethodPattern: /createRouter\(\s*\)\s*\{[\s\S]*?return\s+router\(\s*\{([\s\S]*?)\}\s*\)\s*;?\s*\}/
  },
  zod2ts: {
    enabled: true,
    outputDir: './types'
  }
}
```

## Project Structure

The tool expects your project to follow this structure:

```
src/
└── sectors/
    ├── project/
    │   └── trpc/
    │       ├── project-router.ts
    │       └── schema/
    │           └── project-schemas.ts
    └── run/
        └── trpc/
            ├── run-router.ts
            └── schema/
                └── run-schemas.ts
```

## Generated Output

After running the tool, you'll get:

```
generated/
├── index.ts              # Main package exports
├── router.ts             # Unified tRPC router
├── schemas/
│   ├── index.ts          # Schema re-exports
│   ├── project-schemas.ts
│   └── run-schemas.ts
└── types/                # Pure TypeScript types (if zod2ts enabled)
    ├── index.ts          # Types re-exports
    ├── project/
    │   ├── CreateProject.ts
    │   ├── UpdateProject.ts
    │   └── GetProject.ts
    └── run/
        ├── CreateRun.ts
        ├── UpdateRun.ts
        └── GetRun.ts
```

## Type System: Z Types vs Pure TypeScript Types

tRPC Codegen generates two distinct type systems with clear naming conventions:

### Z Types (Zod-dependent)
- **Naming**: Schema name + `Z` suffix (e.g., `CreateProjectZ`)
- **Purpose**: Runtime validation using `z.infer<typeof Schema>`
- **Usage**: tRPC routers, server-side validation
- **Dependencies**: Requires Zod at runtime

### Pure TypeScript Types (Zod-independent)
- **Naming**: Clean names without suffixes (e.g., `CreateProject`)
- **Purpose**: Static type checking without runtime overhead
- **Usage**: Frontend clients, type-only imports
- **Dependencies**: No runtime dependencies

### Example Type Generation

**Schema Definition:**
```typescript
// project-schemas.ts
export const CreateProjectSchema = z.object({
  name: z.string().min(1, 'Project name is required'),
  description: z.string().optional(),
  status: z.enum(['active', 'inactive', 'archived']).default('active'),
});

// Z type (Zod-dependent)
export type CreateProjectZ = z.infer<typeof CreateProjectSchema>;
```

**tRPC Router Usage (Backend):**
```typescript
// Uses Z types for runtime validation
createProject: t
  .input(CreateProjectSchema)
  .mutation(({ input }: { input: CreateProjectZ }) => {
    return projectHelper.createProject(input);
  })
```

**Generated Pure TypeScript Type:**
```typescript
// CreateProject.ts (generated by zod2ts)
export type CreateProject = {
  name: string;
  description?: string | undefined;
  status?: 'active' | 'inactive' | 'archived';
};
```

**Frontend Usage (Client):**
```typescript
// Uses pure types - no Zod dependency
import type { CreateProject } from '@my-app/types';

const projectData: CreateProject = {
  name: 'New Project',
  description: 'A new project'
};
```

## Zod to TypeScript Conversion

The tool integrates with [zod2ts](https://github.com/saga-soa/zod2ts) to convert Zod schemas to pure TypeScript types:

- **Enabled by default** - can be disabled with `--no-zod2ts` flag
- **Configurable output** - types are generated in a separate `types/` directory
- **Sector organization** - types are organized by sector for better structure
- **Automatic indexing** - creates index files for easy importing
- **Export-ready** - all generated types include `export` statements

### Import Patterns

**Backend (tRPC Routers) - Use Z Types:**
```typescript
import {
  CreateProjectSchema,
  type CreateProjectZ,
  type UpdateProjectZ,
  type GetProjectZ
} from './schema/project-schemas.js';
```

**Frontend (Clients) - Use Pure Types:**
```typescript
import type {
  CreateProject,
  UpdateProject,
  GetProject
} from '@my-app/types';
```

**Mixed Usage - Both Types Available:**
```typescript
// From generated schemas (Zod-dependent)
export * from './generated/schemas/index.js';  // *Z types + schemas

// From generated types (pure TypeScript)  
export * from './generated/types/index.js';   // clean types
```

## Integration

### Package.json Scripts

```json
{
  "scripts": {
    "generate": "trpc-codegen generate",
    "generate:watch": "trpc-codegen watch",
    "build": "pnpm generate && tsup"
  }
}
```

### Build Tools

The generated output is compatible with:
- **tsup** - Fast TypeScript bundler
- **tsc** - TypeScript compiler
- **Vite** - Build tool and dev server
- **Webpack** - Module bundler

## Advanced Usage

### Custom Endpoint Patterns

Customize how endpoints are detected:

```javascript
parsing: {
  endpointPattern: /(\w+):\s*t(?:[\s\n]*\.input\((\w+Schema)\))?[\s\S]*?\.(query|mutation)\(/g,
  routerMethodPattern: /createRouter\(\s*\)\s*\{[\s\S]*?return\s+router\(\s*\{([\s\S]*?)\}\s*\)\s*;?\s*\}/
}
```

### Multiple Configurations

Create different configs for different environments:

```bash
# Development
trpc-codegen generate --config codegen.dev.js

# Production
trpc-codegen generate --config codegen.prod.js
```

## Troubleshooting

### Common Issues

1. **Sectors not found**: Check `sectorsDir` path in config
2. **Schema files missing**: Verify `schemaPattern` matches your file structure
3. **Zod2ts errors**: Ensure zod2ts is available in your project
4. **Build failures**: Check that all generated files are properly exported

### Debug Mode

Enable verbose logging by setting environment variables:

```bash
DEBUG=trpc-codegen:* trpc-codegen generate
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## License

MIT
# SOA Core Packages

Runtime-agnostic packages that work in any JavaScript environment.

## Parent Context

See [/packages/CLAUDE.md](../CLAUDE.md) for packages overview.

## Runtime Environment

**Type**: Agnostic
**Target**: Node.js 20+, Browser (ES2020+)
**Module**: ESM only

## Packages

| Package | Description | Docs |
|---------|-------------|------|
| `config/` | Pure configuration loader with environment variable validation. Single-purpose, zero deviations. **Usage:** `import { getConfig } from '@saga-ed/soa-config'` | Tier |
| `trpc-codegen/` | CLI tool for generating TypeScript types from tRPC routers. Standard Node.js CLI patterns. **Usage:** `pnpm trpc-codegen --input router.ts` | Tier |
| `tgql-codegen/` | CLI tool for generating TypeScript types from TypeGraphQL schemas. Standard Node.js CLI patterns. **Usage:** `pnpm tgql-codegen --schema schema.ts` | Tier |
| `typescript-config/` | Shared TypeScript configuration presets (`base.json`, `react.json`, `node.json`). Pure JSON config files. **Usage:** `extends: "@saga-ed/soa-typescript-config/base.json"` | Tier |
| `eslint-config/` | Shared ESLint configuration with strict rules, no Prettier. Pure JavaScript config files. **Usage:** `extends: ["@saga-ed/soa-eslint-config"]` | Tier |

**Note:** All packages in this tier are simple/single-purpose and follow tier patterns exactly. They are adequately documented at the tier level and do not require project-level CLAUDE.md files.

## Agnostic Constraints

Packages in this tier MUST NOT:
- Use Node.js-specific APIs (fs, path, process)
- Use browser-specific APIs (window, document, localStorage)
- Have runtime-specific dependencies

## Safe Patterns

```typescript
// Zod schemas work everywhere
import { z } from 'zod';

export const UserSchema = z.object({
    id: z.string(),
    name: z.string(),
});

// Type definitions work everywhere
export interface Config {
    apiUrl: string;
    timeout: number;
}
```

## Import Pattern

```typescript
// Safe to import anywhere (browser or Node.js)
import { Config } from '@saga-ed/soa-config';
```

## TypeScript Configuration

Other packages extend from typescript-config:

```json
{
    "extends": "@saga-ed/soa-typescript-config/base.json"
}
```

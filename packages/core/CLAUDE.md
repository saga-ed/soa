# SOA Core Packages

Runtime-agnostic packages that work in any JavaScript environment.

## Parent Context

See [/packages/CLAUDE.md](../CLAUDE.md) for packages overview.

## Runtime Environment

**Type**: Agnostic
**Target**: Node.js 20+, Browser (ES2020+)
**Module**: ESM only

## Packages

| Package | Description |
|---------|-------------|
| `config/` | Zod configuration schemas |
| `trpc-codegen/` | tRPC code generation CLI |
| `tgql-codegen/` | TypeGraphQL code generation CLI |
| `typescript-config/` | Shared tsconfig bases |
| `eslint-config/` | Shared ESLint configurations |

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

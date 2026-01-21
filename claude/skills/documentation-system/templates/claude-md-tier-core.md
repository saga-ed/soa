# Core/Agnostic Tier CLAUDE.md Template

> For apps/core/ or packages/core/ directories

# [Tier Name] - Runtime Agnostic

[Brief description of core tier purpose]

## Parent Context

See [/CLAUDE.md](../../CLAUDE.md) for repository-wide context.

## Runtime Compatibility

**Targets**: Node.js 20+, Browser (ES2020+)
**Module**: ESM only (no CJS)

## Purpose

This tier contains code that works in any JavaScript runtime:
- Configuration schemas (Zod)
- Type definitions
- Pure utility functions
- Build tooling
- Code generation

## Constraints

Packages in this tier MUST NOT:
- Use Node.js-specific APIs (fs, path, process, etc.)
- Use browser-specific APIs (window, document, localStorage)
- Have runtime-specific dependencies

If runtime-specific code is needed, it belongs in `node/` or `web/` tiers.

## Import Guidelines

```typescript
// Safe to import anywhere
import { Config } from '@saga-ed/soa-config';
import { TypeScriptConfig } from '@saga-ed/soa-typescript-config';

// These work in all runtimes
const config = Config.parse(rawConfig);
```

## Projects in This Tier

| Project | Description |
|---------|-------------|
| `config/` | Zod configuration schemas |
| `typescript-config/` | Shared tsconfig bases |
| `eslint-config/` | Shared ESLint configurations |
| `[codegen]/` | Code generation utilities |

## Convention Deviations

- ⚠️ [Any tier-specific deviations]

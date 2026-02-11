# SOA Packages

Shared libraries organized by runtime compatibility.

## Parent Context

See [/CLAUDE.md](../CLAUDE.md) for repository-wide context.

## Runtime Categories

| Tier | Runtime | Description |
|------|---------|-------------|
| `web/` | Browser | Browser-only packages (React UI) |
| `node/` | Node.js | Server-side packages (Express, DB, messaging) |
| `core/` | Agnostic | Work in any runtime (config, types, codegen) |

## Import Guidelines

```typescript
// Node packages: Import only in server-side code
import { db } from '@saga-ed/soa-db';
import { logger } from '@saga-ed/soa-logger';

// Web packages: Import only in client-side code
import { Button } from '@saga-ed/soa-ui';

// Core packages: Safe to import anywhere
import { Config } from '@saga-ed/soa-config';
```

## Key Packages

| Package | Tier | Description |
|---------|------|-------------|
| `api-core` | node | Express controllers, server utilities |
| `db` | node | MongoDB, MySQL, Redis connections |
| `logger` | node | Pino-based structured logging |
| `config` | core | Zod configuration schemas |
| `ui` | web | React component library |

## See Also

- `web/CLAUDE.md` - Browser runtime details
- `node/CLAUDE.md` - Node.js runtime details
- `core/CLAUDE.md` - Runtime-agnostic details

---

*Last updated: 2026-02*

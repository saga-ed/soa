# SOA Packages

Shared libraries organized by runtime compatibility.

## Runtime Categories

| Tier | Runtime | Import rule |
|------|---------|-------------|
| `web/` | Browser | Import only in client-side code (e.g. `@saga-ed/soa-ui`) |
| `node/` | Node.js | Import only in server-side code (e.g. `@saga-ed/soa-db`, `@saga-ed/soa-logger`) |
| `core/` | Agnostic | Safe to import anywhere (e.g. `@saga-ed/soa-config`) |

## Key Packages

Curated highlights, not exhaustive — `ls packages/*/` is the full set:

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

# SOA Web Packages

Browser-runtime packages for frontend applications.

## Parent Context

See [/packages/CLAUDE.md](../CLAUDE.md) for packages overview.

## Runtime Environment

**Type**: Browser
**Target**: ES2020+
**Module**: ESM only

## Packages

| Package | Description |
|---------|-------------|
| `ui/` | React component library |

## Browser Constraints

Packages in this tier:
- Run in browser environment only
- Have access to DOM, window, localStorage
- Must NOT use Node.js APIs (fs, path, process)
- Bundle with Vite or webpack

## Import Pattern

```typescript
// Only import in frontend apps (apps/web/*)
import { Button, Card } from '@saga-ed/soa-ui';
```

## Development

```bash
# Build UI components
pnpm --filter @saga-ed/soa-ui build

# Run Storybook (if available)
pnpm --filter @saga-ed/soa-ui storybook
```

---

*Last updated: 2026-02*

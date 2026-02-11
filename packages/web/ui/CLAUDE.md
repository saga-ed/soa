# ui

React component library for SOA frontend applications.

## Responsibilities

- Reusable React 19 UI components
- Shared design primitives (Button, Card, Code, etc.)
- Client-side components for Next.js/SvelteKit apps
- Component showcasing in docs app
- Internal package (not published externally)

## Parent Context

See [/packages/web/CLAUDE.md](../CLAUDE.md) for web package patterns.

## Tech Stack

- **Framework**: React 19 (Client Components)
- **Runtime**: Browser
- **Build**: Source exports (no bundling)
- **Type Safety**: TypeScript
- **Testing**: Vitest

## Structure

```
src/
├── button.tsx          # Interactive button component
├── card.tsx            # Card/link component
└── code.tsx            # Code snippet component
```

## Key Exports

```typescript
// Direct source imports (no build step)
import { Button } from '@saga-ed/soa-ui/button';
import { Card } from '@saga-ed/soa-ui/card';
import { Code } from '@saga-ed/soa-ui/code';
```

## Usage Pattern

```tsx
// In Next.js/SvelteKit apps
import { Button } from '@saga-ed/soa-ui/button';
import { Card } from '@saga-ed/soa-ui/card';

export default function Page() {
  return (
    <div>
      <Card title="Example" href="https://example.com">
        Card content here
      </Card>
      <Button appName="my-app">Click me</Button>
    </div>
  );
}
```

## Key Features

**Client Components:**
- All components use `'use client'` directive
- Compatible with Next.js App Router and SvelteKit
- Interactive elements with React hooks

**Source Exports:**
- No build step (exports raw .tsx files)
- Consumer apps handle transpilation
- Faster iteration during development

**Type Safety:**
- Full TypeScript support
- Exported type definitions
- Prop validation via TypeScript interfaces

## Convention Deviations

- ⚠️ Source exports instead of built dist/ (intentional for rapid development)
- This pattern allows consuming apps to bundle components their way

## See Also

- `/apps/web/docs/` - Component showcase and documentation
- `/packages/web/CLAUDE.md` - Web package patterns
- `/claude/frontend/` - Frontend framework patterns

---

*Last updated: 2026-02*

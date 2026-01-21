# Next.js in SOA Monorepo (Legacy)

> **Status**: Legacy - for maintenance of existing SOA web apps only.
> New projects should use SvelteKit.

## Overview

SOA has two Next.js applications:
- `apps/web/docs` - Documentation site (Next.js 15)
- `apps/web/web-client` - Example client app (Next.js 15)

## Tech Stack

- Next.js 15 with App Router
- React 19 (Server/Client Components)
- TypeScript strict mode
- Turbopack for development
- tRPC client integration

## Project Structure

```
apps/web/[app-name]/
├── src/
│   ├── app/           # App Router pages
│   │   ├── layout.tsx # Root layout
│   │   ├── page.tsx   # Home page
│   │   └── [route]/   # Route segments
│   ├── components/    # React components
│   └── lib/           # Utilities
├── public/            # Static assets
├── next.config.ts     # Next.js config
└── package.json
```

## Key Patterns

### Server vs Client Components

```tsx
// Server Component (default) - runs on server
export default async function Page() {
    const data = await fetchData();
    return <div>{data}</div>;
}

// Client Component - runs in browser
'use client';
export function InteractiveWidget() {
    const [state, setState] = useState();
    return <button onClick={() => setState(...)}>Click</button>;
}
```

### tRPC Client

```tsx
// src/lib/trpc.ts
import { createTRPCProxyClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@saga-ed/trpc-api';

export const trpc = createTRPCProxyClient<AppRouter>({
    links: [httpBatchLink({ url: '/api/trpc' })],
});
```

## Development

```bash
# From monorepo root
pnpm --filter web-client dev

# Or from app directory
cd apps/web/web-client && pnpm dev
```

## Build & Deploy

Built apps deploy to AWS Amplify. See `amplify.yml` in app directory.

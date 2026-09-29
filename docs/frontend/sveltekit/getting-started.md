# SvelteKit in Monorepo (Primary)

> **Status**: Primary framework for thrive and coach web apps.

## Overview

SvelteKit is the preferred framework for new frontend applications. It provides:
- File-based routing
- Server-side rendering (SSR)
- Static site generation (SSG)
- API routes
- Excellent TypeScript support

## Project Structure

```
apps/web/[app-name]/
├── src/
│   ├── routes/           # File-based routing
│   │   ├── +layout.svelte
│   │   ├── +page.svelte
│   │   └── [route]/
│   │       ├── +page.svelte
│   │       └── +page.server.ts  # Load function
│   ├── lib/              # Shared code ($lib alias)
│   │   ├── components/
│   │   └── utils/
│   └── app.html          # HTML template
├── static/               # Static assets
├── svelte.config.js      # SvelteKit config
├── vite.config.ts        # Vite config
└── package.json
```

## Key Patterns

### Routing

```
src/routes/
├── +page.svelte              # /
├── about/+page.svelte        # /about
├── blog/
│   ├── +page.svelte          # /blog
│   └── [slug]/+page.svelte   # /blog/:slug
└── api/
    └── health/+server.ts     # GET /api/health
```

### Load Functions

```typescript
// +page.server.ts - runs on server
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, fetch }) => {
    const response = await fetch('/api/data');
    const data = await response.json();
    return { data };
};
```

```svelte
<!-- +page.svelte -->
<script lang="ts">
    import type { PageData } from './$types';
    export let data: PageData;
</script>

<div>{data.data}</div>
```

### API Routes

```typescript
// src/routes/api/health/+server.ts
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
    return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json' }
    });
};
```

## Development

```bash
# From monorepo root
pnpm --filter @thrive/web dev

# Or from app directory
cd apps/web/[app-name] && pnpm dev
```

## Build & Deploy

```bash
pnpm build
```

Deploys to AWS Amplify. Configure adapter in `svelte.config.js`:

```javascript
import adapter from '@sveltejs/adapter-auto';
// Or for Amplify:
// import adapter from 'svelte-adapter-amplify';
```

## See Also

- `routing.md` - Detailed routing patterns
- `load-functions.md` - Data loading strategies
- `amplify-deployment.md` - AWS Amplify configuration

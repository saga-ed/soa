# docs

SOA documentation site built with Next.js 15.

## Responsibilities

- Documentation and examples for SOA packages
- Component library showcase (@saga-ed/soa-ui)
- Developer onboarding and API reference
- Living examples of shared UI components

## Parent Context

See [/apps/web/CLAUDE.md](../CLAUDE.md) for web app patterns.

## Tech Stack

- **Framework**: Next.js 15 (App Router)
- **Runtime**: Browser (React 19)
- **UI**: @saga-ed/soa-ui components
- **Build**: Next.js → static export
- **Deploy**: AWS Amplify

## Key Commands

```bash
pnpm dev          # Start dev server (port 3001)
pnpm build        # Build for production
pnpm start        # Run production server
pnpm lint         # Lint with ESLint
```

## Architecture

```
docs/
├── app/                    # Next.js App Router
│   ├── layout.tsx         # Root layout
│   ├── page.tsx           # Home page
│   └── globals.css        # Global styles
├── public/                # Static assets
└── package.json
```

**Features:**
- Next.js 15 App Router with React Server Components
- Integration with @saga-ed/soa-ui component library
- Development server on port 3001 (avoids conflicts with APIs)
- Turbopack for fast development builds

## Environment Variables

All client-side env vars must use `NEXT_PUBLIC_*` prefix:

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_API_URL` | Backend API endpoint (if needed) |

## Convention Deviations

- ⚠️ Next.js is legacy - new projects should use SvelteKit
- This app exists to document SOA packages until migration

## See Also

- `/packages/web/ui/` - React component library
- `/apps/web/CLAUDE.md` - Web app patterns
- `/claude/frontend/nextjs/` - Next.js specific patterns

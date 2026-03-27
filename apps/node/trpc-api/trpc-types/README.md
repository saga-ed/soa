# @saga-ed/trpc-types

Shared TypeScript types for the tRPC API, exported directly from the static router definition.

## Usage

This package re-exports the `AppRouter` type from the `app-router.ts` static router composition. No code generation is involved — types are derived directly from the source router via TypeScript's type inference.

```typescript
import type { AppRouter } from '@saga-ed/soa-trpc-types';
import type { RouterInputs, RouterOutputs } from '@saga-ed/soa-trpc-types';

// Inferred input/output types for specific procedures
type CreateProjectInput = RouterInputs['project']['createProject'];
type AllProjectsOutput = RouterOutputs['project']['getAllProjects'];
```

## Scripts

- `pnpm build` - Build the package (generates `.d.ts` via tsup)

## Exports

- `AppRouter` — the tRPC router type (type-only, zero runtime coupling)
- `RouterInputs` / `RouterOutputs` — inference helpers for procedure input/output types
- Zod schemas from sector routers (runtime exports for client-side validation)

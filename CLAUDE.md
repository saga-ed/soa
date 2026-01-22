# SOA (saga-soa)

Shared infrastructure monorepo for Saga platform applications.

## Responsibilities

- Shared packages for Node.js backend services
- Example applications demonstrating package usage
- Build tooling and code generation utilities

## Tech Stack

- **Runtime**: Node.js 20+ (ESM only)
- **Build**: Turborepo + pnpm workspaces
- **Language**: TypeScript (strict mode)
- **Testing**: Vitest
- **Linting**: ESLint (no Prettier)

## Structure

```
soa/
├── apps/           # Applications
│   ├── web/        # Frontend apps (Next.js - legacy)
│   └── node/       # Backend APIs
├── packages/       # Shared libraries
│   ├── web/        # Browser packages
│   ├── node/       # Node.js packages
│   └── core/       # Runtime-agnostic
├── claude/         # Claude-readable context
└── docs/           # Human documentation
```

## Key Commands

```bash
pnpm build          # Build all packages
pnpm test           # Run all tests
pnpm typecheck      # Type check
```

## Detailed Documentation

- See `claude/` for Claude-specific context
- See `claude/frontend/` for web framework patterns
- See `claude/tooling/pnpm.md` for pnpm installation rules
- See `apps/CLAUDE.md` for application details
- See `packages/CLAUDE.md` for package details

---

## Safety Rules

- Always ask for confirmation before running file write or delete commands
- Exception: pnpm and turbo commands are always allowed

## Allowed Commands

- All pnpm commands in saga-soa context
- All turbo commands in saga-soa context

## Coding Preferences

- Use 4-space indentation only
- Write tests for every new feature
- Use pnpm only (never npm)

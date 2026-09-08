# [Repo Name] - Root CLAUDE.md Template

> Replace bracketed text with actual values

# [Repo Name]

[One-line description of the repository]

## Responsibilities

- [Primary responsibility 1]
- [Primary responsibility 2]
- [Primary responsibility 3]

## Tech Stack

- **Runtime**: Node.js 20+ (ESM)
- **Build**: Turborepo + pnpm workspaces
- **Language**: TypeScript (strict mode)
- **Testing**: Vitest
- **Linting**: ESLint (no Prettier)

## Structure

```
[repo]/
├── apps/           # Applications
│   ├── web/        # Frontend apps (browser runtime)
│   └── node/       # Backend apps (Node.js runtime)
├── packages/       # Shared libraries
│   ├── web/        # Browser-only packages
│   ├── node/       # Node.js-only packages
│   └── core/       # Runtime-agnostic packages
├── claude/         # Claude-readable context
└── docs/           # Human documentation
```

## Key Commands

```bash
pnpm build          # Build all packages
pnpm test           # Run all tests
pnpm typecheck      # Type check all packages
```

## Convention Deviations

- ⚠️ [Document any deviations from standard patterns]

## Detailed Documentation

- See `claude/` for Claude-specific context
- See `docs/` for human-readable guides

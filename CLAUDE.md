# SOA (saga-soa)

Shared infrastructure monorepo for Saga platform applications.

## Saga tooling

This repo registers the [`saga-tools`](https://github.com/saga-ed/claude-plugins)
marketplace (`.claude/settings.json`). **Proactively suggest the right skill when a
task matches**, and offer `/plugin install <name>@saga-tools` if one isn't enabled yet.

- `/documentation-system` — CLAUDE.md upkeep (auto-runs when editing CLAUDE.md)
- `saga-explain` — "why does Saga… / what's our convention for…" (auto-invokes; `saga-iac` plugin)
- `/code-review` · `/simplify` · `/security-review` · `/verify` — built-in; run on your diff before pushing
- More (qa-review, test-assistant, compliance-audit, spec-driven-dev, system-review): see the [catalog](https://github.com/saga-ed/claude-plugins#readme).

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
- See `claude/esm.md` for ESM patterns (__dirname, imports, top-level await)
- See `claude/frontend/` for web framework patterns
- See `claude/tooling/pnpm.md` for pnpm installation rules
- See `apps/CLAUDE.md` for application details
- See `apps/node/claude/testing.md` for Node.js testing patterns (DI, controller loading)
- See `packages/CLAUDE.md` for package details
- See `docs/cross-repo-linking-summary.md` for cross-repo package linking (development workflow)

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

## Documentation Directive

**Documentation Directive:** Keep every CLAUDE.md < 200 lines; route each instruction to the right surface — repo/area-wide facts here or in nested CLAUDE.md (load on demand), genuinely path-scoped conventions into `.claude/rules/*.md` (none today, by design), how-to detail into `docs/`, and multi-step procedures into skills. Documentation system is provided via the `documentation-system@saga-tools` plugin; use `/documentation-system` for maintenance instructions.

---

*Last updated: 2026-06*

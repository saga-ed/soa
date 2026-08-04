# SOA (saga-soa)

Shared infrastructure monorepo for Saga platform applications.

## Saga tooling

This repo registers the [`saga-tools`](https://github.com/saga-ed/claude-plugins) marketplace
(`.claude/settings.json`) — skills auto-suggest when a task matches; catalog in the
[README](https://github.com/saga-ed/claude-plugins#readme). `/documentation-system` owns the
doc-routing rules (repo-wide vs. nested vs. `.claude/rules/*.md` vs. skills).

## Responsibilities

- Shared packages for Node.js backend services
- Example applications demonstrating package usage
- Build tooling and code generation utilities

## Tech Stack

- **Runtime**: Node.js (ESM only) — see `engines` in `package.json` for the required major
- **Build**: Turborepo + pnpm workspaces
- **Language**: TypeScript (strict mode)
- **Testing**: Vitest
- **Linting**: ESLint + Prettier

## Gotchas

- Type-check script is `pnpm check-types` (not `pnpm typecheck`).
- Formatter is Prettier, 2-space indent (`.prettierrc.json` is the source of truth — don't hand-apply a different width).
- Use pnpm only — `npm install` will fight the CodeArtifact `preinstall` hook and the lockfile.
- Node version disagrees across sources: `package.json` `engines` says `>=24`, but CI pins
  `NODE_VERSION: 22`. Trust `engines` locally; don't "fix" CI to match without checking why.

## Detailed Documentation

- See `claude/` for Claude-specific context
- See `claude/esm.md` for ESM patterns (__dirname, imports, top-level await)
- See `claude/frontend/` for web framework patterns
- See `claude/tooling/pnpm.md` for pnpm installation rules
- See `apps/CLAUDE.md` for application details
- See `apps/node/claude/testing.md` for Node.js testing patterns (DI, controller loading)
- See `packages/CLAUDE.md` for package details
- See `docs/cross-repo-linking-summary.md` for cross-repo package linking (development workflow)
- See `tools/walkthrough-video/CLAUDE.md` for generating narrated demo videos of any saga-soa frontend

---

## Safety Rules

Always ask for confirmation before file write/delete commands, except pnpm and turbo commands.

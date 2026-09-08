# SOA (saga-soa)

Shared infrastructure monorepo for Saga platform applications.

## Authority by location

Current pattern = this file, `.claude/rules/`, `docs/` (except `docs/history/`),
`docs/decisions/` entries marked `Accepted`/`RESOLVED`, non-draft `specs/`.
History = `docs/history/` (index: [docs/history/README.md](docs/history/README.md))
and legacy `claude/projects/` (index: [claude/projects/README.md](claude/projects/README.md))
— never a current pattern; a fact found only there is a harvest gap. Newer of
doc vs. code wins (`git log -1`).

<!-- docs-check: history-dir: docs/history -->

## Path-scoped rules (`.claude/rules/`)

- `testing-node.md` — loads on `apps/node/**` or `packages/node/**`: DI/Inversify,
  DB isolation, controller-loading, package unit/smoke test patterns.
- `testing-web.md` — loads on `apps/web/**`: Vitest browser mode, Playwright E2E.
- `event-driven.md` — loads on `packages/node/event-*/**` or
  `packages/node/observability/**`: outbox/consumer wiring, event versioning.
- `python-uv.md` — loads on `python/**`: uv package-management conventions.

Shared cross-runtime testing conventions (naming, ARES purposes, builders) live
in [`docs/testing/`](docs/testing/README.md), not in a rule — they're reference
material, not a path-scoped instruction.

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
- See `packages/CLAUDE.md` for package details
- See `docs/cross-repo-linking-summary.md` for cross-repo package linking (development workflow)
- See `tools/walkthrough-video/CLAUDE.md` for generating narrated demo videos of any saga-soa frontend

---

## Safety Rules

Always ask for confirmation before file write/delete commands, except pnpm and turbo commands.

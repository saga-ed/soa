# Getting Started & Build Cheatsheet

Setup, build/test commands, and the local-CI checks for the saga-soa monorepo,
merged from the root README's Quickstart, `LOCAL_DEVELOPMENT.md`, and
`docs/quickstart.md`. For architecture, see [overview.md](./overview.md) and
[saga-soa-tlrd.md](./saga-soa-tlrd.md).

## Prerequisites

- **Node.js**: `>=24` (per `package.json` `engines`)
- **pnpm**: `9.0.0` (pinned via `package.json` `packageManager`)

```sh
# Install pnpm via corepack (bundled with Node.js)
corepack enable
corepack prepare pnpm@9.0.0 --activate

# Or via npm
npm install -g pnpm
```

## Quickstart

```sh
git clone https://github.com/saga-ed/soa.git
cd soa
pnpm install
pnpm check
```

- Always run `pnpm install` before building or running any commands for the first time.
- Run `pnpm check` before every commit or PR — it forces a full, no-cache build of every
  package and app, then runs all unit tests.

## Build & Workspace Cheatsheet

```sh
turbo run build                 # Build all projects
turbo run test                  # Run all tests
pnpm clean && turbo run build   # Clean, then rebuild everything
pnpm list -r --depth 0          # List all workspace projects
```

Build or test a single project (filters use the package's own `name` field,
not its directory path):

```sh
turbo run build --filter=@saga-ed/soa-logger
turbo run build --filter=rest-api
turbo run test --filter=trpc-api
```

Other useful commands:

```sh
pnpm install --filter ./packages/node/logger        # Install deps for one package
pnpm add <package> --filter ./packages/node/logger   # Add a dep to one package
pnpm --filter ./packages/node/logger run <script>     # Run a script in one package
pnpm --filter web-client dev                          # Start a dev server
turbo run build --dry                                 # Dry run: show what would run
```

**Use `turbo`** for orchestrated, cached, dependency-aware tasks across the monorepo
(`build`, `test`, `lint`) — it runs independent tasks in parallel and skips unchanged
work. **Use `pnpm`** for package management and running scripts in a single package.

## Local CI Checks

Run the same checks CI runs, before pushing:

```sh
pnpm ci:check              # Lint + type-check + build + test, changed packages only
pnpm ci:check:all          # Same, but every package
pnpm ci:check @saga-ed/config   # Same, one named package
pnpm quick:check @saga-ed/config  # Fast subset: lint + type-check + build only
```

| Local script | Purpose |
|---|---|
| `pnpm ci:check` | Same checks as the `test-and-lint` CI job, changed packages only |
| `pnpm quick:check` | Fast feedback: lint, type-check, build (no test) |
| `pnpm ci:check:all` | Full workflow, every package |

Common failures:

- **"Cannot find module '@saga-ed/...'"** — build the dependency first
  (`turbo run build --filter=@saga-ed/<dep>`) or check its `package.json` exports.
- **"Could not find task `test` in project"** — the package is missing a `test` script;
  add one to its `package.json`.
- **Strange build issues after switching branches** — `pnpm clean && rm -rf .turbo && pnpm install && pnpm build`.

## Package Structure

```
soa/
├── packages/
│   ├── core/       # Config, DI-friendly cross-cutting packages (config, eslint-config, trpc-base, ...)
│   ├── node/       # Server-side packages (api-core, db, logger, event-*, pubsub-*, ...)
│   └── web/        # Browser packages (ui, rum-util)
├── apps/
│   ├── node/       # Backend example APIs (rest-api, tgql-api, gql-api, trpc-api)
│   └── web/        # Frontend apps (docs — the Next.js doc site, web-client)
```

See `packages/node/CLAUDE.md` and `packages/core`/`packages/web`'s own tier files for
the full package index.

## NPM Registry

Packages use the `@saga-ed` scope, published to AWS CodeArtifact
(`@saga-ed:registry` in `.npmrc`). Authenticate first — see
[CODEARTIFACT_SETUP.md](./CODEARTIFACT_SETUP.md).

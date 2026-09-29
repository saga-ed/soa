# saga-soa Monorepo Overview

## Project Description

**saga-soa** is a modern, modular monorepo for building service-oriented architectures (SOA) in educational and experimental environments. It leverages a collection of composable packages and apps to enable scalable, introspectable, and schema-driven APIs. The project is organized into:

- **apps/**: Applications (e.g., web, docs, example REST APIs)
- **packages/**: Reusable libraries (e.g., config, db, logger, api-core, UI)

## Build Tools

- **bunchee**: Used for building all core libraries in `packages/` (e.g., config, db, logger, api-core). It outputs ESM bundles and type declarations to `dist/`.
- **tsup**: (Legacy/optional) Used in some app projects for fast ESM bundling, but most core packages now use bunchee.
- **Next.js**: Used for building web and docs apps in `apps/web` and `apps/docs`.
- **Jest**: Used for unit testing all packages and apps.
- **pnpm**: Manages monorepo workspaces and dependencies.
- **TurboRepo**: Orchestrates builds, caching, and task running across the monorepo.

## Monorepo Structure

- `apps/` — Applications (web, docs, examples/rest_api, etc.)
- `packages/` — Core libraries (config, db, logger, api-core, UI, etc.)
- `docs/` — Project documentation (this directory)
- `memory-bank/` — Design notes, architecture, and technical context
- `tsconfig.json` and `packages/typescript-config/` — Shared TypeScript configuration
- `pnpm-workspace.yaml` — Workspace/project definitions
- `turbo.json` — TurboRepo pipeline configuration

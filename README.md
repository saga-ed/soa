# saga-soa

## Quickstart

```sh
pnpm install
pnpm check
```

- Always run `pnpm install` before building or running any commands for the first time.
- Run `pnpm check` before every commit or PR to ensure you haven't regressed functionality.

## Introduction

**saga-soa** is a modern, modular monorepo for building service-oriented architectures (SOA) in educational and experimental environments. It leverages [Turborepo](https://turbo.build/), [pnpm](https://pnpm.io/), and a collection of composable packages to enable scalable, introspectable, and schema-driven APIs. The project is organized into apps (web, docs) and packages (config, db, UI, etc.), supporting both serverless and traditional deployments.

Key features:

- Monorepo powered by Turborepo for fast, incremental builds
- Introspectable, schemaful APIs (type-graphql, tRPC, REST)
- Modular, logically composable microservices
- Flexible deployment: serverless or server
- Strong focus on developer experience and maintainability

## Build Out

This project is under active development. The following packages have some level of build out:

- **@hipponot/config**: Strongly-typed configuration management using Zod schemas for runtime validation and TypeScript safety. Supports environment variable-based configuration, dependency injection (Inversify), and mock configuration for testing.
- **@hipponot/db**: Helpers for managing connections to supported databases (MongoDB, SQL/MySQL, Redis). Designed for use with Inversify to manage shared and multiple database instances within the monorepo.
- **@hipponot/api-core**: Express-based REST API framework with sector (controller) auto-registration, dependency injection, and schema-driven design. Provides a foundation for building modular, testable service APIs.
- **apps/examples/rest-api**: Example REST API app demonstrating sector auto-registration, dependency injection, and integration with the core packages. Useful as a reference for building new services or for integration testing.

For more details and project tracking, see the [Project Board](https://github.com/orgs/hipponot/projects/22).

## Getting Started

[➡️ See Getting Started & Build Cheatsheet](docs/GETTING-STARTED.md)

## Architecture

![alt text](arc.png)

## Monorepo Consistency Check

Run the following command from the root to ensure the entire monorepo builds and all tests pass:

```sh
pnpm check
```

This will:

- Force a full, no-cache build of all packages and apps
- Run all unit tests in all packages and apps

**When to use:**

- Before opening a PR
- After major refactors
- Before a release
- Any time you want to verify monorepo health

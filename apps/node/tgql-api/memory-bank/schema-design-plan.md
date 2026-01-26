# GraphQL API Modular Schema & SDL Emission Plan

## 1. Modular Sector Schema Design

Each sector (user, session, etc.) exports its own resolvers, types, and optionally SDL. The main API dynamically loads all sector resolvers and composes them into a single schema.

## 2. Build Step for SDL Emission

A script (e.g., `scripts/emit-schema.ts`) loads all resolvers, builds the TypeGraphQL schema, and emits the SDL to `schema.graphql`. This is run as a build/codegen step, not at runtime.

## 3. Schema Export for Codegen

The emitted `schema.graphql` is used with `graphql-codegen` for generating client types/hooks. The workflow is documented for developers.

## 4. Federation Investigation

Research Apollo Federation v2 and TypeGraphQL integration. If adopted, update the build step to emit subgraph SDLs as needed.

## 5. Documentation & Codegen Integration

Document the workflow for adding sectors, emitting the schema, and running codegen for clients.

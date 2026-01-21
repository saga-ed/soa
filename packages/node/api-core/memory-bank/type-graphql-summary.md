# TypeGraphQL: Summary and Integration Notes

## What is TypeGraphQL?

TypeGraphQL is a framework for building GraphQL APIs in Node.js using TypeScript classes and decorators. It enables developers to define GraphQL schemas, types, and resolvers using a single source of truth—TypeScript classes—eliminating code duplication and improving maintainability.

## Key Features

- **Schema via Classes & Decorators:** Define GraphQL object types, inputs, enums, interfaces, and unions using TypeScript classes and decorators (`@ObjectType`, `@Field`, `@Resolver`, etc.).
- **Single Source of Truth:** No need to maintain separate SDL, interfaces, and resolver signatures—everything is derived from TypeScript code.
- **Validation:** Integrates with `class-validator` for automatic input and argument validation via decorators.
- **Authorization:** Built-in support for field, query, and mutation-level authorization using the `@Authorized` decorator and custom auth checkers.
- **Dependency Injection:** Supports DI containers (TypeDI, Inversify, etc.) for resolver and service injection, including request-scoped containers.
- **Middleware:** Supports middleware and custom decorators for cross-cutting concerns (logging, guards, etc.), both globally and per-resolver/field.
- **Advanced GraphQL Features:** Full support for interfaces, unions, custom scalars, subscriptions (via `@graphql-yoga/subscriptions`), query complexity analysis, and emitting schema SDL files.
- **ESM & Modern Node.js:** Native support for ECMAScript modules (ESM) and requires Node.js 22.x LTS or newer.

## Integration & Usage Patterns

- **TypeScript Config:** Requires `emitDecoratorMetadata`, `experimentalDecorators`, and `target: es2021` or newer. For ESM, set `module` and `moduleResolution` to `NodeNext` and `"type": "module"` in `package.json`.
- **Schema Bootstrapping:** Use `buildSchema` to generate the GraphQL schema from resolver classes. Integrates with Apollo Server, graphql-yoga, express-graphql, etc.
- **Validation & Auth:** Enable validation and authorization via options in `buildSchema` and decorators in code.
- **Subscriptions:** Use `@Subscription` decorator and a PubSub implementation (default: graphql-yoga PubSub).
- **Emitting Schema:** Can emit SDL files for tooling and client integration.

## Performance & Best Practices

- TypeGraphQL adds a small abstraction overhead compared to raw `graphql-js`, but offers significant DX improvements.
- For high-performance needs, use "simple resolvers" to bypass middleware and auth for specific fields.
- Use query complexity analysis to protect against expensive queries and DoS attacks.

## Migration & Compatibility

- **Node.js 22.x LTS is now a requirement for this mono-repo.**
- v2.0+ uses ESM, new DateTime scalar naming, and new subscriptions API (graphql-yoga PubSub).
- See migration guide for details on breaking changes from v1.x.

## Ecosystem & Examples

- Integrates with TypeORM, MikroORM, Typegoose, Apollo Federation, and more.
- Extensive examples and advanced patterns available in the [TypeGraphQL GitHub repo](https://github.com/MichalLytek/type-graphql/tree/master/examples).

---

**This summary provides the essential background for integrating TypeGraphQL into the saga-soa mono-repo, with a focus on leveraging its TypeScript-first approach, DI, validation, and modern Node.js/ESM compatibility.**

### Background

I would like to architect node/express server from reusable library components in a package called api-core. To begin with I would like to support two backend technologies specifically tRPC and type-graphql running on apollo-server.

```

express-server.ts - Contains boilderplate to setup an express server.  The ExpressServer class should instantiate and manage an `express.Application`.  The config should be modeled after the pattern in mongo-provider-config.ts (i.e. define a zod schema called express-server-schema that can be used by the ConfigManager to initialize a configuration blob that gets injected into ExpressServer)

core-trpc.ts - Contains boilerplate for configuring tRPC on top of ExpressServer

core-graphql.ts - Contains boilerplate for configuring type-graphql paired with apollo-server

core-rest.ts - Contains boiler plate for configuring plain REST endpoints

```

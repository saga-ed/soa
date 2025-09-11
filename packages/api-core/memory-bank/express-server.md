# Plan: `express-server.ts` Implementation and Testing

This document outlines the plan for implementing and testing the `express-server.ts` component within the `@hipponot/api-core` package.

## 1. Define Interfaces (`api-core/src/i-logger.ts`)

- **`ILogger`**: A simple logger interface with methods like `info`, `warn`, `error`, and `debug`. This ensures any logger implementation can be used interchangeably.
- **`LogLevel`**: A log level enum (`'info'`, `'warn'`, `'error'`, `'debug'`).

## 2. Implement a Logger (`api-core/src/logger.ts`)

- **`ConsoleLogger`**: A basic `ConsoleLogger` class that implements `ILogger` and writes messages to the console. It will take a `LogLevel` in its constructor to control output verbosity.

## 3. Define Server Configuration (`api-core/src/express-server-schema.ts`)

- **`ExpressServerSchema`**: A Zod schema that extends `HasConfigType`.
  - `configType`: `z.literal('EXPRESS_SERVER')`
  - `port`: `z.number().int().positive()`
  - `logLevel`: `z.enum(['debug', 'info', 'warn', 'error'])`
  - `name`: `z.string().min(1)`
- **`ExpressServerConfig`**: The inferred TypeScript type from the schema.

## 4. Implement the Express Server (`api-core/src/express-server.ts`)

- **`ExpressServer` class**:
  - **Dependencies**: Inject `ExpressServerConfig` and `ILogger` through the constructor using Inversify.
  - **Properties**:
    - `private app: express.Application`
    - `private config: ExpressServerConfig`
    - `private logger: ILogger`
  - **Methods**:
    - `start()`: Starts the Express server, listening on the configured port. Logs a startup message.
    - `stop()`: Stops the server gracefully.
    - `getApp()`: Returns the underlying `express.Application` instance for attaching middleware.

## 5. Testing Strategy

- **Mock Dependencies**:
  - **`MockLogger`**: A mock `ILogger` that stores log messages in an array for assertions.
  - **`MockConfigManager`**: Use `@hipponot/config` to provide a mock `ExpressServerConfig`.
- **Use `supertest`**: To make HTTP requests to the Express app without binding to a real network port.
- **Test Scenarios (`express-server.test.ts`)**:
  - Test server start/stop.
  - Test that `start()` logs the expected startup message.
  - Test a basic health check endpoint (`GET /health`).
  - Test dependency injection wiring.

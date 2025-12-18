# @saga-ed/logger

This package provides a configurable logging solution for the saga-soa project. It is built on top of Pino for high-performance, structured logging.

## Key Features

- **Pino-based**: Leverages the speed and structured logging capabilities of Pino. Using ping-http to adapt to use in an express context.
- **Configurable**: Uses Zod schemas for validating logger configuration.
- **Dependency Injection**: Designed to be used with Inversify.
- **Multiple Transports**: Supports console logging (with `pino-pretty` for development) and file logging.
- **Mockable**: Includes a mock logger for easy testing.

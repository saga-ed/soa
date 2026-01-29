# Logger Behaviors

This document describes the expected behaviors of the logger package based on environment, context, and configuration.

## Environment and Context

- **NODE_ENV**: The logger adapts its behavior based on the value of `process.env.NODE_ENV` (`local`, `development`, `production`).
- **isExpressContext**: Boolean, set via Dependency Injection (DI), indicating if the logger is running in an Express server context.
- **isForeground**: Automatically detected using `process.stdout.isTTY` (true = foreground, false = background/service/pipe).
- **logFile**: Optional string, path to a file for file logging.

## Behavior Matrix

| NODE_ENV    | isExpressContext | isForeground | logFile specified | Console Logger | File Logger | Required logFile? |
| ----------- | ---------------- | ------------ | ----------------- | -------------- | ----------- | ----------------- |
| local       | any              | any          | no                | yes            | no          | no                |
| local       | any              | any          | yes               | yes            | yes         | no                |
| development | true             | true         | no                | yes            | no          | no                |
| development | true             | true         | yes               | yes            | yes         | no                |
| development | true             | false        | yes               | no             | yes         | no                |
| development | false            | any          | yes               | no             | yes         | no                |
| production  | true             | any          | no                | error          | error       | yes               |
| production  | true             | true         | yes               | yes            | yes         | yes               |
| production  | true             | false        | yes               | no             | yes         | yes               |
| production  | false            | any          | yes               | no             | yes         | no                |

## Special Rules

- In **production** Express context, `logFile` is required. The logger will throw if it is not provided.
- In **development** and **production**, if both console and file loggers are needed, both are instantiated.
- In **local**, console logger is always instantiated; file logger is added if `logFile` is specified.
- **isForeground** is always detected at runtime using `process.stdout.isTTY`.
- **isExpressContext** must be set via DI in the logger configuration.

# Testing Improvement Plan

## @saga/db

- Increase negative/failure scenario coverage
- No integration tests for real DBs at this time
- No tests for SQL & Redis until those modules are implemented

## @hipponot/config

- Add more edge case tests (e.g., missing/partial env vars, malformed .env files).
- Add coverage for custom Zod schemas and advanced config scenarios.
- We will test integration with logger in the logger subproject

## @hipponot/logger

- Add tests for log output (e.g., verify file output with spies/mocks).
- Test logger integration with config (for file logging)

## @hipponot/api-core

- Add tests for REST controllers, error handling, and middleware.

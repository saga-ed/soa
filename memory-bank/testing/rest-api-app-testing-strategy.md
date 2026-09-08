# Strategy for Testing the Example App (rest-api)

## Current State

- No test scripts or test files are present.
- The app is a container for "sectors" (modular microservices/controllers).
- Uses routing-controllers, Inversify, and DI for sector registration.

## Recommended Testing Strategy

### 1. Unit Tests

- Controllers/Sectors: Test each sector/controller in isolation.
  - Mock dependencies (e.g., logger, services).
  - Test route handlers for expected responses, error handling, and logging.
- DI Container: Test that all controllers are correctly registered and injectable.

### 2. Integration Tests

- Sector Integration: Test the app with all sectors loaded.
  - Use supertest to make HTTP requests to the running Express app.
  - Validate routing, middleware, and sector isolation.
  - Test cross-sector interactions if any exist.
- Dependency Integration: Test with real/mock DB, config, and logger.

### 3. End-to-End (E2E) Tests

- User Workflows: Simulate real HTTP requests covering:
  - Sector-specific endpoints (happy path, edge cases, errors).
  - Health checks and root endpoints.
  - Authentication/authorization if present.
- Isolation: Each sector should be testable independently, but E2E should cover the full app with all sectors loaded.

### 4. Testing Philosophy for a Sector-Container App

- Unit tests for sector logic and controller methods.
- Integration tests for sector registration, DI, and routing.
- E2E tests for user-facing workflows, ensuring sectors do not interfere with each other.
- Contract tests (optional): If sectors expose APIs consumed by other services, use contract testing to ensure interface stability.

### 5. Test Organization

- Place unit tests in `src/sectors/__tests__` or alongside each sector.
- Place integration/E2E tests in `src/__tests__` or a top-level `tests/` directory.
- Use supertest for HTTP-level tests, and Jest for all test types.

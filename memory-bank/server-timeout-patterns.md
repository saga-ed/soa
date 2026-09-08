# Server Timeout Patterns

## Problem
When starting servers for testing or development, the agent can hang indefinitely if the server process doesn't terminate properly or if there are errors that prevent graceful shutdown.

## Solution
Always use timeout patterns when starting servers to ensure they don't hang the agent.

## Patterns

### 1. Timeout with kill (Recommended)
```bash
# Start server with timeout and kill if it hangs
timeout 10s pnpm start || true
```

### 2. Background with timeout
```bash
# Start in background with timeout
pnpm start &
sleep 10
kill %1 2>/dev/null || true
```

### 3. Test server startup
```bash
# Start server and test if it's running
pnpm start &
sleep 5
curl -s http://localhost:5000/health >/dev/null && echo "Server running" || echo "Server failed"
kill %1 2>/dev/null || true
```

### 4. For long-running processes
```bash
# For processes that should run longer
timeout 60s pnpm start || echo "Server stopped after timeout"
```

## Rules
1. **NEVER** start a server without a timeout mechanism
2. **ALWAYS** use `timeout` command or equivalent timeout pattern
3. **ALWAYS** clean up background processes
4. **ALWAYS** handle server startup failures gracefully
5. **NEVER** let server processes hang indefinitely

## Examples in Context

### Testing tRPC API
```bash
# Start server for testing
timeout 15s pnpm start || true

# Run tests
pnpm test

# Server automatically stops after timeout
```

### Development server
```bash
# Start dev server with timeout
timeout 30s pnpm dev || echo "Dev server stopped"
```

### Integration testing
```bash
# Start server, run tests, stop server
pnpm start &
sleep 5
pnpm test:integration
kill %1 2>/dev/null || true
```

## Why This Matters
- Prevents agent from hanging indefinitely
- Ensures clean test execution
- Maintains responsive development workflow
- Prevents resource leaks
- Ensures consistent behavior across environments

## Implementation
This pattern should be used whenever:
- Starting any server process
- Running long-running commands
- Testing server functionality
- Development server startup
- Integration test setup

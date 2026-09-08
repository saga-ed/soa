# ESM and __dirname Patterns

## Overview
In ESM (ECMAScript Modules), `__dirname` is not available as it's a CommonJS-specific global variable. This affects all modern TypeScript/Node.js projects that use ESM.

## The Problem
- `__dirname` is undefined in ESM modules
- Code that assumes `__dirname` exists will throw runtime errors
- This affects path resolution, file operations, and configuration loading

## ESM Workaround Pattern
Always use this pattern when you need the equivalent of `__dirname` in ESM:

```typescript
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory name equivalent to __dirname
const __dirname = path.dirname(fileURLToPath(import.meta.url));
```

## When to Use
- In test files that need to resolve paths relative to the test file location
- In configuration files that need to resolve relative paths
- In any module that needs to know its own location for path resolution

## When NOT to Use
- In code that will be imported by other modules (creates unnecessary variables)
- In utility functions that don't need path resolution
- In code that should be framework-agnostic

## Common Patterns

### Test Files
```typescript
beforeEach(async () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  basePath = path.resolve(__dirname);
  // ... rest of setup
});
```

### Configuration Files
```typescript
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default {
  source: {
    sectorsDir: path.resolve(__dirname, 'sectors'),
    // ...
  }
};
```

### Utility Functions
```typescript
// Instead of using __dirname, accept basePath as parameter
export function resolvePath(basePath: string, relativePath: string): string {
  return path.resolve(basePath, relativePath);
}
```

## Migration Checklist
- [ ] Remove all direct `__dirname` usage
- [ ] Add ESM workaround where needed
- [ ] Update tests to use proper path resolution
- [ ] Ensure configuration files use correct path resolution
- [ ] Test that all path-dependent operations work correctly

## Related Issues
- Test failures due to incorrect path resolution
- Configuration loading failures
- File not found errors in ESM environments
- Inconsistent behavior between CommonJS and ESM builds

## Best Practices
1. Always use the ESM workaround pattern in test files
2. Pass base paths as parameters to utility functions
3. Use relative paths in configuration when possible
4. Test path resolution in both development and build environments
5. Document path resolution patterns for team members

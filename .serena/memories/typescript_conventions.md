# TypeScript Conventions

## Overview
Standard TypeScript configuration and patterns used across all saga-derived monorepos (Thrive, Coach, SOA).

## Compiler Configuration

### Target and Module
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"]
  }
}
```

### Strict Mode
All projects use strict TypeScript:
```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

### Decorator Support
Required for Inversify DI:
```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

## Import Conventions

### File Extensions
**REQUIRED**: Always use `.js` extension for relative imports, even when importing `.ts` files:

```typescript
// Correct
import { UserService } from './services/user.service.js';
import { createContainer } from '../container.js';

// Incorrect - will fail at runtime
import { UserService } from './services/user.service';
import { UserService } from './services/user.service.ts';
```

### Import Order
Organize imports in this order, separated by blank lines:
1. Node.js built-ins
2. External packages
3. Internal packages (monorepo)
4. Relative imports

```typescript
import { readFile } from 'node:fs/promises';

import { injectable } from 'inversify';
import { z } from 'zod';

import { logger } from '@saga/logger';
import { Database } from '@saga/database';

import { UserRepository } from './repositories/user.repository.js';
import { validateUser } from './utils/validation.js';
```

### Named vs Default Exports
- Prefer named exports for better refactoring support
- Use default exports only for main module entry points

```typescript
// Preferred - named export
export class UserService { }
export function createUser() { }

// Acceptable for entry points
export default createApp;
```

## Type Conventions

### Naming
- Interfaces: PascalCase, no `I` prefix
- Types: PascalCase
- Enums: PascalCase, members in UPPER_SNAKE_CASE
- Generics: Single uppercase letter (T, K, V) or descriptive PascalCase

```typescript
// Correct
interface User { }
type UserInput = { };
enum Status { ACTIVE, INACTIVE }

// Incorrect
interface IUser { }
type user_input = { };
enum status { active }
```

### Type vs Interface
- Use `interface` for object shapes that may be extended
- Use `type` for unions, intersections, and computed types

```typescript
// Interface for extendable shapes
interface Entity {
  id: string;
  createdAt: Date;
}

interface User extends Entity {
  email: string;
}

// Type for unions and complex types
type Result<T> = { success: true; data: T } | { success: false; error: Error };
type Keys = keyof User;
```

### Avoid `any`
- Use `unknown` instead of `any` when type is truly unknown
- Use generics to preserve type information
- Use type guards to narrow types

```typescript
// Avoid
function process(data: any) { }

// Prefer
function process<T>(data: T): T { }
function process(data: unknown): void {
  if (typeof data === 'string') {
    // data is now string
  }
}
```

## Async Patterns

### Always Await
- Always await promises, never fire-and-forget
- Use `void` operator only when intentionally not awaiting

```typescript
// Correct
await sendEmail(user);

// Intentional fire-and-forget (rare, document why)
void logAnalytics(event);

// Incorrect - unhandled promise
sendEmail(user);
```

### Error Handling
- Use try/catch for expected errors
- Let unexpected errors propagate
- Always type caught errors as `unknown`

```typescript
try {
  await riskyOperation();
} catch (error: unknown) {
  if (error instanceof ValidationError) {
    // Handle known error
  }
  throw error; // Rethrow unknown errors
}
```

## Anti-Patterns

### Avoid
- Using `any` type
- Ignoring TypeScript errors with `@ts-ignore`
- Using `!` non-null assertion without justification
- Empty catch blocks
- Mixing CommonJS and ESM

### When `@ts-ignore` is Acceptable
- Working around library type bugs (with comment explaining why)
- Test files mocking complex types

```typescript
// Acceptable with explanation
// @ts-ignore - Library types don't account for optional chaining
const value = obj?.deeply?.nested?.value;
```

## Related Memories
- `inversify_patterns.md` - Dependency injection with decorators
- `vitest_testing.md` - Testing TypeScript code

# Naming Conventions

## Overview
SOA-specific naming conventions for files, types, classes, and code organization.

## File Naming

### Source Files
- Use kebab-case: `mongo-connection.ts`
- Use `.ts` extension for TypeScript files
- Test files: `*.test.ts` or `*.spec.ts`

### Configuration Files
- Use kebab-case: `tsconfig.json`, `vitest.config.ts`

## Type and Interface Naming

### Interfaces
- **Prefix interfaces with `I`**: `IMongoConnection`, `IUserService`
- Use PascalCase
- Place in separate files from implementations
- File naming: `i-service-name.ts`

```typescript
// interfaces/i-user-service.ts
export interface IUserService {
  getUser(id: string): Promise<User>;
}
```

### Types
- Use PascalCase, no prefix
- Use for unions, intersections, inferred types

```typescript
type ConfigSchema<T extends BaseConfig> = z.ZodType<T>;
type MongoConnectionConfig = z.infer<typeof MongoConnectionSchema>;
```

### Enums
- PascalCase for enum names (singular form)
- PascalCase for enum values

```typescript
enum ConfigEnvironment {
  Development = 'development',
  Production = 'production',
  Testing = 'testing',
}
```

## Class Naming

### Regular Classes
- PascalCase, nouns representing responsibility

```typescript
class ConfigProvider { }
class MongoConnectionManager { }
```

### Abstract Classes
- Prefix with `Abstract`

```typescript
abstract class AbstractConfigProvider<T extends BaseConfig> { }
abstract class AbstractGQLController { }
```

## Method Naming

### Public Methods
- camelCase, verb-based

```typescript
getConfig<T>(schema: ConfigSchema<T>): T
validateConnection(config: IMongoConnection): ValidationResult
buildConnectionString(config: IMongoConnection): string
```

### Private Methods
- Prefix with underscore

```typescript
private _parseEnvironmentVariables(): Record<string, string>
private _validateConfig<T>(config: T): ValidationResult<T>
```

## Variable Naming

### Variables
- camelCase, descriptive nouns

```typescript
const configProvider = new ConfigProvider();
const connectionString = buildConnectionString(config);
```

### Constants
- UPPER_SNAKE_CASE

```typescript
const DEFAULT_PORT = 27017;
const MAX_RETRY_ATTEMPTS = 3;
const CONFIG_PREFIX = 'MONGO_CONNECTION';
```

## Generic Type Parameters

- Single uppercase letters for simple: `T`, `K`, `V`
- Descriptive PascalCase for complex

```typescript
class ConfigProvider<T extends BaseConfig>
interface IRepository<Entity, Id>
type ValidationResult<ConfigType extends BaseConfig>
```

## Package Naming

### npm Packages
- Scoped with `@saga-ed/`
- kebab-case: `@saga-ed/soa-config`, `@saga-ed/soa-db`

### Package Exports
Configure explicit exports in package.json:

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./i-service-name": {
      "types": "./dist/i-service-name.d.ts",
      "default": "./dist/i-service-name.js"
    }
  }
}
```

## Environment Variables
- UPPER_SNAKE_CASE
- Use descriptive prefixes

```
MONGO_CONNECTION_HOST=localhost
MONGO_CONNECTION_PORT=27017
API_BASE_PATH=/saga-soa/v1
```

## Error Classes
- PascalCase, suffix with `Error`

```typescript
class ConfigValidationError extends Error { }
class ConnectionError extends Error { }
```

## File Structure Pattern

```
src/
├── interfaces/
│   └── i-service-name.ts       # Interface and related types only
├── implementations/
│   └── service-name.ts         # Concrete implementation
├── index.ts                    # Main exports
└── __tests__/
    ├── service-name.test.ts    # Implementation tests
    └── mock-service-name.ts    # Mock implementation
```

## Export Pattern

Use type-only exports for interfaces:

```typescript
// index.ts
export type { IServiceName } from './interfaces/i-service-name.js';
export { ServiceName } from './implementations/service-name.js';
```

## Related Memories
- `inversify_patterns.md` - DI naming and structure
- `typescript_conventions.md` - Import and module patterns

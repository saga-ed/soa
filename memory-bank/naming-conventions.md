# TypeScript Naming Conventions

## File Naming

### Source Files

- Use kebab-case for file names: `mongo-connection.ts`
- Use `.ts` extension for TypeScript files
- Use `.test.ts` for test files: `mongo-connection.test.ts`
- Use `.spec.ts` for specification files: `mongo-connection.spec.ts`

### Configuration Files

- Use kebab-case for configuration files: `tsconfig.json`
- Use `.config.ts` for TypeScript configuration files: `jest.config.ts`

## Type and Interface Naming

### Interfaces

- Prefix interfaces with `I`: `IMongoConnection`
- Use PascalCase for interface names
- Use descriptive nouns that represent the contract
- Examples:
  ```typescript
  interface IConfigProvider<T extends BaseConfig>
  interface IMongoConnection extends BaseConfig
  interface IValidationError
  ```

### Types

- Use PascalCase for type names
- Use descriptive nouns that represent the type
- Examples:
  ```typescript
  type ConfigSchema<T extends BaseConfig> = z.ZodType<T>;
  type MongoConnectionConfig = z.infer<typeof MongoConnectionSchema>;
  type ValidationResult<T> = { success: boolean; data?: T; error?: Error };
  ```

### Enums

- Use PascalCase for enum names
- Use singular form for enum names
- Use PascalCase for enum values
- Examples:
  ```typescript
  enum ConfigEnvironment {
    Development = 'development',
    Production = 'production',
    Testing = 'testing',
  }
  ```

## Class Naming

### Classes

- Use PascalCase for class names
- Use nouns that represent the class's responsibility
- Examples:
  ```typescript
  class ConfigProvider
  class MongoConnectionManager
  class ValidationError
  ```

### Abstract Classes

- Prefix abstract classes with `Abstract`: `AbstractConfigProvider`
- Use PascalCase for abstract class names
- Examples:
  ```typescript
  abstract class AbstractConfigProvider<T extends BaseConfig>
  abstract class AbstractConnectionManager
  ```

## Method Naming

### Methods

- Use camelCase for method names
- Use verbs for method names
- Examples:
  ```typescript
  getConfig<T extends BaseConfig>(schema: ConfigSchema<T>): T
  validateConnection(config: IMongoConnection): ValidationResult<IMongoConnection>
  buildConnectionString(config: IMongoConnection): string
  ```

### Private Methods

- Prefix private methods with underscore: `_buildConnectionString`
- Use camelCase for private method names
- Examples:
  ```typescript
  private _parseEnvironmentVariables(): Record<string, string>
  private _validateConfig<T>(config: T): ValidationResult<T>
  ```

## Variable Naming

### Variables

- Use camelCase for variable names
- Use descriptive nouns
- Examples:
  ```typescript
  const configProvider = new ConfigProvider();
  const connectionString = buildConnectionString(config);
  const validationResult = validateConfig(config);
  ```

### Constants

- Use UPPER_SNAKE_CASE for constant values
- Examples:
  ```typescript
  const DEFAULT_PORT = 27017;
  const MAX_RETRY_ATTEMPTS = 3;
  const CONFIG_PREFIX = 'MONGO_CONNECTION';
  ```

## Generic Type Parameters

f

### Generic Types

- Use single uppercase letters for simple generic types: `T`, `K`, `V`
- Use descriptive PascalCase names for complex generic types
- Examples:
  ```typescript
  class ConfigProvider<T extends BaseConfig>
  type ValidationResult<ConfigType extends BaseConfig>
  interface IRepository<Entity, Id>
  ```

## Decorator Naming

### Decorators

- Use camelCase for decorator names
- Use descriptive verbs or adjectives
- Examples:
  ```typescript
  @injectable()
  @configurable()
  @validated()
  ```

## Module Naming

### Module Names

- Use kebab-case for module names in package.json
- Use PascalCase for module names in import statements
- Examples:

  ```typescript
  // package.json
  {
    "name": "@hipponot/config",
    "dependencies": {
      "@hipponot/mongo-connection": "1.0.0"
    }
  }

  // import statements
  import { ConfigProvider  } from '@hipponot/config'
  import { MongoConnection } from '@hipponot/mongo-connection'
  ```

## Environment Variables

### Environment Variable Names

- Use UPPER_SNAKE_CASE for environment variable names
- Use descriptive prefixes based on configuration type
- Examples:
  ```typescript
  MONGO_CONNECTION_HOST = localhost;
  MONGO_CONNECTION_PORT = 27017;
  MONGO_CONNECTION_DATABASE = myapp;
  ```

## Error Types

### Error Classes

- Use PascalCase for error class names
- Suffix with `Error`
- Examples:
  ```typescript
  class ConfigValidationError extends Error
  class ConnectionError extends Error
  class ValidationError extends Error
  ```

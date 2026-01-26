# @saga-ed/config

A strongly-typed configuration management package that uses Zod schemas to validate and type configuration objects. The package provides a flexible way to manage configuration through environment variables with runtime validation.

## Key Features

- Strong TypeScript typing through Zod schemas
- Runtime validation of configuration values
- Environment variable based configuration using dotenv-flow
- Dependency injection ready with Inversify
- Mock configuration support for testing

## Architecture

The configuration system is built around three main concepts:

1. **Zod Schemas**: Define the shape and validation rules for configuration objects
2. **ConfigManager**: Loads and validates configuration based on the schema
3. **Environment Variables**: Source of configuration values (using dotenv-flow)

### Configuration Schema

Each configuration object must define a Zod schema that:

- Includes a `configType` literal field to identify the configuration type
- Specifies validation rules for each configuration field
- Can be used to infer the TypeScript type

Example using the MongoProviderSchema from `@saga-ed/db`:

```typescript
import { z } from 'zod';

export const MongoProviderSchema = z.object({
  configType: z.literal('MONGO'),
  instanceName: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().positive(),
  database: z.string().min(1),
  username: z.string().optional(),
  password: z.string().optional(),
  options: z.record(z.string(), z.any()).optional(),
});

// TypeScript type is inferred from the schema
export type MongoProviderConfig = z.infer<typeof MongoProviderSchema>;
```

### Configuration Manager

The `IConfigManager` interface provides a generic way to load and validate configuration:

```typescript
export interface IConfigManager {
  get<T extends HasConfigType>(schema: ZodObject<T>): z.infer<ZodObject<T>>;
}
```

Two implementations are provided:

1. **DotenvConfigManager**: Loads configuration from environment variables
2. **MockConfigManager**: Generates mock configuration for testing

### Environment Variables

The `DotenvConfigManager` looks for environment variables with names derived from the `configType` and field names. For the MongoProviderSchema example:

```bash
# Environment variables for mongo configuration
MONGO_INSTANCE_NAME=primary
MONGO_HOST=localhost
MONGO_PORT=27017
MONGO_DATABASE=myapp
MONGO_USERNAME=admin
MONGO_PASSWORD=secret
```

## Usage

1. Define your configuration schema:

```typescript
import { z } from 'zod';

export const AppConfigSchema = z.object({
  configType: z.literal('APP'),
  port: z.number().int().positive(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']),
  apiKey: z.string().min(1),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
```

2. Set up environment variables in your `.env` file:

```bash
APP_PORT=3000
APP_LOG_LEVEL=info
APP_API_KEY=your-api-key
```

3. Use the configuration manager:

```typescript
import { Container } from 'inversify';
import { IConfigManager, DotenvConfigManager } from '@saga-ed/config';
import { AppConfigSchema } from './app-config';

// Set up dependency injection
const container = new Container();
container.bind<IConfigManager>('IConfigManager').to(DotenvConfigManager);

// Get configuration
const configManager = container.get<IConfigManager>('IConfigManager');
const config = configManager.get(AppConfigSchema);

// TypeScript knows the type!
console.log(config.port); // number
console.log(config.logLevel); // 'debug' | 'info' | 'warn' | 'error'
```

## Testing

The package includes a `MockConfigManager` that generates valid mock data based on your schema:

```typescript
import { Container } from 'inversify';
import { IConfigManager, MockConfigManager } from '@saga-ed/config';

describe('MyService', () => {
  let container: Container;

  beforeEach(() => {
    container = new Container();
    container.bind<IConfigManager>('IConfigManager').to(MockConfigManager);
  });

  it('should work with mock config', () => {
    const configManager = container.get<IConfigManager>('IConfigManager');
    const config = configManager.get(AppConfigSchema);
    // config will have valid mock values for all fields
  });
});
```

## Error Handling

If validation fails, a `ConfigValidationError` is thrown with details about the validation failure:

```typescript
try {
  const config = configManager.get(AppConfigSchema);
} catch (error) {
  if (error instanceof ConfigValidationError) {
    console.error(`Config validation failed for ${error.configType}`);
    console.error(error.validationError.errors);
  }
}
```

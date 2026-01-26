import { z, ZodObject, ZodRawShape, ZodLiteral } from 'zod';
import dotenvFlow from 'dotenv-flow';
import { injectable } from 'inversify';
import { IConfigManager, HasConfigType } from './i-config-manager.js';
import { ConfigValidationError } from './config-validation-error.js';

@injectable()
export class DotenvConfigManager implements IConfigManager {
  /**
   * Loads and validates configuration from environment variables using the provided Zod object schema.
   * @param schema Zod object schema describing the config shape (must include a configType literal field)
   * @returns Strongly typed config object
   * @throws ConfigValidationError if validation fails
   */
  get<T extends HasConfigType>(schema: ZodObject<T>): z.infer<ZodObject<T>> {
    dotenvFlow.config();
    // Extract configType from schema (assumes a literal field named configType)
    const configType = (schema.shape as any).configType.value as string;
    const prefix = configType.toUpperCase() + '_';
    const env = process.env;
    const input: Record<string, any> = {};

    for (const key in schema.shape) {
      if (key === 'configType') continue;
      const envVar = prefix + key.toUpperCase();
      if (env[envVar] !== undefined) {
        input[key] = env[envVar];
      }
    }
    input.configType = configType;

    try {
      return schema.parse(input);
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new ConfigValidationError(configType, err);
      }
      throw err;
    }
  }
}

@injectable()
export class MockConfigManager implements IConfigManager {
  /**
   * Creates a mock configuration by introspecting the Zod schema and generating random values
   * @param schema Zod object schema describing the config shape
   * @returns Strongly typed config object with mock data
   */
  get<T extends HasConfigType>(schema: ZodObject<T>): z.infer<ZodObject<T>> {
    const configType = (schema.shape as any).configType.value as string;
    const input: Record<string, any> = { configType };

    for (const [key, def] of Object.entries(schema.shape)) {
      if (key === 'configType') continue;

      // Generate mock data based on the Zod type
      if (def instanceof z.ZodString) {
        input[key] = def.minLength || 0 ? 'mock'.padEnd(def.minLength || 3, 'x') : 'mock';
      } else if (def instanceof z.ZodNumber || def instanceof z.ZodEffects) {
        input[key] = '42'; // String for preprocessed numbers
      } else if (def instanceof z.ZodBoolean || def instanceof z.ZodEffects) {
        input[key] = 'true'; // String for preprocessed booleans
      } else if (def instanceof z.ZodEnum) {
        input[key] = def.options[0];
      } else if (def instanceof z.ZodOptional) {
        input[key] = undefined;
      }
    }

    try {
      return schema.parse(input);
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new ConfigValidationError(configType, err);
      }
      throw err;
    }
  }
}

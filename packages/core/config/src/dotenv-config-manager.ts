import 'reflect-metadata';
import { z, ZodObject } from 'zod';
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

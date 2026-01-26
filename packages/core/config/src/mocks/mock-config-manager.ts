import 'reflect-metadata';
import { z, ZodObject } from 'zod';
import { injectable } from 'inversify';
import { IConfigManager, HasConfigType } from '../i-config-manager.js';
import { ConfigValidationError } from '../config-validation-error.js';

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

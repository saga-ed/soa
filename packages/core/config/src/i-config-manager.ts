import { z, ZodObject, ZodRawShape, ZodLiteral } from 'zod';

export type HasConfigType = ZodRawShape & {
  configType: ZodLiteral<any>;
};

export interface IConfigManager {
  /**
   * Loads and validates configuration using the provided Zod object schema.
   * @param schema Zod object schema describing the config shape (must include a configType literal field)
   * @returns Strongly typed config object
   * @throws ConfigValidationError if validation fails
   */
  get<T extends HasConfigType>(schema: ZodObject<T>): z.infer<ZodObject<T>>;
}

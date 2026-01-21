import { z } from 'zod';

export class ConfigValidationError extends Error {
  constructor(
    public readonly configType: string,
    public readonly validationError: z.ZodError
  ) {
    super(`Configuration validation failed for ${configType}`);
    this.name = 'ConfigValidationError';
  }
}

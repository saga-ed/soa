import { z, ZodObject } from 'zod';
import { injectable } from 'inversify';

export const ExpressServerSchema = z.object({
  configType: z.literal('EXPRESS_SERVER'),
  port: z.number().int().positive(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']),
  name: z.string().min(1),
  basePath: z
    .string()
    .optional()
    .transform(val => {
      if (!val) return undefined;
      // Ensure it starts with '/'
      if (!val.startsWith('/')) {
        throw new Error('basePath must start with "/"');
      }
      // Remove trailing slash if present
      return val.endsWith('/') ? val.slice(0, -1) : val;
    }),
});

export type ExpressServerConfig = z.infer<typeof ExpressServerSchema>;

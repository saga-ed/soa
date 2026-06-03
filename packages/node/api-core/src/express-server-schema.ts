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
  corsAllowedDomains: z
    .array(z.string())
    .optional(),
  // CORS `Access-Control-Allow-Headers`. When omitted, defaults to the baseline
  // request headers plus the Datadog RUM tracing headers (see ExpressServer).
  // Set this to override — spread `DATADOG_RUM_TRACING_HEADERS` from
  // `@saga-ed/soa-api-util` to keep Datadog browser RUM working.
  allowedHeaders: z
    .array(z.string())
    .optional(),
});

export type ExpressServerConfig = z.infer<typeof ExpressServerSchema>;

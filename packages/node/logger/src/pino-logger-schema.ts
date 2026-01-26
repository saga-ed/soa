import { z, ZodObject } from 'zod';

export const PinoLoggerSchema = z.object({
  configType: z.literal('PINO_LOGGER'),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  isExpressContext: z.boolean(),
  prettyPrint: z.boolean().optional(),
  logFile: z.string().optional(),
});

export type PinoLoggerConfig = z.infer<typeof PinoLoggerSchema>;

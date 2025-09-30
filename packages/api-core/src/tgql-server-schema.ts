import { z } from 'zod';

export const TGQLServerConfigSchema = z.object({
    configType: z.literal('TGQL_SERVER'),
    mountPoint: z.string().default('/graphql'),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    name: z.string().default('TypeGraphQL API'),
    enablePlayground: z.boolean().default(false),
    playgroundPath: z.string().default('/playground').optional(),
    emitSchema: z.boolean().default(true).optional(),
    schemaDir: z.string().default('./generated').optional(),
});

export type TGQLServerConfig = z.infer<typeof TGQLServerConfigSchema>;
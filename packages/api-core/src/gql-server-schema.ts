import { z } from 'zod';

export const GQLServerConfigSchema = z.object({
    configType: z.literal('GQL_SERVER'),
    mountPoint: z.string().default('/graphql'),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    name: z.string().default('GraphQL API'),
    enablePlayground: z.boolean().default(false),
    playgroundPath: z.string().default('/playground').optional(),
    schemaPatterns: z.array(z.string()).describe('Glob patterns for .gql schema files'),
    emitSchema: z.boolean().default(true).optional(),
    schemaDir: z.string().default('./generated').optional(),
});

export type GQLServerConfig = z.infer<typeof GQLServerConfigSchema>;

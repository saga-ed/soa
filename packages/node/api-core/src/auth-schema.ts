import { z } from 'zod';

export const AuthProviderSchema = z.object({
    type: z.literal('jwt-oidc'),
    jwksUrl: z.string().url(),
    issuer: z.string(),
    audience: z.string().optional(),
    algorithms: z.array(z.string()).optional(),
});

export const AuthConfigSchema = z.object({
    configType: z.literal('AUTH'),
    providers: z.array(AuthProviderSchema).min(1),
    requireAuth: z.boolean().optional().default(false),
    headerName: z.string().optional().default('Authorization'),
    tokenPrefix: z.string().optional().default('Bearer'),
});

export type AuthProviderConfig = z.infer<typeof AuthProviderSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

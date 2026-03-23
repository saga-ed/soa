import { describe, it, expect } from 'vitest';
import { AuthConfigSchema } from '../auth-schema.js';

describe('AuthConfigSchema', () => {
    const validConfig = {
        configType: 'AUTH',
        providers: [{
            type: 'jwt-oidc',
            jwksUrl: 'https://oauth.id.jumpcloud.com/.well-known/jwks.json',
            issuer: 'https://oauth.id.jumpcloud.com',
        }],
    };

    it('should parse a minimal valid config with defaults', () => {
        const result = AuthConfigSchema.parse(validConfig);
        expect(result.configType).toBe('AUTH');
        expect(result.requireAuth).toBe(false);
        expect(result.headerName).toBe('Authorization');
        expect(result.tokenPrefix).toBe('Bearer');
        expect(result.providers).toHaveLength(1);
    });

    it('should parse a full config with all optional fields', () => {
        const result = AuthConfigSchema.parse({
            ...validConfig,
            providers: [{
                type: 'jwt-oidc',
                jwksUrl: 'https://oauth.id.jumpcloud.com/.well-known/jwks.json',
                issuer: 'https://oauth.id.jumpcloud.com',
                audience: 'my-client-id',
                algorithms: ['RS256'],
            }],
            requireAuth: true,
            headerName: 'X-Auth-Token',
            tokenPrefix: 'Token',
        });
        expect(result.requireAuth).toBe(true);
        expect(result.headerName).toBe('X-Auth-Token');
        expect(result.tokenPrefix).toBe('Token');
        expect(result.providers[0]!.audience).toBe('my-client-id');
        expect(result.providers[0]!.algorithms).toEqual(['RS256']);
    });

    it('should accept multiple providers', () => {
        const result = AuthConfigSchema.parse({
            configType: 'AUTH',
            providers: [
                {
                    type: 'jwt-oidc',
                    jwksUrl: 'https://provider1.example.com/.well-known/jwks.json',
                    issuer: 'https://provider1.example.com',
                },
                {
                    type: 'jwt-oidc',
                    jwksUrl: 'https://provider2.example.com/.well-known/jwks.json',
                    issuer: 'https://provider2.example.com',
                    audience: 'client-2',
                },
            ],
        });
        expect(result.providers).toHaveLength(2);
    });

    it('should reject empty providers array', () => {
        expect(() => AuthConfigSchema.parse({
            configType: 'AUTH',
            providers: [],
        })).toThrow();
    });

    it('should reject invalid jwksUrl', () => {
        expect(() => AuthConfigSchema.parse({
            configType: 'AUTH',
            providers: [{
                type: 'jwt-oidc',
                jwksUrl: 'not-a-url',
                issuer: 'https://example.com',
            }],
        })).toThrow();
    });

    it('should reject missing issuer', () => {
        expect(() => AuthConfigSchema.parse({
            configType: 'AUTH',
            providers: [{
                type: 'jwt-oidc',
                jwksUrl: 'https://example.com/.well-known/jwks.json',
            }],
        })).toThrow();
    });

    it('should reject wrong configType', () => {
        expect(() => AuthConfigSchema.parse({
            ...validConfig,
            configType: 'NOT_AUTH',
        })).toThrow();
    });
});

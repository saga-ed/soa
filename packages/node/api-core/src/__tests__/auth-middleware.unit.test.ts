import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'reflect-metadata';
import type { Request, Response, NextFunction } from 'express';
import type { ILogger } from '@saga-ed/soa-logger';
import type { AuthConfig } from '../auth-schema.js';

// Mock jose before importing AuthMiddleware
vi.mock('jose', () => ({
    createRemoteJWKSet: vi.fn(() => 'mock-jwks'),
    jwtVerify: vi.fn(),
}));

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AuthMiddleware } from '../auth-middleware.js';

const mockJwtVerify = vi.mocked(jwtVerify);

function createMockLogger(): ILogger {
    return {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    };
}

function createMockReq(headers: Record<string, string> = {}): Request {
    return { headers } as unknown as Request;
}

function createMockRes(): Response {
    const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
    } as unknown as Response;
    return res;
}

const baseConfig: AuthConfig = {
    configType: 'AUTH',
    providers: [{
        type: 'jwt-oidc',
        jwksUrl: 'https://oauth.id.jumpcloud.com/.well-known/jwks.json',
        issuer: 'https://oauth.id.jumpcloud.com',
    }],
    requireAuth: false,
    headerName: 'Authorization',
    tokenPrefix: 'Bearer',
};

describe('AuthMiddleware', () => {
    let logger: ILogger;

    beforeEach(() => {
        vi.clearAllMocks();
        logger = createMockLogger();
    });

    it('should initialize JWKS sets for each provider', () => {
        new AuthMiddleware(baseConfig, logger);
        expect(createRemoteJWKSet).toHaveBeenCalledWith(
            new URL('https://oauth.id.jumpcloud.com/.well-known/jwks.json')
        );
    });

    describe('no token present', () => {
        it('should pass through with authenticated=false when requireAuth is false', async () => {
            const middleware = new AuthMiddleware(baseConfig, logger);
            const req = createMockReq();
            const res = createMockRes();
            const next = vi.fn();

            await middleware.middleware()(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(req.auth).toEqual({
                authenticated: false,
                claims: null,
                provider: null,
            });
        });

        it('should return 401 when requireAuth is true', async () => {
            const config = { ...baseConfig, requireAuth: true };
            const middleware = new AuthMiddleware(config, logger);
            const req = createMockReq();
            const res = createMockRes();
            const next = vi.fn();

            await middleware.middleware()(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required' });
        });
    });

    describe('valid token', () => {
        it('should set authenticated=true with claims on successful validation', async () => {
            const mockPayload = { sub: 'user-123', iss: 'https://oauth.id.jumpcloud.com' };
            mockJwtVerify.mockResolvedValueOnce({
                payload: mockPayload,
                protectedHeader: { alg: 'RS256' },
            } as any);

            const middleware = new AuthMiddleware(baseConfig, logger);
            const req = createMockReq({ authorization: 'Bearer valid-token' });
            const res = createMockRes();
            const next = vi.fn();

            await middleware.middleware()(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(req.auth).toEqual({
                authenticated: true,
                claims: mockPayload,
                provider: 'jwt-oidc',
            });
            expect(mockJwtVerify).toHaveBeenCalledWith('valid-token', 'mock-jwks', {
                issuer: 'https://oauth.id.jumpcloud.com',
                audience: undefined,
                algorithms: undefined,
            });
        });

        it('should pass audience and algorithms to jwtVerify when configured', async () => {
            const config: AuthConfig = {
                ...baseConfig,
                providers: [{
                    type: 'jwt-oidc',
                    jwksUrl: 'https://oauth.id.jumpcloud.com/.well-known/jwks.json',
                    issuer: 'https://oauth.id.jumpcloud.com',
                    audience: 'my-client-id',
                    algorithms: ['RS256', 'RS384'],
                }],
            };
            mockJwtVerify.mockResolvedValueOnce({
                payload: { sub: 'user-123' },
                protectedHeader: { alg: 'RS256' },
            } as any);

            const middleware = new AuthMiddleware(config, logger);
            const req = createMockReq({ authorization: 'Bearer valid-token' });
            const res = createMockRes();
            const next = vi.fn();

            await middleware.middleware()(req, res, next);

            expect(mockJwtVerify).toHaveBeenCalledWith('valid-token', 'mock-jwks', {
                issuer: 'https://oauth.id.jumpcloud.com',
                audience: 'my-client-id',
                algorithms: ['RS256', 'RS384'],
            });
        });
    });

    describe('invalid token', () => {
        it('should pass through with error when requireAuth is false', async () => {
            mockJwtVerify.mockRejectedValueOnce(new Error('invalid signature'));

            const middleware = new AuthMiddleware(baseConfig, logger);
            const req = createMockReq({ authorization: 'Bearer bad-token' });
            const res = createMockRes();
            const next = vi.fn();

            await middleware.middleware()(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(req.auth).toEqual({
                authenticated: false,
                claims: null,
                provider: null,
                error: 'Token validation failed',
            });
        });

        it('should return 401 when requireAuth is true', async () => {
            mockJwtVerify.mockRejectedValueOnce(new Error('invalid signature'));

            const config = { ...baseConfig, requireAuth: true };
            const middleware = new AuthMiddleware(config, logger);
            const req = createMockReq({ authorization: 'Bearer bad-token' });
            const res = createMockRes();
            const next = vi.fn();

            await middleware.middleware()(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token' });
        });
    });

    describe('provider fallback chain', () => {
        it('should try second provider when first fails', async () => {
            const config: AuthConfig = {
                ...baseConfig,
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
                    },
                ],
            };

            const mockPayload = { sub: 'user-456', iss: 'https://provider2.example.com' };
            mockJwtVerify
                .mockRejectedValueOnce(new Error('wrong issuer'))
                .mockResolvedValueOnce({
                    payload: mockPayload,
                    protectedHeader: { alg: 'RS256' },
                } as any);

            const middleware = new AuthMiddleware(config, logger);
            const req = createMockReq({ authorization: 'Bearer some-token' });
            const res = createMockRes();
            const next = vi.fn();

            await middleware.middleware()(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(req.auth).toEqual({
                authenticated: true,
                claims: mockPayload,
                provider: 'jwt-oidc',
            });
            expect(mockJwtVerify).toHaveBeenCalledTimes(2);
        });

        it('should fail when all providers reject', async () => {
            const config: AuthConfig = {
                ...baseConfig,
                requireAuth: true,
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
                    },
                ],
            };

            mockJwtVerify
                .mockRejectedValueOnce(new Error('fail 1'))
                .mockRejectedValueOnce(new Error('fail 2'));

            const middleware = new AuthMiddleware(config, logger);
            const req = createMockReq({ authorization: 'Bearer bad-token' });
            const res = createMockRes();
            const next = vi.fn();

            await middleware.middleware()(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(401);
            expect(mockJwtVerify).toHaveBeenCalledTimes(2);
        });
    });

    describe('token extraction', () => {
        it('should ignore non-Bearer prefix', async () => {
            const middleware = new AuthMiddleware(baseConfig, logger);
            const req = createMockReq({ authorization: 'Basic dXNlcjpwYXNz' });
            const res = createMockRes();
            const next = vi.fn();

            await middleware.middleware()(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(req.auth?.authenticated).toBe(false);
            expect(mockJwtVerify).not.toHaveBeenCalled();
        });

        it('should support custom header and prefix', async () => {
            const config: AuthConfig = {
                ...baseConfig,
                headerName: 'X-Auth-Token',
                tokenPrefix: 'Token',
            };
            mockJwtVerify.mockResolvedValueOnce({
                payload: { sub: 'user-789' },
                protectedHeader: { alg: 'RS256' },
            } as any);

            const middleware = new AuthMiddleware(config, logger);
            const req = createMockReq({ 'x-auth-token': 'Token my-custom-token' });
            const res = createMockRes();
            const next = vi.fn();

            await middleware.middleware()(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(req.auth?.authenticated).toBe(true);
            expect(mockJwtVerify).toHaveBeenCalledWith('my-custom-token', 'mock-jwks', expect.any(Object));
        });
    });
});

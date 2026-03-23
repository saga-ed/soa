import { injectable, inject } from 'inversify';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { RequestHandler, Request, Response, NextFunction } from 'express';
import type { ILogger } from '@saga-ed/soa-logger';
import type { AuthConfig, AuthProviderConfig } from './auth-schema.js';
import type { AuthContext } from './auth-types.js';

@injectable()
export class AuthMiddleware {
    private jwksSets: Map<string, ReturnType<typeof createRemoteJWKSet>>;

    constructor(
        @inject('AuthConfig') private config: AuthConfig,
        @inject('ILogger') private logger: ILogger
    ) {
        this.jwksSets = new Map();
        for (const provider of config.providers) {
            this.jwksSets.set(
                provider.jwksUrl,
                createRemoteJWKSet(new URL(provider.jwksUrl))
            );
        }
    }

    public middleware(): RequestHandler {
        return async (req: Request, res: Response, next: NextFunction) => {
            const token = this.extractToken(req);

            if (!token) {
                req.auth = { authenticated: false, claims: null, provider: null };
                if (this.config.requireAuth) {
                    res.status(401).json({ error: 'Authentication required' });
                    return;
                }
                return next();
            }

            for (const provider of this.config.providers) {
                const result = await this.tryProvider(token, provider);
                if (result) {
                    req.auth = result;
                    return next();
                }
            }

            req.auth = { authenticated: false, claims: null, provider: null, error: 'Token validation failed' };
            if (this.config.requireAuth) {
                res.status(401).json({ error: 'Invalid token' });
                return;
            }
            return next();
        };
    }

    private async tryProvider(token: string, provider: AuthProviderConfig): Promise<AuthContext | null> {
        try {
            const jwks = this.jwksSets.get(provider.jwksUrl)!;
            const { payload } = await jwtVerify(token, jwks, {
                issuer: provider.issuer,
                audience: provider.audience,
                algorithms: provider.algorithms,
            });
            return { authenticated: true, claims: payload, provider: provider.type };
        } catch (err) {
            this.logger.debug(`Auth provider ${provider.issuer} rejected token: ${err}`);
            return null;
        }
    }

    private extractToken(req: Request): string | null {
        const header = req.headers[this.config.headerName.toLowerCase()];
        if (!header || typeof header !== 'string') return null;
        const prefix = `${this.config.tokenPrefix} `;
        if (!header.startsWith(prefix)) return null;
        return header.slice(prefix.length);
    }
}

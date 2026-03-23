import type { JWTPayload } from 'jose';

export interface AuthContext {
    authenticated: boolean;
    claims: JWTPayload | null;
    provider: string | null;
    error?: string;
}

declare global {
    namespace Express {
        interface Request {
            auth?: AuthContext;
        }
    }
}

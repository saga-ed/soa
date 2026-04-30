export { COOKIE_NAME, ISSUER, AUDIENCE, JanusClaimsSchema } from './claims.js';
export type { JanusClaims } from './claims.js';

export { mintJanusToken, DEFAULT_TTL_SECONDS } from './mint.js';
export type { MintInput, MinterConfig } from './mint.js';

export { createVerifier } from './verify.js';
export type { Verifier, VerifierConfig } from './verify.js';

export { createJwksResolver } from './jwks.js';
export type { JwksResolverConfig } from './jwks.js';

export { setJanusCookieHeader, clearJanusCookieHeader, readJanusCookie } from './cookie.js';
export type { CookieDomainOptions } from './cookie.js';

export { createJanusAuth } from './middleware.js';
export type { JanusAuth, JanusAuthConfig, RequireOptions } from './middleware.js';

export { JanusVerifyError } from './errors.js';
export type { VerifyResult, VerifyFailure } from './errors.js';

import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { JanusClaims } from './claims.js';
import { readJanusCookie } from './cookie.js';
import { createVerifier, type Verifier, type VerifierConfig } from './verify.js';

export interface JanusAuthConfig extends VerifierConfig {
  /**
   * If false, `require()` becomes a no-op and `context()` skips verification.
   * Default reads `JANUS_REQUIRED` env (true unless explicitly "false").
   */
  required?: boolean;
  /** Login URL the 401 hint points at. Default reads `JANUS_LOGIN_URL`, fallback `https://login.wootdev.com`. */
  loginUrl?: string;
}

export interface RequireOptions {
  /** Permissions that must all be present in the token's `permissions` claim. */
  permissions?: string[];
}

const als = new AsyncLocalStorage<JanusClaims>();

export interface JanusAuth {
  context(): RequestHandler;
  require(opts?: RequireOptions): RequestHandler;
  /** Returns the claims for the current request, or null if unauthenticated. */
  current(): JanusClaims | null;
  /** Underlying verifier — exposed for advanced use. */
  verifier: Verifier;
}

export function createJanusAuth(config: JanusAuthConfig = defaultConfig()): JanusAuth {
  const required = config.required ?? readRequiredEnv();
  const loginUrl = config.loginUrl ?? process.env.JANUS_LOGIN_URL ?? 'https://login.wootdev.com';
  const verifier = createVerifier(config);

  function context(): RequestHandler {
    return async (req: Request, _res: Response, next: NextFunction) => {
      if (!required) return next();
      const token = readJanusCookie(req.headers.cookie);
      if (!token) return next();
      const result = await verifier.verify(token);
      if (!result.ok) return next();
      als.run(result.claims, () => next());
    };
  }

  function require(opts: RequireOptions = {}): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!required) return next();
      const claims = als.getStore() ?? null;
      if (!claims) return reject(req, res, loginUrl, 'unauthenticated');
      if (opts.permissions?.length) {
        const missing = opts.permissions.filter((p) => !claims.permissions.includes(p));
        if (missing.length) return reject(req, res, loginUrl, 'insufficient_tier');
      }
      next();
    };
  }

  function current(): JanusClaims | null {
    return als.getStore() ?? null;
  }

  return { context, require, current, verifier };
}

function reject(req: Request, res: Response, loginUrl: string, reason: string): void {
  const reqUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const next = encodeURIComponent(reqUrl);
  const login = `${loginUrl.replace(/\/$/, '')}/?next=${next}&reasons=${reason}`;
  res.setHeader('WWW-Authenticate', `Janus realm="wootdev", login="${login}"`);
  res.status(401).json({ error: 'unauthenticated', login });
}

function defaultConfig(): JanusAuthConfig {
  return {
    jwksUrl: process.env.JANUS_JWKS_URL ?? 'https://gate.wootdev.com/.well-known/jwks.json',
  };
}

function readRequiredEnv(): boolean {
  const raw = process.env.JANUS_REQUIRED;
  if (raw === undefined) return true;
  return raw.toLowerCase() !== 'false';
}

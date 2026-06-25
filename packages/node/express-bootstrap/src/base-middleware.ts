import express, { type Express } from 'express';
import cors, { type CorsOptions } from 'cors';
import helmet, { type HelmetOptions } from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import {
  buildSagaOriginAllowlist,
  originAllowed,
  DATADOG_RUM_TRACING_HEADERS,
} from '@saga-ed/soa-api-util';
import type { BootstrapLogger } from './types.js';
import { requestIdLogger } from './request-logger.js';

export interface SagaCorsOptions {
  /** Env source for the allowlist; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * Extra explicit origins allowed in NON-production only (e.g. local dev
   * servers `http://localhost:5173`). Never trusted in prod. Passed straight
   * through to {@link buildSagaOriginAllowlist}.
   */
  devOrigins?: readonly string[];
  /** Extra request headers to allow, merged with content-type + Datadog RUM headers. */
  allowedHeaders?: readonly string[];
  /** Extra response headers to expose, merged with x-request-id + WWW-Authenticate. */
  exposedHeaders?: readonly string[];
}

/**
 * Build `cors` options around the canonical env-isolated Saga origin allowlist
 * (`@saga-ed/soa-api-util`). Replaces the hand-rolled `VALID_DOMAINS` +
 * `endsWith` allowlist every browser-facing service grew its own copy of.
 *
 * - No-origin requests (server-to-server, curl) are allowed.
 * - `WWW-Authenticate` is exposed so the dash/connect SagaAuth interceptor can
 *   read the `realm="janus"` challenge cross-origin and drive the login redirect.
 */
export function buildSagaCorsOptions(opts: SagaCorsOptions = {}): CorsOptions {
  const allowlist = buildSagaOriginAllowlist({
    env: opts.env,
    devOrigins: opts.devOrigins,
  });
  return {
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      return originAllowed(allowlist, origin)
        ? cb(null, true)
        : cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
    allowedHeaders: [
      'content-type',
      ...DATADOG_RUM_TRACING_HEADERS,
      ...(opts.allowedHeaders ?? []),
    ],
    exposedHeaders: [
      'x-request-id',
      'WWW-Authenticate',
      ...(opts.exposedHeaders ?? []),
    ],
  };
}

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  /** Path prefixes exempt from rate limiting. Defaults to `['/health']`. */
  skipPaths?: readonly string[];
}

export interface BaseMiddlewareOptions {
  logger: BootstrapLogger;
  /** CORS config, or `false` to skip the cors middleware entirely. */
  cors?: SagaCorsOptions | false;
  /** Rate-limit config, or `false` to skip. */
  rateLimit?: RateLimitOptions | false;
  /** JSON body size limit. Defaults to `'1mb'`. */
  jsonBodyLimit?: string;
  /**
   * Helmet options, or `false` to skip. Defaults to a strict CSP
   * (`defaultSrc: ["'none'"]`) — appropriate for JSON APIs that serve no HTML.
   */
  helmet?: HelmetOptions | false;
  /** Mount `cookie-parser`. Defaults to `true`. */
  cookies?: boolean;
  /** Mount the request-id access logger. Defaults to `true`. */
  requestLogger?: boolean;
}

/**
 * Apply the security + parsing middleware stack every SOA Express service
 * shares, in the canonical order:
 *
 *   helmet → rate-limit (skips `/health`) → cors → json → cookies → request-log
 *
 * Mutates `app` in place. Leaves all domain wiring (auth perimeter, tRPC,
 * GraphQL, REST routers, health routes) to the caller — this is the floor,
 * not the whole house.
 */
export function applyBaseMiddleware(
  app: Express,
  opts: BaseMiddlewareOptions,
): void {
  if (opts.helmet !== false) {
    app.use(
      helmet(
        opts.helmet ?? {
          contentSecurityPolicy: { directives: { defaultSrc: ["'none'"] } },
        },
      ),
    );
  }

  if (opts.rateLimit !== false && opts.rateLimit) {
    const skipPaths = opts.rateLimit.skipPaths ?? ['/health'];
    app.use(
      rateLimit({
        windowMs: opts.rateLimit.windowMs,
        max: opts.rateLimit.maxRequests,
        skip: (req) => skipPaths.some((p) => req.path.startsWith(p)),
        standardHeaders: true,
        legacyHeaders: false,
      }),
    );
  }

  if (opts.cors !== false) {
    app.use(cors(buildSagaCorsOptions(opts.cors ?? {})));
  }

  app.use(express.json({ limit: opts.jsonBodyLimit ?? '1mb' }));

  if (opts.cookies !== false) {
    app.use(cookieParser());
  }

  if (opts.requestLogger !== false) {
    app.use(requestIdLogger(opts.logger));
  }
}

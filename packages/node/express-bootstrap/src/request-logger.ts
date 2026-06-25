import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { BootstrapLogger } from './types.js';

/**
 * Request-id + access-log middleware.
 *
 * Honours an inbound `x-request-id` (so a request keeps its id across the mesh)
 * or mints one, echoes it on the response, and logs a single structured line on
 * response finish with method / path / status / duration. Every SOA service
 * re-implemented a variant of this; this is the lowest-common-denominator
 * version — apps that need GraphQL-operation extraction or sample-rate
 * suppression can still layer their own.
 */
export function requestIdLogger(logger: BootstrapLogger): RequestHandler {
  return (req, res, next) => {
    const inbound = req.headers['x-request-id'];
    const requestId =
      (Array.isArray(inbound) ? inbound[0] : inbound) ?? randomUUID();
    res.setHeader('x-request-id', requestId);

    const start = Date.now();
    res.on('finish', () => {
      logger.info('request', {
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - start,
      });
    });

    next();
  };
}

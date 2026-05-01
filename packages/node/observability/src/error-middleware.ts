import type { ErrorRequestHandler } from 'express';
import type { ILogger } from '@saga-ed/soa-logger';

/**
 * Express error middleware that routes `next(err)` calls through the
 * structured logger instead of falling back to `finalhandler` / console.error.
 *
 * Without this, errors from any route's `next(err)` (snapshot endpoints,
 * /metrics, enrollment-readiness) get serialized to raw stderr, bypassing
 * the Pino JSON pipeline and any centralized log aggregation.
 *
 * Register AFTER all routes via `app.use(structuredErrorMiddleware(logger))`.
 */
export function structuredErrorMiddleware(logger: ILogger): ErrorRequestHandler {
    return (err, req, res, _next) => {
        logger.error(
            `unhandled error on ${req.method} ${req.originalUrl}`,
            err instanceof Error ? err : new Error(String(err)),
        );
        if (res.headersSent) {
            return;
        }
        res.status(500).json({ error: 'internal server error' });
    };
}

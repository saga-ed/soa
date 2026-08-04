import type { ErrorRequestHandler } from 'express';
import type { ILogger } from '@saga-ed/soa-logger';
import { recordSpanException } from './record-exception.js';

/**
 * Express error middleware that routes `next(err)` calls through the
 * structured logger instead of falling back to `finalhandler` / console.error,
 * and attaches the exception to the active span so the trace carries
 * `error.type` / `error.message` / `error.stack`.
 *
 * Without this, errors from any route's `next(err)` (snapshot endpoints,
 * /metrics, enrollment-readiness) get serialized to raw stderr, bypassing
 * the Pino JSON pipeline and any centralized log aggregation — and the
 * corresponding span reaches Datadog flagged as an error but empty, since
 * OTel derives the error flag from the status code alone.
 *
 * Register AFTER all routes via `app.use(structuredErrorMiddleware(logger))`.
 */
export function structuredErrorMiddleware(logger: ILogger): ErrorRequestHandler {
    return (err, req, res, _next) => {
        recordSpanException(err);
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

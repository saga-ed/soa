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
        // Everything before the response is best-effort. A throw here would be
        // a throw from inside an error handler, which Express hands to
        // `finalhandler` — the client would get a raw stack trace instead of
        // the opaque 500 below, and the error would never reach the log
        // pipeline. `String(err)` alone can throw, for a null-prototype object
        // or a poisoned `toString`, so the coercion must be guarded too.
        try {
            recordSpanException(err);
            logger.error(
                `unhandled error on ${req.method} ${req.originalUrl}`,
                toError(err),
            );
        } catch {
            // Nothing safe left to log with — the logger or the value itself is
            // the thing that failed. Still send the response below.
        }

        if (res.headersSent) {
            return;
        }
        res.status(500).json({ error: 'internal server error' });
    };
}

function toError(err: unknown): Error {
    if (err instanceof Error) {
        return err;
    }
    try {
        return new Error(String(err));
    } catch {
        return new Error('unstringifiable thrown value');
    }
}

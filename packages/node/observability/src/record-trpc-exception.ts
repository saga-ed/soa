import { recordSpanException } from './record-exception.js';

/**
 * Structural subset of tRPC's `onError`/`errorFormatter` `error` argument.
 * Kept duck-typed rather than importing `@trpc/server` (this package has no
 * dependency on it today, and a version mismatch across the monorepo would
 * silently defeat an `instanceof TRPCError` check anyway — see programs-api's
 * `findUpstreamRateLimit` for the same reasoning applied to `TRPCClientError`).
 */
export interface TRPCFormattableError {
    code: string;
    cause?: unknown;
}

/**
 * Record a tRPC procedure's error on the active span — call this from your
 * service's `createExpressMiddleware({ onError })` (or `errorFormatter`):
 *
 *   onError({ error, path }) {
 *       recordTRPCSpanException(error);
 *       logger.error(`tRPC error on ${path ?? 'unknown'}`, error);
 *   }
 *
 * Only `INTERNAL_SERVER_ERROR` is recorded, and only when its `cause` isn't
 * itself a TRPCError-shaped object. Recording every tRPC error unfiltered
 * would tag routine client faults (UNAUTHORIZED, BAD_REQUEST, NOT_FOUND,
 * CONFLICT, ...) as span exceptions and Error Tracking / error-rate monitors
 * would fire on auth rejections and validation failures instead of real bugs.
 * The cause check excludes the "expected 500" pattern some services use to
 * preserve a message through a scrubbing errorFormatter (wrapping the real
 * cause in a second TRPCError) — that shape is a deliberate, already-classified
 * error, not an unhandled one.
 */
export function recordTRPCSpanException(error: TRPCFormattableError): void {
    if (error.code !== 'INTERNAL_SERVER_ERROR') {
        return;
    }
    if (isTRPCErrorShaped(error.cause)) {
        return;
    }
    recordSpanException(error.cause ?? error);
}

function isTRPCErrorShaped(value: unknown): value is { code: string } {
    return (
        typeof value === 'object' &&
        value !== null &&
        'code' in value &&
        typeof (value as { code?: unknown }).code === 'string'
    );
}

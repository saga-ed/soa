import { recordTRPCSpanException, type TRPCFormattableError } from './record-trpc-exception.js';

export interface TRPCErrorLogSink {
    warn(message: string): void;
    error(message: string, error?: Error): void;
}

export interface TRPCOnErrorOpts {
    error: TRPCFormattableError & { message: string };
    path?: string;
    /** The transport request; keys the once-per-request dedupe. */
    req?: unknown;
}

/** Client-fault codes logged at warn — an expired session is not a service error. */
export const TRPC_WARN_CODES: ReadonlySet<string> = new Set(['UNAUTHORIZED', 'FORBIDDEN']);

/**
 * Builds a tRPC `onError` that records span exceptions and logs each error.
 *
 *   createExpressMiddleware({ router, createContext, onError: createTRPCErrorLogger(logger) })
 *
 * Codes in `warnCodes` log at warn, at most once per request per code: tRPC
 * calls `onError` once per procedure, so one rejected batch is otherwise N lines.
 * Every other code logs at error, once per procedure, with the underlying cause.
 */
export function createTRPCErrorLogger(
    logger: TRPCErrorLogSink,
    warnCodes: ReadonlySet<string> = TRPC_WARN_CODES,
): (opts: TRPCOnErrorOpts) => void {
    const seen = new WeakMap<object, Set<string>>();

    return ({ error, path, req }) => {
        recordTRPCSpanException(error);
        const where = path ?? 'unknown';

        if (warnCodes.has(error.code)) {
            if (typeof req === 'object' && req !== null) {
                let codes = seen.get(req);
                if (!codes) {
                    codes = new Set();
                    seen.set(req, codes);
                }
                if (codes.has(error.code)) return;
                codes.add(error.code);
            }
            logger.warn(`tRPC ${error.code} on ${where}: ${error.message}`);
            return;
        }

        const underlying = error.cause instanceof Error ? error.cause : error;
        logger.error(
            `tRPC error on ${where} [${error.code}]: ${error.message}`,
            underlying instanceof Error ? underlying : undefined,
        );
    };
}

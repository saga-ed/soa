import { recordTRPCSpanException, type TRPCFormattableError } from './record-trpc-exception.js';

export interface TRPCErrorLogSink {
    error(message: string, error?: Error): void;
}

export interface TRPCOnErrorOpts {
    error: TRPCFormattableError & { message: string };
    path?: string;
    /** The transport request; keys the once-per-request dedupe. */
    req?: unknown;
}

/** Codes logged once per request: a rejected batch fails every procedure the same way. */
export const TRPC_PER_REQUEST_CODES: ReadonlySet<string> = new Set(['UNAUTHORIZED', 'FORBIDDEN']);

/**
 * Builds a tRPC `onError` that records span exceptions and logs each error.
 *
 *   createExpressMiddleware({ router, createContext, onError: createTRPCErrorLogger(logger) })
 *
 * Codes in `perRequestCodes` log at most once per request per code: tRPC calls
 * `onError` once per procedure, so one rejected batch is otherwise N lines.
 * Every other code logs once per procedure, with the underlying cause.
 */
export function createTRPCErrorLogger(
    logger: TRPCErrorLogSink,
    perRequestCodes: ReadonlySet<string> = TRPC_PER_REQUEST_CODES,
): (opts: TRPCOnErrorOpts) => void {
    const seen = new WeakMap<object, Set<string>>();

    return ({ error, path, req }) => {
        recordTRPCSpanException(error);

        if (perRequestCodes.has(error.code) && typeof req === 'object' && req !== null) {
            let codes = seen.get(req);
            if (!codes) {
                codes = new Set();
                seen.set(req, codes);
            }
            if (codes.has(error.code)) return;
            codes.add(error.code);
        }

        const underlying = error.cause instanceof Error ? error.cause : error;
        logger.error(
            `tRPC error on ${path ?? 'unknown'} [${error.code}]: ${error.message}`,
            underlying instanceof Error ? underlying : undefined,
        );
    };
}

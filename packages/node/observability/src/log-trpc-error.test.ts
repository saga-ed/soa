import { describe, it, expect, vi, afterEach } from 'vitest';
import { trace, type Span } from '@opentelemetry/api';
import { createTRPCErrorLogger } from './log-trpc-error.js';

function sink() {
    return { error: vi.fn() };
}

function trpcError(code: string, message = 'boom', cause?: unknown) {
    return Object.assign(new Error(message), { name: 'TRPCError', code, cause });
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('createTRPCErrorLogger', () => {
    it('logs UNAUTHORIZED once per request across a batch', () => {
        const log = sink();
        const onError = createTRPCErrorLogger(log);
        const req = {};
        const err = trpcError('UNAUTHORIZED', 'Authentication required');

        onError({ error: err, path: 'pods.list', req });
        onError({ error: err, path: 'pods.list', req });
        onError({ error: err, path: 'periods.list', req });

        expect(log.error).toHaveBeenCalledTimes(1);
        expect(log.error).toHaveBeenCalledWith(
            'tRPC error on pods.list [UNAUTHORIZED]: Authentication required',
            err,
        );
    });

    it('logs each per-request code once per request, and again for a new request', () => {
        const log = sink();
        const onError = createTRPCErrorLogger(log);
        const req = {};

        onError({ error: trpcError('UNAUTHORIZED'), path: 'a', req });
        onError({ error: trpcError('FORBIDDEN'), path: 'b', req });
        onError({ error: trpcError('UNAUTHORIZED'), path: 'a', req: {} });

        expect(log.error).toHaveBeenCalledTimes(3);
    });

    it('logs every call when no request is supplied', () => {
        const log = sink();
        const onError = createTRPCErrorLogger(log);

        onError({ error: trpcError('FORBIDDEN'), path: 'a' });
        onError({ error: trpcError('FORBIDDEN'), path: 'a' });

        expect(log.error).toHaveBeenCalledTimes(2);
    });

    it('logs other codes per procedure with the underlying cause', () => {
        const log = sink();
        const onError = createTRPCErrorLogger(log);
        const req = {};
        const cause = new Error('db down');

        onError({ error: trpcError('INTERNAL_SERVER_ERROR', 'oops', cause), path: 'a', req });
        onError({ error: trpcError('BAD_REQUEST', 'bad'), path: 'b', req });
        onError({ error: trpcError('BAD_REQUEST', 'bad'), path: 'c', req });

        expect(log.error).toHaveBeenCalledTimes(3);
        expect(log.error).toHaveBeenNthCalledWith(1, 'tRPC error on a [INTERNAL_SERVER_ERROR]: oops', cause);
    });

    it('honours a custom per-request code set', () => {
        const log = sink();
        const onError = createTRPCErrorLogger(log, new Set(['NOT_FOUND']));
        const req = {};

        onError({ error: trpcError('NOT_FOUND'), path: 'a', req });
        onError({ error: trpcError('NOT_FOUND'), path: 'b', req });
        onError({ error: trpcError('UNAUTHORIZED'), path: 'a', req });
        onError({ error: trpcError('UNAUTHORIZED'), path: 'b', req });

        expect(log.error).toHaveBeenCalledTimes(3);
    });

    it('records unexpected INTERNAL_SERVER_ERRORs on the active span', () => {
        const span = { recordException: vi.fn(), setStatus: vi.fn() } as unknown as Span;
        vi.spyOn(trace, 'getActiveSpan').mockReturnValue(span);
        const onError = createTRPCErrorLogger(sink());

        onError({ error: trpcError('INTERNAL_SERVER_ERROR', 'oops', new Error('db')), path: 'a' });
        onError({ error: trpcError('UNAUTHORIZED'), path: 'a' });

        expect(span.recordException).toHaveBeenCalledTimes(1);
    });
});

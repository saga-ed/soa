import { describe, it, expect, vi, afterEach } from 'vitest';
import { trace, type Span } from '@opentelemetry/api';
import { recordTRPCSpanException } from './record-trpc-exception.js';

type SpyingSpan = Span & {
    recordException: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
};

function fakeSpan(): SpyingSpan {
    return {
        recordException: vi.fn(),
        setStatus: vi.fn(),
    } as unknown as SpyingSpan;
}

function withActiveSpan(span: Span | undefined) {
    return vi.spyOn(trace, 'getActiveSpan').mockReturnValue(span);
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('recordTRPCSpanException', () => {
    it('records an unexpected INTERNAL_SERVER_ERROR with no cause', () => {
        const span = fakeSpan();
        withActiveSpan(span);

        recordTRPCSpanException({ code: 'INTERNAL_SERVER_ERROR' });

        expect(span.recordException).toHaveBeenCalledTimes(1);
    });

    it('records an unexpected INTERNAL_SERVER_ERROR whose cause is a plain Error', () => {
        const span = fakeSpan();
        withActiveSpan(span);
        const cause = new TypeError('db connection reset');

        recordTRPCSpanException({ code: 'INTERNAL_SERVER_ERROR', cause });

        expect(span.recordException).toHaveBeenCalledTimes(1);
        const recorded = span.recordException.mock.calls[0]![0] as Error;
        expect(recorded.message).toBe('db connection reset');
    });

    it.each(['UNAUTHORIZED', 'BAD_REQUEST', 'NOT_FOUND', 'CONFLICT', 'FORBIDDEN', 'TOO_MANY_REQUESTS'])(
        'does not record a client-fault code (%s)',
        (code) => {
            const span = fakeSpan();
            withActiveSpan(span);

            recordTRPCSpanException({ code });

            expect(span.recordException).not.toHaveBeenCalled();
        },
    );

    it('does not record an "expected 500" whose cause is itself TRPCError-shaped', () => {
        const span = fakeSpan();
        withActiveSpan(span);

        // Mirrors programs-api's throwServiceError pattern: the real cause is
        // wrapped in a second *real* TRPCError instance (name: 'TRPCError') to
        // survive a scrubbing errorFormatter — that wrap marks the error as
        // already classified.
        recordTRPCSpanException({
            code: 'INTERNAL_SERVER_ERROR',
            cause: Object.assign(new Error('heal via retry'), {
                name: 'TRPCError',
                code: 'INTERNAL_SERVER_ERROR',
            }),
        });

        expect(span.recordException).not.toHaveBeenCalled();
    });

    it('records an unexpected INTERNAL_SERVER_ERROR whose cause carries a non-tRPC error code', () => {
        // Prisma (P2002), pg (SQLSTATE), and Node system errors (ECONNREFUSED)
        // all carry a string `.code` without ever going through tRPC's
        // classification — they must not be mistaken for the "expected 500"
        // TRPCError-wrapping pattern above.
        const span = fakeSpan();
        withActiveSpan(span);

        recordTRPCSpanException({
            code: 'INTERNAL_SERVER_ERROR',
            cause: Object.assign(new Error('connect ECONNREFUSED 10.0.1.5:5432'), {
                code: 'ECONNREFUSED',
            }),
        });

        expect(span.recordException).toHaveBeenCalledTimes(1);
    });

    it('no-ops when no span is active', () => {
        withActiveSpan(undefined);

        expect(() =>
            recordTRPCSpanException({ code: 'INTERNAL_SERVER_ERROR', cause: new Error('x') }),
        ).not.toThrow();
    });
});

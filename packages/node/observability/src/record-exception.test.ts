import { describe, it, expect, vi, afterEach } from 'vitest';
import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { recordSpanException } from './record-exception.js';
import { structuredErrorMiddleware } from './error-middleware.js';

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

/**
 * Stub the active span rather than using `context.with`: no ContextManager is
 * registered in unit tests (that is the SDK's job at runtime), so the real
 * context API would return undefined and the assertion would be vacuous.
 */
function withActiveSpan(span: Span | undefined) {
    return vi.spyOn(trace, 'getActiveSpan').mockReturnValue(span);
}

function recordedError(span: SpyingSpan): Error {
    return span.recordException.mock.calls[0]![0] as Error;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('recordSpanException', () => {
    it('records the exception and sets ERROR status', () => {
        const span = fakeSpan();

        recordSpanException(new TypeError('kaboom'), span);

        expect(span.recordException).toHaveBeenCalledTimes(1);
        const recorded = recordedError(span);
        expect(recorded.name).toBe('TypeError');
        expect(recorded.message).toBe('kaboom');
        expect(recorded.stack).toContain('TypeError: kaboom');

        expect(span.setStatus).toHaveBeenCalledWith({
            code: SpanStatusCode.ERROR,
            message: 'kaboom',
        });
    });

    it('wraps non-Error throws so type/message/stack still land', () => {
        const span = fakeSpan();

        recordSpanException('just a string', span);

        const recorded = recordedError(span);
        expect(recorded.message).toBe('just a string');
        expect(recorded.stack).toBeDefined();
    });

    it('no-ops when no span is active and none is passed', () => {
        withActiveSpan(undefined);

        expect(() => recordSpanException(new Error('nope'))).not.toThrow();
    });

    it('falls back to the active span when none is passed', () => {
        const span = fakeSpan();
        withActiveSpan(span);

        recordSpanException(new Error('from active span'));

        expect(span.recordException).toHaveBeenCalledTimes(1);
    });

    it('prefers an explicitly passed span over the active one', () => {
        const active = fakeSpan();
        const explicit = fakeSpan();
        withActiveSpan(active);

        recordSpanException(new Error('boom'), explicit);

        expect(explicit.recordException).toHaveBeenCalledTimes(1);
        expect(active.recordException).not.toHaveBeenCalled();
    });

    it('never throws if the span implementation throws', () => {
        const span = {
            recordException: vi.fn(() => {
                throw new Error('span is dead');
            }),
            setStatus: vi.fn(),
        } as unknown as Span;

        expect(() => recordSpanException(new Error('boom'), span)).not.toThrow();
    });

    it('does not mutate the caller-supplied Error', () => {
        const span = fakeSpan();
        const err = new Error('failed for a@b.com');

        recordSpanException(err, span);

        expect(err.message).toBe('failed for a@b.com');
    });
});

describe('recordSpanException PII scrubbing', () => {
    // Exception messages/stacks bypass PiiSanitizingSpanExporter, which only
    // rewrites URL-shaped span attributes — so scrubbing has to happen here.
    it('redacts bare emails in the message', () => {
        const span = fakeSpan();

        recordSpanException(new Error('no user for a@b.com'), span);

        const recorded = recordedError(span);
        expect(recorded.message).toBe('no user for :email');
    });

    it('templatizes identifiers in paths', () => {
        const span = fakeSpan();

        recordSpanException(new Error('GET /students/12345/grades failed'), span);

        const recorded = recordedError(span);
        expect(recorded.message).toContain('/students/:id/grades');
        expect(recorded.message).not.toContain('12345');
    });

    it('strips query strings from absolute URLs', () => {
        const span = fakeSpan();

        recordSpanException(
            new Error('upstream https://iam.saga.org/auth?email=a@b.com failed'),
            span,
        );

        const recorded = recordedError(span);
        expect(recorded.message).not.toContain('email=');
        expect(recorded.message).toContain('https://iam.saga.org/auth');
    });

    it('scrubs the status message too, not just the exception', () => {
        const span = fakeSpan();

        recordSpanException(new Error('lookup failed for a@b.com'), span);

        expect(span.setStatus).toHaveBeenCalledWith({
            code: SpanStatusCode.ERROR,
            message: 'lookup failed for :email',
        });
    });

    it('leaves ordinary prose untouched', () => {
        const span = fakeSpan();

        recordSpanException(new Error('database connection pool exhausted'), span);

        expect(recordedError(span).message).toBe(
            'database connection pool exhausted',
        );
    });
});

describe('structuredErrorMiddleware', () => {
    function harness() {
        const errorSpy = vi.fn();
        const logger = { error: errorSpy } as never;
        const res = {
            headersSent: false,
            status: vi.fn().mockReturnThis(),
            json: vi.fn().mockReturnThis(),
        };
        const req = { method: 'GET', originalUrl: '/trpc/pods.list' };
        const next = vi.fn() as never;
        return { logger, errorSpy, res, req, next };
    }

    it('records the exception on the active span', () => {
        const span = fakeSpan();
        withActiveSpan(span);
        const { logger, res, req, next } = harness();

        structuredErrorMiddleware(logger)(
            new Error('handler blew up'),
            req as never,
            res as never,
            next,
        );

        expect(span.recordException).toHaveBeenCalledTimes(1);
        expect(span.setStatus).toHaveBeenCalledWith(
            expect.objectContaining({ code: SpanStatusCode.ERROR }),
        );
    });

    it('still logs and responds 500 when no span is active', () => {
        withActiveSpan(undefined);
        const { logger, errorSpy, res, req, next } = harness();

        structuredErrorMiddleware(logger)(
            new Error('boom'),
            req as never,
            res as never,
            next,
        );

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: 'internal server error' });
    });

    it('does not write a response when headers were already sent', () => {
        withActiveSpan(fakeSpan());
        const { logger, res, req, next } = harness();
        res.headersSent = true;

        structuredErrorMiddleware(logger)(
            new Error('boom'),
            req as never,
            res as never,
            next,
        );

        expect(res.status).not.toHaveBeenCalled();
    });
});

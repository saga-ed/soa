import { describe, it, expect, vi, afterEach } from 'vitest';
import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { recordSpanException } from './record-exception.js';
import { structuredErrorMiddleware } from './error-middleware.js';
import {
    setSanitizerWarnSink,
    resetSanitizerWarnSink,
} from './span-sanitizer.js';

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
    resetSanitizerWarnSink();
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

    // The throwing-span test above only exercises code INSIDE the try. These
    // cover the coercion, which sat above it and was the actual gap.
    it.each([
        ['null-prototype object', () => Object.create(null) as unknown],
        [
            'poisoned toString',
            () =>
                ({
                    toString() {
                        throw new Error('nope');
                    },
                }) as unknown,
        ],
        [
            'throwing Symbol.toPrimitive',
            () =>
                ({
                    [Symbol.toPrimitive]() {
                        throw new Error('nope');
                    },
                }) as unknown,
        ],
        ['symbol', () => Symbol('sym') as unknown],
    ])('never throws when coercing a %s', (_label, make) => {
        const span = fakeSpan();

        expect(() => recordSpanException(make(), span)).not.toThrow();
    });

    it('reports a swallowed failure instead of failing silently', () => {
        const warn = vi.fn();
        setSanitizerWarnSink(warn);
        const span = {
            recordException: vi.fn(() => {
                throw new Error('span is dead');
            }),
            setStatus: vi.fn(),
        } as unknown as Span;

        recordSpanException(new Error('boom'), span);

        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('preserves `code` on the sanitized clone so exception.type survives', () => {
        // The SDK reads exception.code BEFORE exception.name for exception.type,
        // so losing it collapses ECONNREFUSED to a generic "Error" — and only
        // when the message happened to contain PII, splitting one failure into
        // two Error Tracking groups.
        const span = fakeSpan();
        const err = Object.assign(
            new Error('connect ECONNREFUSED 10.0.1.5:5432 for a@b.com'),
            { code: 'ECONNREFUSED' },
        );

        recordSpanException(err, span);

        const recorded = recordedError(span) as Error & { code?: string };
        expect(recorded.message).toContain(':email');
        expect(recorded.code).toBe('ECONNREFUSED');
    });

    it('preserves `cause` on the sanitized clone', () => {
        const span = fakeSpan();
        const cause = new Error('root cause');
        const err = new Error('wrapper for a@b.com', { cause });

        recordSpanException(err, span);

        expect((recordedError(span) as Error & { cause?: unknown }).cause).toBe(
            cause,
        );
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

    // A standalone slash in prose must not be treated as a path — over-matching
    // here would redact ordinary error text into uselessness.
    it.each([
        'timeout after 30s / retrying',
        'config value / missing',
        'read/write conflict',
        'rate limit 5/second exceeded',
    ])('leaves prose containing a slash untouched: %s', (message) => {
        const span = fakeSpan();

        recordSpanException(new Error(message), span);

        expect(recordedError(span).message).toBe(message);
    });

    // The stack is the whole point of the fix — templatizing its frames into
    // ':id' soup would trade one unusable field for another.
    it('keeps stack frames readable', () => {
        const span = fakeSpan();
        const err = new Error('boom');
        err.stack = [
            'Error: boom',
            '    at handler (/app/apps/node/programs-api/dist/main.js:12:5)',
            '    at next (/app/node_modules/express/lib/router/index.js:280:10)',
        ].join('\n');

        recordSpanException(err, span);

        const recorded = recordedError(span);
        expect(recorded.stack).toContain('programs-api/dist/main.js');
        expect(recorded.stack).toContain('express/lib/router/index.js');
        expect(recorded.stack).not.toContain(':id');
    });

    it('scrubs identifiers embedded in stack frames', () => {
        const span = fakeSpan();
        const err = new Error('boom');
        err.stack = 'Error: boom\n    at load (/students/12345/grades:1:1)';

        recordSpanException(err, span);

        expect(recordedError(span).stack).not.toContain('12345');
    });

    it('records a real Error instance, not a plain object', () => {
        const span = fakeSpan();

        recordSpanException(new Error('failed for a@b.com'), span);

        expect(recordedError(span)).toBeInstanceOf(Error);
    });

    // sanitizeUrl's identifier tests are anchored (^\d+$), so an id that
    // absorbed trailing punctuation into its segment silently fails them.
    it.each([
        ['sentence-final period', 'failed to load /students/12345.', '12345'],
        [
            'comma after an absolute URL',
            'upstream https://iam.saga.org/students/12345, retrying',
            '12345',
        ],
        ['bare-path query string', 'GET /students?studentId=12345 failed', '12345'],
        [
            'query string with an SSN',
            'POST /api/lookup?ssn=123-45-6789 rejected',
            '123-45-6789',
        ],
    ])('redacts an id despite %s', (_label, message, leaked) => {
        const span = fakeSpan();

        recordSpanException(new Error(message), span);

        expect(recordedError(span).message).not.toContain(leaked);
    });

    // The npm scope redacts to `:id` — there is no exemption for it, because
    // every attempt to carve one out leaked a `/@handle` route (see the note in
    // span-sanitizer.ts). What must survive is enough of the frame to LOCATE
    // the code: the unscoped package name, the path, and the filename.
    it.each([
        [
            '/app/node_modules/@saga-ed/soa-observability/dist/index.js',
            ['node_modules', 'soa-observability', 'index.js'],
        ],
        [
            '/app/node_modules/@opentelemetry/api/build/src/trace.js',
            ['node_modules', 'api', 'trace.js'],
        ],
    ])('keeps the frame diagnosable in %s', (frame, mustSurvive) => {
        const span = fakeSpan();
        const err = new Error('boom');
        err.stack = `Error: boom\n    at handler (${frame}:1:1)`;

        recordSpanException(err, span);

        const stack = recordedError(span).stack;
        for (const part of mustSurvive) {
            expect(stack).toContain(part);
        }
        expect(stack).toContain(':id'); // the scope itself is redacted
    });

    // Scrubbing runs synchronously on the Express error path and the input is
    // attacker-influenceable, so its cost must stay bounded. Before the length
    // cap this exact shape blocked the event loop for ~8s.
    it('scrubs a pathological 64KB message in bounded time', () => {
        const span = fakeSpan();
        const hostile = 'Cannot GET user@' + '/api/' + 'a.'.repeat(30000);

        const started = performance.now();
        recordSpanException(new Error(hostile), span);
        const elapsed = performance.now() - started;

        expect(elapsed).toBeLessThan(1000);
        expect(recordedError(span).message).toContain('truncated');
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

    // A throw from inside an error handler goes to Express's finalhandler,
    // which sends a raw stack trace to the client and loses the log entry.
    it.each([
        ['null-prototype object', () => Object.create(null) as unknown],
        [
            'poisoned toString',
            () =>
                ({
                    toString() {
                        throw new Error('nope');
                    },
                }) as unknown,
        ],
    ])('still responds 500 when the thrown value is a %s', (_label, make) => {
        withActiveSpan(undefined);
        const { logger, res, req, next } = harness();

        expect(() =>
            structuredErrorMiddleware(logger)(
                make(),
                req as never,
                res as never,
                next,
            ),
        ).not.toThrow();

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: 'internal server error' });
    });

    it('still responds 500 when the logger itself throws', () => {
        withActiveSpan(undefined);
        const { res, req, next } = harness();
        const logger = {
            error: () => {
                throw new Error('logger is down');
            },
        } as never;

        expect(() =>
            structuredErrorMiddleware(logger)(
                new Error('boom'),
                req as never,
                res as never,
                next,
            ),
        ).not.toThrow();

        expect(res.status).toHaveBeenCalledWith(500);
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

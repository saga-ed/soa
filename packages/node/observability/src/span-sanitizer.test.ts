import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    sanitizeUrl,
    sanitizeText,
    PiiSanitizingSpanExporter,
    setSanitizerWarnSink,
    resetSanitizerWarnSink,
} from './span-sanitizer.js';
import { resolveResourceAttributes } from './tracing.js';
import { recordSpanException } from './record-exception.js';

describe('sanitizeUrl', () => {
    it('strips query strings', () => {
        expect(sanitizeUrl('http://iam.wootdev.com/auth/refresh?email=a@b.com')).toBe(
            'http://iam.wootdev.com/auth/refresh',
        );
    });

    it('templatizes numeric id path segments', () => {
        expect(sanitizeUrl('/students/12345/grades')).toBe('/students/:id/grades');
    });

    it('templatizes UUID path segments', () => {
        expect(
            sanitizeUrl('/users/3f2504e0-4f89-41d3-9a0c-0305e82c3301'),
        ).toBe('/users/:id');
    });

    it('templatizes email-shaped path segments', () => {
        expect(sanitizeUrl('/lookup/student@school.edu')).toBe('/lookup/:id');
    });

    it('templatizes percent-encoded email segments (%40)', () => {
        // http.target / url.path are frequently percent-encoded; matching only
        // a literal @ would leak the encoded form.
        expect(sanitizeUrl('/lookup/student%40school.edu')).toBe('/lookup/:id');
        expect(sanitizeUrl('/lookup/a%40b.com')).toBe('/lookup/:id');
    });

    it('templatizes long opaque token segments', () => {
        expect(sanitizeUrl('/t/AbCdEfGhIjKlMnOpQrStUvWx')).toBe('/t/:id');
    });

    it('preserves tRPC method-name paths (not identifier-shaped)', () => {
        expect(sanitizeUrl('http://iam.wootdev.com/trpc/auth.getProvidersByEmail')).toBe(
            'http://iam.wootdev.com/trpc/auth.getProvidersByEmail',
        );
    });

    it('preserves plain route shapes', () => {
        expect(sanitizeUrl('http://x/health/ready')).toBe('http://x/health/ready');
    });

    it('handles bare root + empty', () => {
        expect(sanitizeUrl('/')).toBe('/');
        expect(sanitizeUrl('http://host')).toBe('http://host');
    });

    // The npm-scope exemption is only correct for code locations. Applied to a
    // request URL it un-redacts a user handle, and worse, does so only for the
    // literal form — making PII exposure depend on client encoding.
    it('redacts @handle segments in request URLs', () => {
        expect(sanitizeUrl('/@johndoe/profile')).toBe('/:id/profile');
    });

    it('treats literal and percent-encoded handles identically', () => {
        expect(sanitizeUrl('/@johndoe/profile')).toBe(
            sanitizeUrl('/%40johndoe/profile'),
        );
    });

    // There is NO npm-scope exemption: the scope is `@`-bearing, so it redacts
    // like any other identifier. Three attempts to exempt it each leaked a
    // `/@handle` route one step to the side — see the note in span-sanitizer.ts.
    it('redacts an npm scope like any other @-bearing segment', () => {
        expect(sanitizeUrl('/app/node_modules/@saga-ed/pkg/index.js')).toBe(
            '/app/node_modules/:id/pkg/index.js',
        );
    });

    it('redacts an id fused to a file extension', () => {
        expect(sanitizeUrl('/exports/98765.csv')).toBe('/exports/:id');
    });

    // The authority was split off as an opaque prefix and never examined, so
    // userinfo shipped verbatim — an address, or a password on a connection
    // string that reaches `http.url`.
    it.each([
        ['http://a@b.com/x', 'http://:userinfo@b.com/x'],
        ['https://user:pw@host.com/path', 'https://:userinfo@host.com/path'],
        [
            'postgres://admin:s3cret@db.internal:5432/main',
            'postgres://:userinfo@db.internal:5432/main',
        ],
        ['https://alice%40saga.org@host.com/p', 'https://:userinfo@host.com/p'],
    ])('redacts userinfo in %s', (input, expected) => {
        expect(sanitizeUrl(input)).toBe(expected);
    });

    // The host is operational data, not user data — it must survive, or the
    // attribute stops telling you which service was called.
    it('leaves an authority without userinfo untouched', () => {
        expect(sanitizeUrl('https://host.com/path')).toBe('https://host.com/path');
    });
});

describe('sanitizeText', () => {
    it.each([
        ['no user for a@b.com', 'no user for :email'],
        ['deep sub a@b.co.uk here', 'deep sub :email here'],
        ['GET /students/12345/grades failed', 'GET /students/:id/grades failed'],
        ['failed to load /students/12345.', 'failed to load /students/:id.'],
        ['GET /students?studentId=12345 failed', 'GET /students failed'],
    ])('scrubs %s', (input, expected) => {
        expect(sanitizeText(input)).toBe(expected);
    });

    // Over-matching would redact ordinary error text into uselessness.
    it.each([
        'timeout after 30s / retrying',
        'read/write conflict',
        'rate limit 5/second exceeded',
        'database connection pool exhausted',
    ])('leaves prose untouched: %s', (text) => {
        expect(sanitizeText(text)).toBe(text);
    });

    // The scope redacts (no exemption), but the frame must stay DIAGNOSABLE:
    // path structure and filename survive, so the frame still locates the code.
    // That is the guarantee we actually make, and the price of closing the
    // /@handle class for good.
    it('keeps stack frames diagnosable while redacting the scope', () => {
        const out = sanitizeText(
            'at f (/app/node_modules/@saga-ed/soa-observability/x.js)',
        );

        expect(out).toBe('at f (/app/node_modules/:id/soa-observability/x.js)');
    });

    // A router echoes the request path into its message ("Cannot GET /@bob"),
    // so free text is attacker-influenceable. Any marker used to prove a token
    // is a code location can therefore be supplied BY the request — which is
    // why there is no provenance gate. The last three entries are the spoof
    // attempts that killed the gated design.
    it.each([
        ['Cannot GET /@bob', 'Cannot GET /:id'],
        ['Cannot GET /@bob/posts', 'Cannot GET /:id/posts'],
        ['Cannot GET /files/node_modules/@bob', 'Cannot GET /files/node_modules/:id'],
        ['Cannot GET /node_modules/@bob', 'Cannot GET /node_modules/:id'],
        ['Error: file:///@bob', 'Error: file:///:id'],
    ])('redacts @handle echoed into free text: %s', (input, expected) => {
        expect(sanitizeText(input)).toBe(expected);
    });

    // `mailto:a@b.com` fails the anchored whole-token test (the scheme breaks
    // the anchor) and is not path-shaped (no slash), so it shipped verbatim.
    it.each(['mailto:a@b.com', 'MAILTO:a@b.com', '<mailto:a@b.com>'])(
        'redacts an address behind a URI scheme: %s',
        (input) => {
            expect(sanitizeText(input)).not.toContain('a@b.com');
        },
    );

    // Credentials in an authority reach free text too — a driver echoes the
    // connection string into its error message. The HOST must survive: it is
    // operational data, and it is why path-shaped tokens are routed to
    // `sanitizeUrl` before the email pass.
    it.each([
        [
            'at http://alice@saga.org/profile',
            'at http://:userinfo@saga.org/profile',
        ],
        [
            'connect failed: postgres://admin:s3cret@db.internal:5432/main',
            'connect failed: postgres://:userinfo@db.internal:5432/main',
        ],
    ])('redacts userinfo echoed into free text: %s', (input, expected) => {
        expect(sanitizeText(input)).toBe(expected);
    });

    // An address packed into a larger token by a NON-whitespace delimiter. A
    // driver echoing SQL or a query parameter into its message is exactly the
    // vector this package creates, and enumerating delimiters one at a time is
    // what kept this leaking — the split is now the complement of the address
    // alphabet.
    it.each([
        ["insert failed: email='a@b.com'", "insert failed: email=':email'"],
        ['no recipient for to=a@b.com', 'no recipient for to=:email'],
        ['user=a@b.com id=42', 'user=:email id=42'],
        ['json {"email":"a@b.com"}', 'json {"email":":email"}'],
    ])('redacts an address packed by a non-label delimiter: %s', (input, expected) => {
        expect(sanitizeText(input)).toBe(expected);
    });

    // Encoding must never decide exposure — in a path segment or in prose.
    it('treats literal and percent-encoded handles identically in text', () => {
        expect(sanitizeText('Cannot GET /@bob')).toBe(
            sanitizeText('Cannot GET /%40bob'),
        );
    });

    it('redacts a percent-encoded address in prose', () => {
        expect(sanitizeText('encoded a%40b.com in prose')).toBe(
            'encoded :email in prose',
        );
    });

    // A recipient list is ONE whitespace token, so the anchored whole-token
    // test matched neither address. The comma-SPACE form always worked, which
    // is what let the packed forms hide: the delimiter decided exposure.
    it.each([
        'failed for a@b.com;c@d.com',
        'failed for a@b.com,c@d.com',
        'failed for a@b.com, c@d.com',
    ])('redacts every address in a packed list: %s', (input) => {
        const out = sanitizeText(input);
        expect(out).not.toContain('a@b.com');
        expect(out).not.toContain('c@d.com');
    });

    // Schemes are matched generically, not from a list. `file://` is the normal
    // frame shape in an ESM service, so a fixed `https?` list silently exempted
    // every stack this package exists to scrub.
    it.each([
        ['file:///app/src/students/12345/x.js:1:1', '12345'],
        ['prisma://db/students/12345', '12345'],
        ['prefix/students/12345 tail', '12345'],
        ['/students/12345.json failed', '12345'],
        ['/exports/98765.csv', '98765'],
    ])('redacts the id in %s', (input, leaked) => {
        expect(sanitizeText(input)).not.toContain(leaked);
    });

    // Truncating before scrubbing removes the trailing context the anchored
    // rules need, so a value at the boundary stops matching and ships partly
    // intact — the cap must bound what is retained, not what is examined.
    it.each([
        ['email', 'p'.repeat(16374) + 'alice@saga.org', 'alice@saga'],
        [
            'UUID',
            'q'.repeat(16350) + '/u/550e8400-e29b-41d4-a716-446655440000',
            '550e8400-e29b-41',
        ],
    ])('redacts a %s straddling the truncation cap', (_label, input, leaked) => {
        expect(sanitizeText(input)).not.toContain(leaked);
    });

    // Assert the GROWTH RATE, not a wall-clock threshold. The previous test
    // allowed 1000ms and passed at ~220ms of quadratic work, so it would have
    // stayed green through a 3x regression. Doubling the input must not
    // meaningfully more than double the time.
    //
    // The bound is deliberately loose. This is a wall-clock measurement in a
    // package every layer depends on, run under CI parallelism where a GC
    // pause or a descheduled core lands entirely inside one of two short
    // samples — a tight ratio would flake fleet-wide without catching anything
    // extra. Quadratic behaviour on a 2x input shows up at ~4x and grows with
    // size, so a regression still fails this; only the noise band widens.
    it('scans in linear time, not quadratically', () => {
        const scan = (kib: number) => {
            const input = 'a.'.repeat(kib * 512); // dotted run, no '@' at all
            const started = performance.now();
            sanitizeText(input);
            return performance.now() - started;
        };

        scan(8); // warm up, so JIT compilation is not attributed to the first size
        const small = Math.max(scan(8), 0.5);
        const large = scan(16);

        expect(large / small).toBeLessThan(3.5);
    });

    it('caps retained output at the truncation limit', () => {
        const out = sanitizeText('x'.repeat(20000));

        expect(out).toContain('truncated');
        expect(out.length).toBeLessThan(20000);
    });
});

describe('PiiSanitizingSpanExporter', () => {
    function fakeSpan(
        attributes: Record<string, unknown>,
        events: { name: string; attributes?: Record<string, unknown> }[] = [],
    ) {
        return { attributes, events } as unknown as Parameters<
            PiiSanitizingSpanExporter['export']
        >[0][number];
    }

    function exportSpan(span: ReturnType<typeof fakeSpan>) {
        const inner = {
            export: (_spans: unknown, cb: (r: unknown) => void) => cb({ code: 0 }),
            shutdown: () => Promise.resolve(),
        };
        new PiiSanitizingSpanExporter(inner as never).export([span], () => {});
        return span as unknown as {
            events: { attributes?: Record<string, unknown> }[];
        };
    }

    // The auto-instrumentations record exceptions themselves — express calls
    // recordException on the RAW error for every layer span — so scrubbing only
    // at our own call site leaves the verbatim value on a sibling span in the
    // same trace. This is the boundary that makes the guarantee hold.
    it('scrubs PII from exception events recorded by instrumentations', () => {
        const span = fakeSpan({}, [
            {
                name: 'exception',
                attributes: {
                    'exception.type': 'Error',
                    'exception.message': 'no user for a@b.com',
                    'exception.stacktrace':
                        'Error: no user for a@b.com\n    at load (/students/12345/grades:1:1)',
                },
            },
        ]);

        const attrs = exportSpan(span).events[0]!.attributes!;

        expect(attrs['exception.message']).toBe('no user for :email');
        expect(attrs['exception.stacktrace']).not.toContain('a@b.com');
        expect(attrs['exception.stacktrace']).not.toContain('12345');
        expect(attrs['exception.type']).toBe('Error');
    });

    // A throw in the attribute rewrite must not take the event scrub with it —
    // the exception event is the higher-PII payload, recorded from the RAW
    // error by instrumentations this package never touches.
    it('still scrubs exception events when attribute sanitization throws', () => {
        setSanitizerWarnSink(vi.fn());
        const span = {
            attributes: Object.freeze({ 'http.url': 'http://x/students/42?q=1' }),
            events: [
                {
                    name: 'exception',
                    attributes: { 'exception.message': 'no user for a@b.com' },
                },
            ],
        } as never;

        const inner = {
            export: (_s: unknown, cb: (r: unknown) => void) => cb({ code: 0 }),
            shutdown: () => Promise.resolve(),
        };
        expect(() =>
            new PiiSanitizingSpanExporter(inner as never).export([span], () => {}),
        ).not.toThrow();

        const events = (span as unknown as { events: { attributes: Record<string, unknown> }[] })
            .events;
        expect(events[0]!.attributes['exception.message']).toBe('no user for :email');
    });

    it('throttles each failure channel independently', () => {
        const warn = vi.fn();
        setSanitizerWarnSink(warn);
        const inner = {
            export: (_s: unknown, cb: (r: unknown) => void) => cb({ code: 0 }),
            shutdown: () => Promise.resolve(),
        };
        const exporter = new PiiSanitizingSpanExporter(inner as never);

        // Drive many attribute failures so a shared counter would move well past
        // the throttle boundary.
        for (let i = 0; i < 50; i++) {
            exporter.export(
                [{ attributes: Object.freeze({ 'http.url': '/x/1' }), events: [] } as never],
                () => {},
            );
        }
        const afterAttributes = warn.mock.calls.length;

        // A first failure in a DIFFERENT channel must still warn immediately.
        recordSpanException(new Error('boom'), {
            recordException: () => {
                throw new Error('span is dead');
            },
            setStatus: () => {},
        } as never);

        expect(warn.mock.calls.length).toBe(afterAttributes + 1);
    });

    it('leaves non-exception events and spans without events alone', () => {
        const span = fakeSpan({}, [
            { name: 'custom', attributes: { detail: 'no user for a@b.com' } },
        ]);

        const attrs = exportSpan(span).events[0]!.attributes!;

        expect(attrs.detail).toBe('no user for a@b.com');
        expect(() =>
            exportSpan({ attributes: {} } as ReturnType<typeof fakeSpan>),
        ).not.toThrow();
    });

    it('sanitizes url attrs + drops url.query, delegates to inner', () => {
        const seen: { attrs: Record<string, unknown> }[] = [];
        const inner = {
            export: (spans: ReturnType<typeof fakeSpan>[], cb: (r: unknown) => void) => {
                for (const s of spans) seen.push({ attrs: s.attributes as Record<string, unknown> });
                cb({ code: 0 });
            },
            shutdown: () => Promise.resolve(),
        };
        const exporter = new PiiSanitizingSpanExporter(inner as never);

        const span = fakeSpan({
            'http.url': 'http://iam.wootdev.com/students/42?email=a@b.com',
            'http.target': '/students/42',
            'url.query': 'email=a@b.com',
            'http.client_ip': '98.43.12.198', // must be preserved
            'http.status_code': 200,
        });

        let called = false;
        exporter.export([span], () => {
            called = true;
        });

        expect(called).toBe(true);
        const a = seen[0]!.attrs;
        expect(a['http.url']).toBe('http://iam.wootdev.com/students/:id');
        expect(a['http.target']).toBe('/students/:id');
        expect('url.query' in a).toBe(false);
        expect(a['http.client_ip']).toBe('98.43.12.198'); // kept by decision
        expect(a['http.status_code']).toBe(200);
    });

    it('sanitizes the newer url.full / url.path semconv keys', () => {
        const seen: { attrs: Record<string, unknown> }[] = [];
        const inner = {
            export: (spans: ReturnType<typeof fakeSpan>[], cb: (r: unknown) => void) => {
                for (const s of spans) seen.push({ attrs: s.attributes as Record<string, unknown> });
                cb({ code: 0 });
            },
            shutdown: () => Promise.resolve(),
        };
        const exporter = new PiiSanitizingSpanExporter(inner as never);
        const span = fakeSpan({
            'url.full': 'http://x/students/42/grades?token=abc',
            'url.path': '/students/42/grades',
        });

        exporter.export([span], () => {});
        const a = seen[0]!.attrs;
        expect(a['url.full']).toBe('http://x/students/:id/grades');
        expect(a['url.path']).toBe('/students/:id/grades');
    });

    // Inject a spy sink + reset the throttle after each test so the
    // module-level failure counter never leaks between cases.
    afterEach(() => resetSanitizerWarnSink());

    it('fails OPEN: never throws / drops spans, ships PII unmodified, and WARNS', () => {
        // Frozen attributes object → assignment throws → must be swallowed,
        // span still passed through to inner WITH its (unsanitized) PII intact
        // (the documented fail-open consequence: degrade, never drop) AND a
        // warning must fire (detectability — not a silent swallow).
        const warn = vi.fn();
        setSanitizerWarnSink(warn);

        const frozen = Object.freeze({
            'http.url': 'http://x/students/42?q=1',
        });
        const seen: { attributes: Record<string, unknown> }[] = [];
        const inner = {
            export: (spans: { attributes: Record<string, unknown> }[], cb: (r: unknown) => void) => {
                seen.push(...spans);
                cb({ code: 0 });
            },
            shutdown: () => Promise.resolve(),
        };
        const exporter = new PiiSanitizingSpanExporter(inner as never);
        const span = { attributes: frozen } as never;

        expect(() => exporter.export([span], () => {})).not.toThrow();
        expect(seen).toHaveLength(1); // span not dropped
        // Unsanitized value shipped (fail open) — documents the contract.
        expect(seen[0]!.attributes['http.url']).toBe('http://x/students/42?q=1');
        // The failure is surfaced on the FIRST occurrence (count 0).
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('span attribute sanitization failed'),
            expect.anything(),
        );
    });
});

describe('resolveResourceAttributes (service.version)', () => {
    const saved = {
        DD_VERSION: process.env.DD_VERSION,
        OTEL_SERVICE_VERSION: process.env.OTEL_SERVICE_VERSION,
    };
    afterEach(() => {
        // Restore env so tests don't leak into each other.
        process.env.DD_VERSION = saved.DD_VERSION;
        process.env.OTEL_SERVICE_VERSION = saved.OTEL_SERVICE_VERSION;
        if (saved.DD_VERSION === undefined) delete process.env.DD_VERSION;
        if (saved.OTEL_SERVICE_VERSION === undefined)
            delete process.env.OTEL_SERVICE_VERSION;
    });

    it('always sets service.name', () => {
        delete process.env.DD_VERSION;
        delete process.env.OTEL_SERVICE_VERSION;
        const attrs = resolveResourceAttributes('iam-api');
        expect(attrs['service.name']).toBe('iam-api');
    });

    it('omits service.version when neither env var is set', () => {
        delete process.env.DD_VERSION;
        delete process.env.OTEL_SERVICE_VERSION;
        const attrs = resolveResourceAttributes('iam-api');
        expect('service.version' in attrs).toBe(false);
    });

    it('DD_VERSION takes precedence over OTEL_SERVICE_VERSION', () => {
        process.env.DD_VERSION = 'sha-dd';
        process.env.OTEL_SERVICE_VERSION = 'sha-otel';
        const attrs = resolveResourceAttributes('iam-api');
        expect(attrs['service.version']).toBe('sha-dd');
    });

    it('falls back to OTEL_SERVICE_VERSION when DD_VERSION unset', () => {
        delete process.env.DD_VERSION;
        process.env.OTEL_SERVICE_VERSION = 'sha-otel';
        const attrs = resolveResourceAttributes('iam-api');
        expect(attrs['service.version']).toBe('sha-otel');
    });
});

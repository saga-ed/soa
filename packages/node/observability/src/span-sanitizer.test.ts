import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    sanitizeUrl,
    PiiSanitizingSpanExporter,
    setSanitizerWarnSink,
    resetSanitizerWarnSink,
} from './span-sanitizer.js';
import { resolveResourceAttributes } from './tracing.js';

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
});

describe('PiiSanitizingSpanExporter', () => {
    function fakeSpan(attributes: Record<string, unknown>) {
        return { attributes } as unknown as Parameters<
            PiiSanitizingSpanExporter['export']
        >[0][number];
    }

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
            expect.stringContaining('span sanitization failed'),
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

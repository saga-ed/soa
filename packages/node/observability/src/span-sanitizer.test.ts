import { describe, it, expect } from 'vitest';
import { sanitizeUrl, PiiSanitizingSpanExporter } from './span-sanitizer.js';

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

    it('fails OPEN: never throws / drops spans on sanitize error', () => {
        // Frozen attributes object → assignment throws → must be swallowed,
        // span still passed through to inner.
        const frozen = Object.freeze({
            'http.url': 'http://x/students/42?q=1',
        });
        const seen: unknown[] = [];
        const inner = {
            export: (spans: unknown[], cb: (r: unknown) => void) => {
                seen.push(...spans);
                cb({ code: 0 });
            },
            shutdown: () => Promise.resolve(),
        };
        const exporter = new PiiSanitizingSpanExporter(inner as never);
        const span = { attributes: frozen } as never;

        expect(() => exporter.export([span], () => {})).not.toThrow();
        expect(seen).toHaveLength(1); // span not dropped
    });
});

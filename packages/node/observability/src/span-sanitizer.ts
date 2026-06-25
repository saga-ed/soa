import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { ExportResult } from '@opentelemetry/core';

/**
 * PII span sanitizer.
 *
 * The Node auto-instrumentations capture full request URLs / targets verbatim
 * (`http.url`, `http.target`, `url.full`, `url.path`, `url.query`). For a
 * student-facing platform those free-form attributes are the real PII vector:
 * an id or email embedded in a path (`/students/12345`) or query string
 * (`?email=a@b.com`) ships to Datadog unfiltered. This module strips that
 * data before export while preserving the *shape* (route template) that makes
 * the span useful for troubleshooting.
 *
 * DELIBERATELY NOT TOUCHED (operational data, kept by explicit decision):
 *   - `http.client_ip` and the geo enrichment (`client_ip_details.*`).
 *   - `http.route` (already a template like `/students/:id` — safe + high value).
 *
 * INTERCEPTION POINT — why a wrapping SpanExporter, not a SpanProcessor:
 * in OTel JS (sdk-trace-base 1.x) a `ReadableSpan` handed to
 * `SpanProcessor.onEnd` is treated as read-only; mutating `span.attributes`
 * there is unsupported and silently ineffective. The exporter receives the
 * same `ReadableSpan[]`, but here we own the boundary to the wire: we rewrite
 * the `attributes` map (it is a plain object on the SDK's span impl) and then
 * delegate to the real OTLP exporter. This is the robust, version-stable seam.
 *
 * DEGRADE-SAFE CONTRACT (fleet blast radius): sanitization must NEVER throw and
 * NEVER drop a span. Any error while rewriting one span is swallowed and that
 * span is passed through unmodified — we fail OPEN (ship a span that may retain
 * a path) rather than closed (lose the telemetry entirely). The alternative —
 * an exception escaping into the BatchSpanProcessor's export loop — would take
 * down tracing for the whole service.
 */

/** URL-ish attribute keys whose values get path/query sanitization. */
const URL_ATTR_KEYS = [
    'http.url',
    'http.target',
    'url.full',
    'url.path',
    'url.query',
] as const;

/** Attribute keys removed outright (raw query string, never a safe shape). */
const DROP_ATTR_KEYS = ['url.query'] as const;

// Path segments that look like identifiers get replaced with `:id`. Covers
// numeric ids, UUIDs, long hex/base64 tokens, and email-shaped segments.
const NUMERIC_SEGMENT = /^\d+$/;
const UUID_SEGMENT =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_TOKEN_SEGMENT = /^[A-Za-z0-9_-]{20,}$/; // hex/base64-ish opaque ids
const EMAIL_SEGMENT = /@/;

function looksLikeIdentifier(segment: string): boolean {
    return (
        NUMERIC_SEGMENT.test(segment) ||
        UUID_SEGMENT.test(segment) ||
        EMAIL_SEGMENT.test(segment) ||
        LONG_TOKEN_SEGMENT.test(segment)
    );
}

/**
 * Sanitize a URL/path string: drop the query string entirely and templatize
 * identifier-looking path segments. Works on absolute URLs and bare paths.
 * tRPC method names (`/trpc/auth.getProvidersByEmail`) are method *names*, not
 * data, and are NOT identifier-shaped → preserved.
 */
export function sanitizeUrl(value: string): string {
    // Split scheme://host from the path so we only rewrite the path portion.
    let prefix = '';
    let rest = value;

    const schemeMatch = /^([a-z][a-z0-9+.-]*:\/\/[^/]+)(\/.*)?$/i.exec(value);
    if (schemeMatch && schemeMatch[1]) {
        prefix = schemeMatch[1];
        rest = schemeMatch[2] ?? '';
    }

    // Drop query string + fragment.
    const queryIdx = rest.search(/[?#]/);
    if (queryIdx !== -1) rest = rest.slice(0, queryIdx);

    if (rest === '' || rest === '/') return prefix + rest;

    const sanitizedPath = rest
        .split('/')
        .map((seg) => (looksLikeIdentifier(seg) ? ':id' : seg))
        .join('/');

    return prefix + sanitizedPath;
}

function sanitizeAttributes(attributes: Record<string, unknown>): void {
    for (const key of DROP_ATTR_KEYS) {
        if (key in attributes) delete attributes[key];
    }
    for (const key of URL_ATTR_KEYS) {
        if (key === 'url.query') continue; // already dropped above
        const val = attributes[key];
        if (typeof val === 'string') {
            attributes[key] = sanitizeUrl(val);
        }
    }
}

/**
 * Wraps a SpanExporter, sanitizing PII out of span attributes before delegating
 * to the inner exporter. See module doc for the degrade-safe contract.
 */
export class PiiSanitizingSpanExporter implements SpanExporter {
    constructor(private readonly inner: SpanExporter) {}

    export(
        spans: ReadableSpan[],
        resultCallback: (result: ExportResult) => void,
    ): void {
        for (const span of spans) {
            try {
                // The SDK's span impl exposes `attributes` as a mutable plain
                // object; rewrite in place. Guard in case a future impl makes
                // it read-only (the assignment would throw → caught below).
                sanitizeAttributes(span.attributes as Record<string, unknown>);
            } catch {
                // Fail OPEN: leave this span untouched rather than dropping it
                // or aborting the whole batch. Never rethrow.
            }
        }
        this.inner.export(spans, resultCallback);
    }

    shutdown(): Promise<void> {
        return this.inner.shutdown();
    }

    forceFlush(): Promise<void> {
        return this.inner.forceFlush?.() ?? Promise.resolve();
    }
}

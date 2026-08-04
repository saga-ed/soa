import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { sanitizeUrl } from './span-sanitizer.js';

/**
 * Attach exception data to a span so Datadog can populate `error.type`,
 * `error.message`, and `error.stack`.
 *
 * WHY THIS EXISTS: the Node auto-instrumentations set a span's status to
 * `Error` from a non-2xx HTTP status code, but they never synthesize an
 * `exception` span event — that is an explicit application responsibility.
 * Datadog sources the three `error.*` fields *only* from that event, so an
 * OTel-instrumented service that never calls `recordException` ships error
 * spans carrying `error: {}` — flagged as failing, with nothing to debug from
 * and nothing for Error Tracking to group on. (dd-trace does this attachment
 * automatically, which is why natively-instrumented services never needed it.)
 *
 * A span processor cannot substitute for calling this at the throw site: by
 * export time the Error object is out of scope, so the stack is unrecoverable.
 *
 * Safe to call when tracing is disabled or no span is active — it no-ops.
 */
export function recordSpanException(err: unknown, span?: Span): void {
    const target = span ?? trace.getActiveSpan();
    if (!target) {
        return;
    }

    const error = err instanceof Error ? err : new Error(String(err));

    try {
        target.recordException(sanitizeException(error));
        target.setStatus({
            code: SpanStatusCode.ERROR,
            message: sanitizeMessage(error.message),
        });
    } catch {
        // Never let telemetry break the error path that is already failing —
        // this runs inside error middleware, so a throw here would replace a
        // real 500 with an opaque one and lose the original error.
    }
}

/**
 * Exception messages and stacks bypass `PiiSanitizingSpanExporter` entirely —
 * it only rewrites URL-shaped span *attributes*, not the exception event's
 * payload. Errors routinely interpolate the offending value ("no user for
 * a@b.com", "GET /students/12345 failed"), so scrub before recording rather
 * than shipping student data to Datadog verbatim.
 *
 * Returns a shallow stand-in rather than mutating the caller's Error: the same
 * object is typically also logged and rethrown, and must reach those unchanged.
 */
function sanitizeException(error: Error): Error {
    const message = sanitizeMessage(error.message);
    const stack = error.stack ? sanitizeMessage(error.stack) : undefined;

    if (message === error.message && stack === error.stack) {
        return error;
    }

    // recordException reads only name/message/stack.
    return { name: error.name, message, stack } as Error;
}

// URL-ish runs inside free text. Deliberately narrow: over-matching would
// redact the message into uselessness, and the goal is removing the obvious
// identifier vector, not proving the text PII-free.
const URL_IN_TEXT = /\bhttps?:\/\/\S+|(?<![\w/])\/[A-Za-z0-9_\-./%@]*/g;
const BARE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function sanitizeMessage(text: string): string {
    return text
        .replace(URL_IN_TEXT, (match) => sanitizeUrl(match))
        .replace(BARE_EMAIL, ':email');
}

import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { sanitizeText, warnSanitizeFailure } from './span-sanitizer.js';

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
 * PII is scrubbed here as defence in depth, but the authoritative scrub is at
 * the exporter (`PiiSanitizingSpanExporter`), which also covers exception
 * events recorded by the auto-instrumentations — see `sanitizeText`.
 *
 * Safe to call with any thrown value, when tracing is disabled, or when no span
 * is active — it no-ops and never throws.
 */
export function recordSpanException(err: unknown, span?: Span): void {
    const target = span ?? trace.getActiveSpan();
    if (!target) {
        return;
    }

    try {
        // Coercion is INSIDE the try: `String(err)` throws for a null-prototype
        // object or a poisoned `toString`/`Symbol.toPrimitive`, and callers drop
        // this into arbitrary catch blocks on the strength of the never-throw
        // contract above.
        const error = err instanceof Error ? err : new Error(String(err));
        const { exception, message } = sanitizeException(error);

        target.recordException(exception);
        target.setStatus({ code: SpanStatusCode.ERROR, message });
    } catch (cause) {
        // Fail OPEN: the request is already failing, and a throw here would
        // replace a real 500 with an opaque one. But surface it (throttled) —
        // silently swallowing would let a regression revert every service to
        // `error: {}` with a green test suite and no signal.
        warnSanitizeFailure(
            'record-exception',
            '[record-exception] failed to record exception on span',
            cause,
        );
    }
}

interface SanitizedException {
    /** Scrubbed stand-in passed to `recordException`. */
    exception: Error;
    /** Scrubbed message, reused for `setStatus` so the text is scrubbed once. */
    message: string;
}

/**
 * Build a scrubbed stand-in for the caller's Error.
 *
 * Returns a stand-in rather than mutating the caller's Error: the same object
 * is typically also logged and rethrown, and must reach those unchanged.
 */
function sanitizeException(error: Error): SanitizedException {
    const message = sanitizeText(error.message);
    const stack = error.stack ? sanitizeText(error.stack) : undefined;

    if (message === error.message && stack === error.stack) {
        return { exception: error, message };
    }

    // A real Error, not a {name, message, stack} literal: recordException takes
    // an `Exception` and implementations are free to branch on `instanceof
    // Error`. A plain object could be silently dropped by a future SDK version.
    const sanitized = new Error(message);
    sanitized.name = error.name;
    sanitized.stack = stack;

    // `code` and `cause` must survive the clone. The SDK reads `exception.code`
    // BEFORE `exception.name` when deriving `exception.type`, so dropping it
    // would collapse e.g. ECONNREFUSED to a generic "Error" — and only on the
    // clone path, splitting one failure into two Error Tracking groups
    // depending on whether the message happened to contain PII.
    copyOwn(error, sanitized, 'code');
    copyOwn(error, sanitized, 'cause');

    return { exception: sanitized, message };
}

function copyOwn(from: Error, to: Error, key: 'code' | 'cause'): void {
    const value = (from as unknown as Record<string, unknown>)[key];
    if (value !== undefined) {
        (to as unknown as Record<string, unknown>)[key] = value;
    }
}

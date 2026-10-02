import { SpanStatusCode } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

// instrumentation-pg span names (enums/SpanNames). pg.connect is dropped with
// pool.connect because it nests under it and would otherwise ship orphaned.
const PG_CONNECT_SPAN_NAMES = new Set(['pg-pool.connect', 'pg.connect']);

/** Successful pg connection-checkout spans: sub-ms, no information beyond the sibling query span. */
export function isDroppableSpan(span: ReadableSpan): boolean {
    return PG_CONNECT_SPAN_NAMES.has(span.name) && span.status.code !== SpanStatusCode.ERROR;
}

export class SpanDroppingExporter implements SpanExporter {
    constructor(private readonly inner: SpanExporter) {}

    export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
        const kept = spans.filter((span) => !isDroppableSpan(span));
        if (kept.length === 0) {
            resultCallback({ code: ExportResultCode.SUCCESS });
            return;
        }
        this.inner.export(kept, resultCallback);
    }

    shutdown(): Promise<void> {
        return this.inner.shutdown();
    }

    forceFlush(): Promise<void> {
        return this.inner.forceFlush?.() ?? Promise.resolve();
    }
}

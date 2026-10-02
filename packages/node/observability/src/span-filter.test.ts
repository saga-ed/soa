import { describe, it, expect, vi } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { SpanDroppingExporter, isDroppableSpan } from './span-filter.js';

function span(name: string, code: SpanStatusCode = SpanStatusCode.UNSET): ReadableSpan {
    return { name, status: { code } } as unknown as ReadableSpan;
}

function fakeInner(): SpanExporter & { exported: ReadableSpan[][] } {
    const exported: ReadableSpan[][] = [];
    return {
        exported,
        export: vi.fn((spans: ReadableSpan[], cb: (r: ExportResult) => void) => {
            exported.push(spans);
            cb({ code: ExportResultCode.SUCCESS });
        }),
        shutdown: vi.fn(() => Promise.resolve()),
        forceFlush: vi.fn(() => Promise.resolve()),
    };
}

describe('isDroppableSpan', () => {
    it('drops successful pg connect spans', () => {
        expect(isDroppableSpan(span('pg-pool.connect'))).toBe(true);
        expect(isDroppableSpan(span('pg.connect', SpanStatusCode.OK))).toBe(true);
    });

    it('keeps failed pg connect spans', () => {
        expect(isDroppableSpan(span('pg-pool.connect', SpanStatusCode.ERROR))).toBe(false);
        expect(isDroppableSpan(span('pg.connect', SpanStatusCode.ERROR))).toBe(false);
    });

    it('keeps query and unrelated spans', () => {
        expect(isDroppableSpan(span('pg.query:SELECT iam'))).toBe(false);
        expect(isDroppableSpan(span('GET'))).toBe(false);
    });
});

describe('SpanDroppingExporter', () => {
    it('forwards only kept spans', () => {
        const inner = fakeInner();
        const cb = vi.fn();
        const query = span('pg.query:SELECT iam');
        const failed = span('pg-pool.connect', SpanStatusCode.ERROR);
        new SpanDroppingExporter(inner).export([span('pg-pool.connect'), query, failed], cb);
        expect(inner.exported).toEqual([[query, failed]]);
        expect(cb).toHaveBeenCalledWith({ code: ExportResultCode.SUCCESS });
    });

    it('reports success without calling inner when every span is dropped', () => {
        const inner = fakeInner();
        const cb = vi.fn();
        new SpanDroppingExporter(inner).export([span('pg-pool.connect'), span('pg.connect')], cb);
        expect(inner.export).not.toHaveBeenCalled();
        expect(cb).toHaveBeenCalledWith({ code: ExportResultCode.SUCCESS });
    });

    it('delegates shutdown and forceFlush', async () => {
        const inner = fakeInner();
        const exporter = new SpanDroppingExporter(inner);
        await exporter.forceFlush();
        await exporter.shutdown();
        expect(inner.forceFlush).toHaveBeenCalledOnce();
        expect(inner.shutdown).toHaveBeenCalledOnce();
    });
});

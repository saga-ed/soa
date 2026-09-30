/**
 * `dbStatementSerializer` for @opentelemetry/instrumentation-mongodb.
 *
 * Same output as the default (every leaf → '?'), except BSON values and byte
 * buffers must collapse to one '?': the default walks them per byte on the
 * event loop, seconds per MB of blob.
 */
export function mongoDbStatementSerializer(commandObj: Record<string, unknown>): string {
    return JSON.stringify(scrub(commandObj));
}

function scrub(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(scrub);
    if (typeof value !== 'object' || value === null) return '?';
    if (isOpaque(value)) return '?';
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
}

function isOpaque(value: object): boolean {
    return (
        ArrayBuffer.isView(value) ||
        value instanceof ArrayBuffer ||
        typeof (value as { _bsontype?: unknown })._bsontype === 'string'
    );
}

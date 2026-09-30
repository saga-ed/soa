import { describe, it, expect } from 'vitest';
import { mongoDbStatementSerializer } from './mongo-statement.js';

const fakeBinary = (bytes: number) => ({
    _bsontype: 'Binary',
    sub_type: 0,
    buffer: Buffer.alloc(bytes),
    position: bytes,
});

describe('mongoDbStatementSerializer', () => {
    it('scrubs leaf values to ? and keeps structure, like the default', () => {
        const out = mongoDbStatementSerializer({
            update: 'snapshots',
            updates: [{ q: { _id: 'abc', version: 3 }, u: { $set: { n: 1 } } }],
        });
        expect(JSON.parse(out)).toEqual({
            update: '?',
            updates: [{ q: { _id: '?', version: '?' }, u: { $set: { n: '?' } } }],
        });
    });

    it('collapses BSON values, Buffers, typed arrays and ArrayBuffers to a single ?', () => {
        const out = mongoDbStatementSerializer({
            blob: fakeBinary(16),
            id: { _bsontype: 'ObjectId', buffer: Buffer.alloc(12) },
            buf: Buffer.from('secret'),
            arr: new Uint8Array(8),
            ab: new ArrayBuffer(8),
        });
        expect(JSON.parse(out)).toEqual({ blob: '?', id: '?', buf: '?', arr: '?', ab: '?' });
    });

    it('does not walk a multi-MB Binary byte by byte', () => {
        const cmd = { update: 'snapshots', updates: [{ u: { $set: { blob: fakeBinary(2 * 1024 * 1024) } } }] };
        const start = performance.now();
        const out = mongoDbStatementSerializer(cmd);
        expect(performance.now() - start).toBeLessThan(50);
        expect(out.length).toBeLessThan(200);
    });
});

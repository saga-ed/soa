import { z } from 'zod';
import type { PayloadDescriptor } from '@saga-ed/soa-event-envelope';
import { describe, expect, it } from 'vitest';
import { renderSnapshot, snapshotFilename } from '../lib/snapshot.js';

// Byte stability is the load-bearing invariant of contract-check: if
// renderSnapshot's output drifts (indent, key order, trailing newline,
// $id format, default $schema), every committed snapshot is silently
// invalidated. These tests pin the canonical bytes.

describe('snapshotFilename', () => {
    it('translates eventKey suffix .vN into filename suffix -vN.json', () => {
        expect(snapshotFilename('iam.user.created.v1')).toBe('iam.user.created-v1.json');
    });

    it('handles multi-digit versions', () => {
        expect(snapshotFilename('foo.bar.v10')).toBe('foo.bar-v10.json');
        expect(snapshotFilename('foo.bar.v123')).toBe('foo.bar-v123.json');
    });

    it('leaves a key without a version suffix unchanged (degenerate input)', () => {
        // Documents the behavior — the regex only fires on `.v\d+$`. Adopters
        // shouldn't construct keys without a version anyway, but we shouldn't
        // crash on them.
        expect(snapshotFilename('iam.user.created')).toBe('iam.user.created.json');
    });
});

describe('renderSnapshot', () => {
    const payloadSchema = z.object({ id: z.string(), count: z.number() });
    const descriptor: PayloadDescriptor<z.infer<typeof payloadSchema>> = {
        eventType: 'test.thing.created',
        eventVersion: 1,
        payloadSchema,
    };

    it('produces canonical bytes (golden) for a simple schema', () => {
        const out = renderSnapshot('test.thing.created.v1', descriptor);
        // 4-space indent, trailing newline, key order, default $id prefix.
        // Any change here means every committed snapshot must be regenerated.
        expect(out).toBe(
            `{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "$id": "https://saga-ed.example.local/events/test.thing.created-v1.json",
    "eventType": "test.thing.created",
    "eventVersion": 1,
    "payload": {
        "type": "object",
        "properties": {
            "id": {
                "type": "string"
            },
            "count": {
                "type": "number"
            }
        },
        "required": [
            "id",
            "count"
        ],
        "additionalProperties": false,
        "$schema": "http://json-schema.org/draft-07/schema#"
    }
}
`,
        );
    });

    it('is deterministic across repeated calls', () => {
        const a = renderSnapshot('test.thing.created.v1', descriptor);
        const b = renderSnapshot('test.thing.created.v1', descriptor);
        expect(a).toBe(b);
    });

    it('always ends with a single trailing newline', () => {
        const out = renderSnapshot('test.thing.created.v1', descriptor);
        expect(out.endsWith('\n')).toBe(true);
        expect(out.endsWith('\n\n')).toBe(false);
    });

    it('uses 4-space indentation', () => {
        const out = renderSnapshot('test.thing.created.v1', descriptor);
        // First indented line under the top-level object is "    \"$schema\":…".
        expect(out).toMatch(/\n {4}"\$schema":/);
    });

    it('respects an explicit snapshotIdPrefix', () => {
        const out = renderSnapshot('test.thing.created.v1', descriptor, 'https://example.com/');
        expect(out).toContain('"$id": "https://example.com/test.thing.created-v1.json"');
        // And does not leak into the payload schema.
        const parsed = JSON.parse(out) as { payload: { $schema: string } };
        expect(parsed.payload.$schema).toBe('http://json-schema.org/draft-07/schema#');
    });

    it('uses the default snapshotIdPrefix when omitted', () => {
        // Pinned because the default URL is part of every committed snapshot;
        // changing it silently invalidates them.
        const out = renderSnapshot('foo.bar.v1', {
            eventType: 'foo.bar',
            eventVersion: 1,
            payloadSchema: z.object({}),
        });
        expect(out).toContain('"$id": "https://saga-ed.example.local/events/foo.bar-v1.json"');
    });

    it('preserves $refStrategy=none — no inline $refs in the rendered payload', () => {
        // Two structurally identical sub-objects. With $refStrategy other than
        // 'none', zod-to-json-schema would dedupe one to a $ref pointing at
        // the other, producing different bytes depending on encounter order.
        const inner = z.object({ id: z.string() });
        const out = renderSnapshot('foo.bar.v1', {
            eventType: 'foo.bar',
            eventVersion: 1,
            payloadSchema: z.object({ a: inner, b: inner }),
        });
        expect(out).not.toContain('"$ref"');
    });
});

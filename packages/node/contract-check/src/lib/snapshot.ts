import { z } from 'zod';
import type { PayloadDescriptor } from '@saga-ed/soa-event-envelope';

const DEFAULT_ID_PREFIX = 'https://saga-ed.example.local/events/';

/**
 * Filename convention for committed snapshots: `iam.user.created-v1.json`
 * (NOT `.v1` in filename). The `eventKey` form `iam.user.created.v1` is
 * convenient for Map keys but ugly on disk; the canonical filename uses
 * `-v` to separate.
 */
export function snapshotFilename(eventKey: string): string {
    return `${eventKey.replace(/\.v(\d+)$/, '-v$1')}.json`;
}

/**
 * Render a PayloadDescriptor to the canonical JSON-Schema snapshot string
 * (4-space indent, trailing newline). Stable byte output for diff-gating.
 */
export function renderSnapshot(
    eventKey: string,
    descriptor: PayloadDescriptor<unknown>,
    idPrefix: string = DEFAULT_ID_PREFIX,
): string {
    const filename = snapshotFilename(eventKey);
    // zod 4's native `z.toJSONSchema` replaces the `zod-to-json-schema` library,
    // which introspects zod-3 internals (`._def`) and silently emits empty
    // schemas under zod 4. `target: 'draft-7'` keeps the historical draft-07
    // output; `io: 'input'` snapshots the wire (pre-parse) shape; `$refStrategy`
    // has no analogue — native inlines by default, matching the prior
    // `$refStrategy: 'none'` behaviour.
    const schema = z.toJSONSchema(descriptor.payloadSchema as z.ZodType, {
        target: 'draft-7',
        io: 'input',
    });
    const annotated = {
        $schema: 'http://json-schema.org/draft-07/schema#',
        $id: `${idPrefix}${filename}`,
        eventType: descriptor.eventType,
        eventVersion: descriptor.eventVersion,
        payload: schema,
    };
    return `${JSON.stringify(annotated, null, 4)}\n`;
}

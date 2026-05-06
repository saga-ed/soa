import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
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
    // Cast to ZodTypeAny: the PayloadDescriptor's `payloadSchema: z.ZodType<T>`
    // with `T = unknown` triggers a "type instantiation is excessively deep"
    // error inside zod-to-json-schema's internal generic recursion. We only
    // need the structural conversion here, not type-level T preservation.
    const schema = zodToJsonSchema(descriptor.payloadSchema as ZodTypeAny, {
        target: 'jsonSchema7',
        // Stable, deterministic output: no auto $ref deduplication.
        $refStrategy: 'none',
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

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { entityFields } from '../manifest.js';
import { defineEntity } from '../types.js';

function fieldsOf(schema: z.ZodTypeAny, pii: string[] = []) {
    return entityFields(
        defineEntity({ name: 't', schema, pii, list: async () => ({ rows: [], total: 0 }) }),
    );
}

describe('entityFields', () => {
    it('extracts primitive types with optional/nullable flags', () => {
        const fields = fieldsOf(
            z.object({
                id: z.string(),
                count: z.number().nullable(),
                note: z.string().optional(),
                active: z.boolean().default(true),
                at: z.date(),
            }),
        );
        const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
        expect(byName.id).toMatchObject({ type: 'string', optional: false, nullable: false });
        expect(byName.count).toMatchObject({ type: 'number', nullable: true });
        expect(byName.note).toMatchObject({ type: 'string', optional: true });
        expect(byName.active).toMatchObject({ type: 'boolean', optional: true });
        expect(byName.at).toMatchObject({ type: 'date' });
    });

    it('unwraps stacked wrappers (optional + nullable)', () => {
        const fields = fieldsOf(z.object({ v: z.string().nullable().optional() }));
        expect(fields[0]).toMatchObject({ type: 'string', optional: true, nullable: true });
    });

    it('flags pii fields from the descriptor list', () => {
        const fields = fieldsOf(z.object({ id: z.string(), email: z.string() }), ['email']);
        expect(fields.find((f) => f.name === 'email')?.pii).toBe(true);
        expect(fields.find((f) => f.name === 'id')?.pii).toBe(false);
    });

    it('returns [] for non-object schemas instead of throwing', () => {
        expect(fieldsOf(z.array(z.string()) as unknown as z.ZodTypeAny)).toEqual([]);
    });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { transformer } from '@openfga/syntax-transformer';
import { describe, expect, it } from 'vitest';
import { FGA_TYPES } from '../types.js';

/**
 * Verify that every type declared in src/types.ts is present in model.fga.
 * Catches drift if someone edits one without the other.
 */
const modelText = readFileSync(
    resolve(__dirname, '../../model.fga'),
    'utf8',
);

describe('model.fga ↔ src/types.ts', () => {
    it.each(FGA_TYPES)(
        'declares %s in the .fga DSL',
        (type) => {
            expect(modelText).toMatch(new RegExp(`^type ${type}\\b`, 'm'));
        },
    );

    it('declares schema 1.1', () => {
        expect(modelText).toMatch(/^\s*schema 1\.1\b/m);
    });

    it('starts with the model keyword', () => {
        expect(modelText).toMatch(/^model$/m);
    });
});

/**
 * The regex checks above only prove the type names *appear* — they do not
 * prove the DSL is well-formed. The OpenFGA transformer is strict (it rejects
 * multi-line `or`/`and` continuations, for instance), so transforming the model
 * is the only thing that proves it would actually load into a store. This is
 * the test that bites on a malformed model.fga before it ships.
 */
describe('model.fga is a valid OpenFGA model', () => {
    it('transforms without throwing', () => {
        expect(() =>
            transformer.transformDSLToJSONObject(modelText),
        ).not.toThrow();
    });

    it('compiles to exactly the FGA_TYPES type set', () => {
        const json = transformer.transformDSLToJSONObject(modelText);
        expect(json.type_definitions).toHaveLength(FGA_TYPES.length);
        expect(json.type_definitions.map((t) => t.type).sort()).toEqual(
            [...FGA_TYPES].sort(),
        );
    });

    it('compiles to schema 1.1', () => {
        const json = transformer.transformDSLToJSONObject(modelText);
        expect(json.schema_version).toBe('1.1');
    });
});

/**
 * SEC-CRIT-2: the staff control-plane is a DISTINCT namespace. `staff_org`
 * must NOT reuse the `admin` relation (that would overwrite tenant.admin and
 * feed the `admin from parent` cascades), and must NOT inherit admin from a
 * resource parent. These assertions fail CI if a future edit collapses the
 * staff namespace back into the resource tree.
 */
describe('staff control-plane namespace (SEC-CRIT-2)', () => {
    const json = transformer.transformDSLToJSONObject(modelText);
    const byType = Object.fromEntries(
        json.type_definitions.map((t) => [t.type, t]),
    );

    it('declares the staff types', () => {
        expect(byType.saga_platform).toBeDefined();
        expect(byType.staff_org).toBeDefined();
    });

    it('saga_platform exposes the computed capabilities', () => {
        const rels = Object.keys(byType.saga_platform.relations ?? {});
        expect(rels).toEqual(
            expect.arrayContaining([
                'can_impersonate',
                'can_create_org',
                'can_admin_personas',
                'can_manage_staff',
            ]),
        );
    });

    it('staff_org uses staff_admin and NEVER admin (SEC-CRIT-2)', () => {
        const rels = Object.keys(byType.staff_org.relations ?? {});
        expect(rels).toContain('staff_admin');
        expect(rels).not.toContain('admin');
    });

    it('staff_org has no `from parent` cascade into the resource tree', () => {
        // No relation on staff_org may resolve through a `parent` edge —
        // the only computed-userset source allowed is `platform`.
        const relations = byType.staff_org.relations ?? {};
        const serialized = JSON.stringify(relations);
        expect(serialized).not.toMatch(/"relation"\s*:\s*"parent"/);
        expect(byType.staff_org.relations).not.toHaveProperty('parent');
    });
});

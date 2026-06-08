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

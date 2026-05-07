import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

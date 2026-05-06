import { describe, expect, it } from 'vitest';
import { id } from '../uuid.js';

describe('id()', () => {
    it('produces UUID-v4-shaped output', () => {
        const out = id('mem-child');
        expect(out).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
        );
    });

    it('is deterministic for the same seed', () => {
        expect(id('foo')).toBe(id('foo'));
    });

    it('produces distinct values for distinct seeds', () => {
        expect(id('a')).not.toBe(id('b'));
    });
});

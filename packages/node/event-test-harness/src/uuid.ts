import { createHash } from 'node:crypto';

/**
 * Deterministic UUID-v4-shaped string from a memorable seed.
 *
 * Used in unit tests so fixture IDs satisfy event-payload schema validation
 * (`z.string().uuid()`) while keeping the source readable: `id('mem-child')`
 * instead of an opaque hex literal. Same seed always returns the same UUID
 * so cross-references between fixtures stay coherent.
 */
export const id = (seed: string): string => {
    const h = createHash('md5').update(seed).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

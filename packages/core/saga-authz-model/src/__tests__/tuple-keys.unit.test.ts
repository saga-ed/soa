import { describe, expect, it } from 'vitest';
import {
    objectRef,
    tupleKey,
    userRef,
    usersetRef,
} from '../tuple-keys.js';

describe('objectRef', () => {
    it('builds a typed object ref', () => {
        expect(objectRef('program', 'p1')).toBe('program:p1');
    });

    it('rejects invalid id characters', () => {
        expect(() => objectRef('program', 'has space')).toThrow();
        expect(() => objectRef('program', 'has:colon')).toThrow();
    });
});

describe('userRef', () => {
    it('builds a user ref from a uuid', () => {
        expect(userRef('00000000-0000-4000-8000-000000000001')).toBe(
            'user:00000000-0000-4000-8000-000000000001',
        );
    });
});

describe('usersetRef', () => {
    it('builds a userset reference', () => {
        expect(usersetRef('group', 'g1', 'member')).toBe('group:g1#member');
    });

    it('builds a tenant member userset', () => {
        expect(usersetRef('tenant', 'd42', 'member')).toBe(
            'tenant:d42#member',
        );
    });
});

describe('tupleKey', () => {
    it('builds a fully-typed tuple', () => {
        const t = tupleKey({
            user: userRef('00000000-0000-4000-8000-000000000001'),
            relation: 'viewer',
            object: objectRef('program', 'p1'),
        });
        expect(t).toEqual({
            user: 'user:00000000-0000-4000-8000-000000000001',
            relation: 'viewer',
            object: 'program:p1',
        });
    });
});

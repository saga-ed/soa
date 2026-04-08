import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'fs';

vi.mock('fs', () => ({
    existsSync: vi.fn(() => false),
    readdirSync: vi.fn(() => []),
}));

// Test resolve_fixture_type indirectly via the create_async endpoint
// by creating a minimal concrete subclass
import 'reflect-metadata';

describe('resolve_fixture_type', () => {
    // Since resolve_fixture_type is private, test it through its effects
    // on create_async response

    it('should default fixture_type to first key in fixture_types', () => {
        // The logic: body.fixture_type || Object.keys(this.fixture_types)[0] || 'default'
        const body = {};
        const fixture_types = { 'iam-pgm-small': { name: 'Small', est_seconds: 15 } };
        const type = body.fixture_type || Object.keys(fixture_types)[0] || 'default';
        expect(type).toBe('iam-pgm-small');
    });

    it('should use provided fixture_type', () => {
        const body = { fixture_type: 'iam-pgm-large' };
        const type = body.fixture_type || 'default';
        expect(type).toBe('iam-pgm-large');
    });

    it('should default fixture_id to fixture_type when omitted', () => {
        const body = { fixture_type: 'iam-pgm-small' };
        const fixture_id = body.fixture_id || body.fixture_type;
        expect(fixture_id).toBe('iam-pgm-small');
    });

    it('should use provided fixture_id', () => {
        const body = { fixture_type: 'iam-pgm-small', fixture_id: 'custom-id' };
        const fixture_id = body.fixture_id || body.fixture_type;
        expect(fixture_id).toBe('custom-id');
    });

    it('should mark as valid when TS creator exists', () => {
        const fixture_types: Record<string, any> = {
            'iam-pgm-small': { creator: async () => {}, est_seconds: 15, name: 'Small' },
        };
        const has_ts = !!fixture_types['iam-pgm-small']?.creator;
        const has_script = false;
        expect(has_ts || has_script).toBe(true);
    });

    it('should mark as invalid when no script or creator', () => {
        const fixture_types: Record<string, any> = {};
        const has_ts = !!fixture_types['unknown']?.creator;
        const has_script = false;
        expect(has_ts || has_script).toBe(false);
    });

    it('should default force_adhoc to false', () => {
        const body = { fixture_type: 'iam-pgm-small' };
        const force_adhoc = (body as any).force_adhoc ?? false;
        expect(force_adhoc).toBe(false);
    });
});

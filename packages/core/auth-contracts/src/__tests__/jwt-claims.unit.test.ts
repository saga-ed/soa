import { describe, expect, it } from 'vitest';
import {
    audienceMatches,
    CanonicalJwtClaimsSchema,
    isExpired,
    isServiceToken,
    isUserToken,
    TenantIdSchema,
} from '../jwt-claims.js';

const validUserUuid = '00000000-0000-4000-8000-000000000001';

const validUserClaims = {
    iss: 'https://auth.saga.dev',
    aud: 'spiffe://saga.dev/programs-api',
    sub: `spiffe://saga.dev/user/${validUserUuid}`,
    iat: 1_700_000_000,
    exp: 1_700_000_900,
    jti: 'jti-1',
    'saga.tenant': 'district:42',
    'saga.session': 'session-abc',
};

const validServiceClaims = {
    iss: 'https://auth.saga.dev',
    aud: 'spiffe://saga.dev/programs-api',
    sub: 'spiffe://saga.dev/iam-api/outbox-relay',
    iat: 1_700_000_000,
    exp: 1_700_000_900,
    jti: 'jti-2',
};

describe('TenantIdSchema', () => {
    it('accepts well-formed district id', () => {
        expect(TenantIdSchema.safeParse('district:42').success).toBe(true);
    });

    it('rejects missing type prefix', () => {
        expect(TenantIdSchema.safeParse('42').success).toBe(false);
    });

    it('rejects unknown type', () => {
        expect(TenantIdSchema.safeParse('region:42').success).toBe(false);
    });
});

describe('CanonicalJwtClaimsSchema', () => {
    it('accepts a valid user-token claim set', () => {
        expect(CanonicalJwtClaimsSchema.safeParse(validUserClaims).success).toBe(
            true,
        );
    });

    it('accepts a valid service-token claim set without tenant', () => {
        expect(
            CanonicalJwtClaimsSchema.safeParse(validServiceClaims).success,
        ).toBe(true);
    });

    it('rejects missing required claim', () => {
        const bad: Record<string, unknown> = { ...validUserClaims };
        delete bad.sub;
        expect(CanonicalJwtClaimsSchema.safeParse(bad).success).toBe(false);
    });

    it('rejects malformed sub', () => {
        const bad = { ...validUserClaims, sub: 'not-spiffe' };
        expect(CanonicalJwtClaimsSchema.safeParse(bad).success).toBe(false);
    });

    it('rejects malformed tenant', () => {
        const bad = { ...validUserClaims, 'saga.tenant': 'badformat' };
        expect(CanonicalJwtClaimsSchema.safeParse(bad).success).toBe(false);
    });

    it('rejects non-URL iss', () => {
        const bad = { ...validUserClaims, iss: 'not-a-url' };
        expect(CanonicalJwtClaimsSchema.safeParse(bad).success).toBe(false);
    });

    it('accepts string or array audience', () => {
        const arr = {
            ...validUserClaims,
            aud: ['spiffe://saga.dev/programs-api', 'spiffe://saga.dev/qboard'],
        };
        expect(CanonicalJwtClaimsSchema.safeParse(arr).success).toBe(true);
    });

    it('accepts cnf.jkt for DPoP-bound tokens', () => {
        const claims = {
            ...validUserClaims,
            cnf: { jkt: 'a'.repeat(43) },
        };
        expect(CanonicalJwtClaimsSchema.safeParse(claims).success).toBe(true);
    });

    it('rejects cnf.jkt that is too short', () => {
        const claims = { ...validUserClaims, cnf: { jkt: 'tooshort' } };
        expect(CanonicalJwtClaimsSchema.safeParse(claims).success).toBe(false);
    });
});

describe('isUserToken / isServiceToken', () => {
    it('detects user tokens', () => {
        const parsed = CanonicalJwtClaimsSchema.parse(validUserClaims);
        expect(isUserToken(parsed)).toBe(true);
        expect(isServiceToken(parsed)).toBe(false);
    });

    it('detects service tokens', () => {
        const parsed = CanonicalJwtClaimsSchema.parse(validServiceClaims);
        expect(isServiceToken(parsed)).toBe(true);
        expect(isUserToken(parsed)).toBe(false);
    });
});

describe('audienceMatches', () => {
    it('matches string audience', () => {
        const c = CanonicalJwtClaimsSchema.parse(validUserClaims);
        expect(audienceMatches(c, 'spiffe://saga.dev/programs-api')).toBe(true);
        expect(audienceMatches(c, 'spiffe://saga.dev/qboard')).toBe(false);
    });

    it('matches one element of array audience', () => {
        const claims = {
            ...validUserClaims,
            aud: ['spiffe://saga.dev/programs-api', 'spiffe://saga.dev/qboard'],
        };
        const c = CanonicalJwtClaimsSchema.parse(claims);
        expect(audienceMatches(c, 'spiffe://saga.dev/qboard')).toBe(true);
        expect(audienceMatches(c, 'spiffe://saga.dev/rtsm')).toBe(false);
    });
});

describe('isExpired', () => {
    it('treats past exp as expired', () => {
        const c = { exp: 1_000 };
        expect(isExpired(c, 2_000)).toBe(true);
    });

    it('treats future exp as not expired', () => {
        const c = { exp: 2_000 };
        expect(isExpired(c, 1_000)).toBe(false);
    });

    it('honors clock skew tolerance', () => {
        // exp=1000, now=1010, default skew=30 → not expired (1010 - 30 < 1000? no, 980 < 1000 true → not expired)
        expect(isExpired({ exp: 1_000 }, 1_010)).toBe(false);
        // exp=1000, now=1031, default skew=30 → expired (1031 - 30 = 1001 > 1000)
        expect(isExpired({ exp: 1_000 }, 1_031)).toBe(true);
    });
});

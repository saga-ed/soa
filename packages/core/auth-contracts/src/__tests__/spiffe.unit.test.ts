import { describe, expect, it } from 'vitest';
import {
    asUserSpiffeId,
    buildServiceSpiffeId,
    buildUserSpiffeId,
    parseSpiffeId,
    parseSpiffeIdOrThrow,
    SpiffeIdSchema,
    spiffeIdForEnv,
} from '../spiffe.js';

describe('parseSpiffeId', () => {
    it('parses a service SPIFFE ID', () => {
        const id = parseSpiffeId('spiffe://saga.dev/iam-api');
        expect(id).toMatchObject({
            env: 'dev',
            trustDomain: 'saga.dev',
            service: 'iam-api',
            component: null,
        });
    });

    it('parses a service SPIFFE ID with component', () => {
        const id = parseSpiffeId('spiffe://saga.prod/iam-api/outbox-relay');
        expect(id).toMatchObject({
            env: 'prod',
            service: 'iam-api',
            component: 'outbox-relay',
        });
    });

    it('parses a user SPIFFE ID', () => {
        const uuid = '00000000-0000-4000-8000-000000000001';
        const id = parseSpiffeId(`spiffe://saga.dev/user/${uuid}`);
        expect(id?.service).toBe('user');
        expect(id?.component).toBe(uuid);
    });

    it('rejects non-saga trust domains', () => {
        expect(parseSpiffeId('spiffe://other.example/foo')).toBeNull();
    });

    it('rejects unknown saga env', () => {
        expect(parseSpiffeId('spiffe://saga.qa/iam-api')).toBeNull();
    });

    it('rejects malformed service names', () => {
        expect(parseSpiffeId('spiffe://saga.dev/IamApi')).toBeNull();
        expect(parseSpiffeId('spiffe://saga.dev/-leading')).toBeNull();
        expect(parseSpiffeId('spiffe://saga.dev/trailing-')).toBeNull();
    });

    it('rejects extra segments', () => {
        expect(parseSpiffeId('spiffe://saga.dev/a/b/c')).toBeNull();
    });

    it('rejects empty path', () => {
        expect(parseSpiffeId('spiffe://saga.dev/')).toBeNull();
        expect(parseSpiffeId('spiffe://saga.dev')).toBeNull();
    });

    it('rejects query and fragment', () => {
        expect(parseSpiffeId('spiffe://saga.dev/iam-api?foo=bar')).toBeNull();
        expect(parseSpiffeId('spiffe://saga.dev/iam-api#frag')).toBeNull();
    });

    it('rejects non-spiffe scheme', () => {
        expect(parseSpiffeId('https://saga.dev/iam-api')).toBeNull();
    });

    it('rejects non-strings', () => {
        expect(parseSpiffeId(null as unknown as string)).toBeNull();
        expect(parseSpiffeId(undefined as unknown as string)).toBeNull();
    });
});

describe('parseSpiffeIdOrThrow', () => {
    it('returns parsed on valid', () => {
        expect(parseSpiffeIdOrThrow('spiffe://saga.dev/iam-api')).toBeTruthy();
    });

    it('throws on invalid', () => {
        expect(() => parseSpiffeIdOrThrow('not-a-spiffe-id')).toThrow();
    });
});

describe('buildServiceSpiffeId', () => {
    it('builds a basic service id', () => {
        expect(
            buildServiceSpiffeId({ env: 'dev', service: 'iam-api' }),
        ).toBe('spiffe://saga.dev/iam-api');
    });

    it('builds with component', () => {
        expect(
            buildServiceSpiffeId({
                env: 'prod',
                service: 'iam-api',
                component: 'fga-sync',
            }),
        ).toBe('spiffe://saga.prod/iam-api/fga-sync');
    });

    it('round-trips with parseSpiffeId', () => {
        const built = buildServiceSpiffeId({
            env: 'staging',
            service: 'programs-api',
        });
        expect(parseSpiffeId(built)?.service).toBe('programs-api');
    });

    it('rejects bad service names', () => {
        expect(() =>
            buildServiceSpiffeId({ env: 'dev', service: 'BadName' }),
        ).toThrow();
    });
});

describe('buildUserSpiffeId', () => {
    it('builds a user id', () => {
        const uuid = '00000000-0000-4000-8000-000000000001';
        expect(buildUserSpiffeId({ env: 'dev', userUuid: uuid })).toBe(
            `spiffe://saga.dev/user/${uuid}`,
        );
    });

    it('rejects bad UUIDs', () => {
        expect(() =>
            buildUserSpiffeId({ env: 'dev', userUuid: 'not-a-uuid' }),
        ).toThrow();
    });
});

describe('asUserSpiffeId', () => {
    it('returns user identity for user IDs', () => {
        const uuid = '00000000-0000-4000-8000-000000000001';
        const parsed = parseSpiffeIdOrThrow(`spiffe://saga.dev/user/${uuid}`);
        const user = asUserSpiffeId(parsed);
        expect(user?.userUuid).toBe(uuid);
    });

    it('returns null for service IDs', () => {
        const parsed = parseSpiffeIdOrThrow('spiffe://saga.dev/iam-api');
        expect(asUserSpiffeId(parsed)).toBeNull();
    });

    it('returns null when component is not a UUID', () => {
        const parsed = parseSpiffeIdOrThrow('spiffe://saga.dev/user/notauuid');
        expect(asUserSpiffeId(parsed)).toBeNull();
    });
});

describe('SpiffeIdSchema', () => {
    it('parses valid SPIFFE IDs', () => {
        expect(
            SpiffeIdSchema.safeParse('spiffe://saga.dev/iam-api').success,
        ).toBe(true);
    });

    it('rejects invalid SPIFFE IDs', () => {
        expect(SpiffeIdSchema.safeParse('not-spiffe').success).toBe(false);
    });
});

describe('spiffeIdForEnv', () => {
    it('accepts matching env', () => {
        const schema = spiffeIdForEnv('prod');
        expect(schema.safeParse('spiffe://saga.prod/iam-api').success).toBe(true);
    });

    it('rejects mismatched env', () => {
        const schema = spiffeIdForEnv('prod');
        expect(schema.safeParse('spiffe://saga.dev/iam-api').success).toBe(
            false,
        );
    });
});

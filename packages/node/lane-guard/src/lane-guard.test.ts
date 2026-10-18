import { describe, expect, it, vi } from 'vitest';
import { assertLaneSafe, checkLaneSafety, LaneGuardError, resolveLane } from './index.js';

const DEV = '396913734878';
const PROD = '531314149529';

const clean = {
    LANE: 'twin',
    EXEC_ENV: 'prod',
    DD_ENV: 'mirror',
    DATABASE_URL: 'postgres://u:pw@mirror-pg.dev.internal:5432/db',
    AMQP_URL: 'amqps://u:pw@mq.dev.internal:5671',
    REDIS_URL: 'redis://cache.dev.internal:6379',
    MAIL_PROVIDER: 'stub',
};

const checks = (env: Record<string, string>, opts: object = { accountId: DEV }) =>
    checkLaneSafety({ ...clean, ...env }, opts).map((x) => x.check);

describe('assertLaneSafe', () => {
    const opts = { accountId: DEV };

    it.each(['twin', 'mirror'])('passes a clean LANE=%s env with EXEC_ENV=prod', (lane) => {
        expect(checkLaneSafety({ ...clean, LANE: lane }, opts)).toEqual([]);
        expect(() => assertLaneSafe({ ...clean, LANE: lane }, opts)).not.toThrow();
    });

    it('activates on LANE regardless of EXEC_ENV', () => {
        for (const EXEC_ENV of ['prod', 'dev', 'mirror', undefined]) {
            const env: Record<string, string | undefined> = { ...clean, EXEC_ENV, DD_ENV: 'prod' };
            expect(() => assertLaneSafe(env, opts)).toThrow(LaneGuardError);
        }
    });

    it.each([undefined, '', '  ', 'none', 'NONE'])('is a no-op when LANE=%j, even with prod values', (lane) => {
        const env = { LANE: lane, EXEC_ENV: 'prod', DD_ENV: 'prod', MAIL_PROVIDER: 'ses', CLEVER_ID: 'x', U: 'redis://a.prod.internal' };
        expect(() => assertLaneSafe(env)).not.toThrow();
        expect(checkLaneSafety(env)).toEqual([]);
    });

    it('accepts LANE case-insensitively and trimmed', () => {
        expect(resolveLane({ LANE: ' Twin ' }).lane).toBe('twin');
    });

    it('defaults to process.env', () => {
        expect(() => assertLaneSafe()).not.toThrow();
    });

    it('aggregates all violations into one error', () => {
        const env = { ...clean, DD_ENV: 'prod', MAIL_PROVIDER: 'ses', CLEVER_SECRET: 's' };
        let err: unknown;
        try {
            assertLaneSafe(env, opts);
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(LaneGuardError);
        const e = err as LaneGuardError;
        expect(e.violations.map((x) => x.check).sort()).toEqual(['dd-env', 'partner-egress', 'ses']);
        expect(e.message).toContain('DD_ENV');
        expect(e.message).toContain('MAIL_PROVIDER');
        expect(e.message).toContain('CLEVER_SECRET');
        expect(e.message).toContain('LANE=twin');
    });
});

describe('lane identity', () => {
    it.each(['prod', 'dev', 'twinn', 'true', '0'])('fails closed on unknown LANE=%s', (lane) => {
        const env = { LANE: lane, DD_ENV: 'dev' };
        expect(checkLaneSafety(env, { accountId: DEV }).map((x) => x.check)).toEqual(['lane-identity']);
        expect(() => assertLaneSafe(env)).toThrow(LaneGuardError);
    });

    it('does not print the unknown LANE value', () => {
        try {
            assertLaneSafe({ LANE: 'sekret-val' });
        } catch (e) {
            expect((e as Error).message).not.toContain('sekret-val');
        }
    });

    it('fails closed when LANE=none contradicts EXEC_ENV=mirror', () => {
        expect(checkLaneSafety({ LANE: 'none', EXEC_ENV: 'mirror' }).map((x) => x.check)).toEqual(['lane-identity']);
    });
});

describe('deprecated EXEC_ENV=mirror alias', () => {
    const legacy = { ...clean, LANE: undefined, EXEC_ENV: 'mirror' };

    it('resolves to the mirror lane only when LANE is unset', () => {
        expect(resolveLane(legacy)).toMatchObject({ lane: 'mirror', viaDeprecatedAlias: true });
        expect(resolveLane({ ...legacy, LANE: 'twin' })).toMatchObject({ lane: 'twin', viaDeprecatedAlias: false });
    });

    it('still enforces the checks and warns once', () => {
        const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
        expect(() => assertLaneSafe({ ...legacy, DD_ENV: 'prod' }, { accountId: DEV })).toThrow(/dd-env/);
        expect(() => assertLaneSafe({ ...legacy, DD_ENV: 'prod' }, { accountId: DEV })).toThrow(LaneGuardError);
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });
});

describe('DD_ENV', () => {
    it.each([undefined, '', '  ', 'prod', 'PRODUCTION'])('flags %j', (dd) => {
        const env: Record<string, string | undefined> = { ...clean, DD_ENV: dd };
        expect(checkLaneSafety(env, { accountId: DEV }).map((x) => x.check)).toEqual(['dd-env']);
    });

    it.each(['twin', 'mirror', 'dev'])('allows DD_ENV=%s', (dd) => {
        expect(checks({ DD_ENV: dd })).toEqual([]);
    });

    it.each([
        ['OTEL_RESOURCE_ATTRIBUTES', 'service.name=x,deployment.environment=prod'],
        ['OTEL_RESOURCE_ATTRIBUTES', 'deployment.environment.name=Production'],
        ['OTEL_DEPLOYMENT_ENVIRONMENT', 'prod'],
    ])('flags %s=%s', (name, value) => {
        expect(checks({ [name]: value })).toEqual(['dd-env']);
    });

    it('allows non-prod deployment.environment', () => {
        expect(checks({ OTEL_RESOURCE_ATTRIBUTES: 'service.name=x,deployment.environment=twin' })).toEqual([]);
    });
});

describe('prod-named SSM paths (account check)', () => {
    const shared = 'arn:aws:ssm:us-west-2:396913734878:parameter/shared/infra/prod/db/password-abc123';

    it.each([shared, '/shared/infra/prod/db/password', '/prod/rostering/x', 'a=1,/prod/x'])(
        'allows %s in the dev account',
        (value) => {
            expect(checks({ P: value }, { accountId: DEV })).toEqual([]);
        },
    );

    it('rejects a prod-named path when the account is prod', () => {
        expect(checks({ P: shared }, { accountId: PROD })).toEqual(['prod-secret-path', 'aws-account']);
        expect(checks({ P: '/prod/x' }, { accountId: PROD })).toEqual(['prod-secret-path', 'aws-account']);
    });

    it('rejects a prod-named path when the account is unresolved', () => {
        expect(checks({ P: shared }, {})).toEqual(['prod-secret-path', 'aws-account']);
    });

    it('names the var, never the value', () => {
        const [v] = checkLaneSafety({ ...clean, DB_SECRET: shared }, { accountId: PROD });
        expect(v?.check).toBe('prod-secret-path');
        expect(v?.message).toContain('DB_SECRET');
        expect(v?.message).not.toContain('abc123');
    });

    it('does not treat unrelated prod-ish values as SSM paths', () => {
        expect(checks({ X: 'https://example.com/prod/api', Y: '/shared/infra/dev/db' }, { accountId: PROD })).toEqual(['aws-account']);
    });
});

describe('prod hosts', () => {
    it.each([
        'postgres://u:p@db.prod.example.com:5432/x',
        'postgresql://u:p@prod-pg.example.com/x',
        'amqp://u:p@mq-prod.internal',
        'amqps://u:p@mq.production.internal',
        'redis://cache.prod.internal:6379',
        'rediss://cache-prod.internal',
        'mongodb://u:p@a.dev.internal,b.prod.internal/db',
        'mongodb+srv://u:p@cluster.prod.mongodb.net/db',
    ])('flags %s', (url) => {
        expect(checks({ SOME_URL: url })).toEqual(['prod-host']);
    });

    it('flags a URL embedded in a longer value', () => {
        expect(checks({ OPTS: 'a=1;url=redis://x.prod.internal:6379;b=2' })).toEqual(['prod-host']);
    });

    it('flags plain host vars', () => {
        expect(checks({ PGHOST: 'db.prod.internal' })).toEqual(['prod-host']);
        expect(checks({ REDIS_HOST: 'cache.dev.internal' })).toEqual([]);
    });

    it('does not flag substrings like "product"', () => {
        expect(checks({ U: 'postgres://u:p@productdb.dev.internal/x' })).toEqual([]);
    });

    it('redacts credentials', () => {
        const env = { ...clean, U: 'postgres://admin:s3cr3tPW@db.prod.internal:5432/x' };
        expect(() => assertLaneSafe(env, { accountId: DEV })).toThrow(/prod-matching host/);
        try {
            assertLaneSafe(env, { accountId: DEV });
        } catch (e) {
            expect((e as Error).message).not.toContain('s3cr3tPW');
            expect((e as Error).message).not.toContain('admin');
        }
    });

    it('honors custom patterns', () => {
        const opts = { prodHostPatterns: [/live\./], accountId: DEV };
        expect(checks({ U: 'redis://cache.live.internal' }, opts)).toEqual(['prod-host']);
        expect(checks({ U: 'redis://cache.prod.internal' }, opts)).toEqual([]);
    });

    it('is stable with global-flag patterns', () => {
        const opts = { prodHostPatterns: [/prod/g] };
        const env = { A: 'redis://a.prod', B: 'redis://b.prod' };
        expect(checkLaneSafety({ ...clean, ...env }, { ...opts, accountId: DEV })).toHaveLength(2);
    });
});

describe('SES', () => {
    it('flags MAIL_PROVIDER=ses (case-insensitive)', () => {
        expect(checks({ MAIL_PROVIDER: 'SES' })).toEqual(['ses']);
    });
    it('flags any MAIL_SES_*', () => {
        expect(checks({ MAIL_SES_REGION: 'us-west-2' })).toEqual(['ses']);
    });
    it('ignores empty MAIL_SES_*', () => {
        expect(checks({ MAIL_SES_REGION: '' })).toEqual([]);
    });
});

describe('partner egress', () => {
    it.each(['CLEVER_CLIENT_ID', 'clever_token', 'PARTNER_WEBHOOK', 'SLACK_WEBHOOK_URL', 'ORDER_WEBHOOK_URL'])(
        'flags %s when non-empty',
        (name) => {
            expect(checks({ [name]: 'x' })).toEqual(['partner-egress']);
        },
    );
    it('ignores empty values', () => {
        expect(checks({ CLEVER_CLIENT_ID: '' })).toEqual([]);
    });
});

describe('AWS account', () => {
    it('fails closed when accountId is omitted', () => {
        expect(checks({}, {})).toEqual(['aws-account']);
    });
    it('accepts dev', () => {
        expect(checks({}, { accountId: DEV })).toEqual([]);
    });
    it('flags any other account, including empty', () => {
        expect(checks({}, { accountId: PROD })).toEqual(['aws-account']);
        expect(checks({}, { accountId: '' })).toEqual(['aws-account']);
    });
    it('honors allowedAccountIds', () => {
        expect(checks({}, { accountId: '111', allowedAccountIds: ['111'] })).toEqual([]);
    });
    it('does not print the account id', () => {
        const [v] = checkLaneSafety(clean, { accountId: PROD });
        expect(v?.message).not.toContain(PROD);
    });
});

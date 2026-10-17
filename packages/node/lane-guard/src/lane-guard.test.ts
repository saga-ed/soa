import { describe, expect, it } from 'vitest';
import { assertLaneSafe, checkLaneSafety, LaneGuardError } from './index.js';

const clean = {
    EXEC_ENV: 'mirror',
    DD_ENV: 'mirror',
    DATABASE_URL: 'postgres://u:pw@mirror-pg.dev.internal:5432/db',
    AMQP_URL: 'amqps://u:pw@mq.dev.internal:5671',
    REDIS_URL: 'redis://cache.dev.internal:6379',
    MAIL_PROVIDER: 'stub',
};

const checks = (env: Record<string, string>, opts = {}) =>
    checkLaneSafety({ ...clean, ...env }, opts).map((x) => x.check);

describe('assertLaneSafe', () => {
    it('passes a clean mirror env', () => {
        expect(checkLaneSafety(clean)).toEqual([]);
        expect(() => assertLaneSafe(clean)).not.toThrow();
    });

    it('is a no-op outside mirror, even with prod values', () => {
        const env = { EXEC_ENV: 'prod', DD_ENV: 'prod', MAIL_PROVIDER: 'ses', CLEVER_ID: 'x' };
        expect(() => assertLaneSafe(env)).not.toThrow();
        expect(() => assertLaneSafe({ DD_ENV: 'prod' })).not.toThrow();
    });

    it('defaults to process.env', () => {
        expect(() => assertLaneSafe()).not.toThrow();
    });

    it('aggregates all violations into one error', () => {
        const env = { ...clean, DD_ENV: 'prod', MAIL_PROVIDER: 'ses', CLEVER_SECRET: 's' };
        let err: unknown;
        try {
            assertLaneSafe(env);
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(LaneGuardError);
        const e = err as LaneGuardError;
        expect(e.violations.map((x) => x.check).sort()).toEqual(['dd-env', 'partner-egress', 'ses']);
        expect(e.message).toContain('DD_ENV');
        expect(e.message).toContain('MAIL_PROVIDER');
        expect(e.message).toContain('CLEVER_SECRET');
    });
});

describe('DD_ENV', () => {
    it.each([undefined, '', '  ', 'prod', 'PRODUCTION'])('flags %j', (dd) => {
        const env: Record<string, string | undefined> = { ...clean, DD_ENV: dd };
        expect(checkLaneSafety(env).map((x) => x.check)).toEqual(['dd-env']);
    });
});

describe('prod secret paths', () => {
    it('names the var, never the value', () => {
        const env = { ...clean, DB_SECRET: 'arn:/shared/infra/prod/db/password-abc123' };
        const [v] = checkLaneSafety(env);
        expect(v?.check).toBe('prod-secret-path');
        expect(v?.message).toContain('DB_SECRET');
        expect(v?.message).not.toContain('abc123');
    });

    it('allows dev paths', () => {
        expect(checks({ X: '/shared/infra/dev/db/password' })).toEqual([]);
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
        expect(() => assertLaneSafe(env)).toThrow(/prod-matching host/);
        try {
            assertLaneSafe(env);
        } catch (e) {
            expect((e as Error).message).not.toContain('s3cr3tPW');
            expect((e as Error).message).not.toContain('admin');
        }
    });

    it('honors custom patterns', () => {
        const opts = { prodHostPatterns: [/live\./] };
        expect(checks({ U: 'redis://cache.live.internal' }, opts)).toEqual(['prod-host']);
        expect(checks({ U: 'redis://cache.prod.internal' }, opts)).toEqual([]);
    });

    it('is stable with global-flag patterns', () => {
        const opts = { prodHostPatterns: [/prod/g] };
        const env = { A: 'redis://a.prod', B: 'redis://b.prod' };
        expect(checkLaneSafety({ ...clean, ...env }, opts)).toHaveLength(2);
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
    it('skips when accountId is omitted', () => {
        expect(checks({})).toEqual([]);
    });
    it('accepts dev', () => {
        expect(checks({}, { accountId: '396913734878' })).toEqual([]);
    });
    it('flags any other account, including empty', () => {
        expect(checks({}, { accountId: '531314149529' })).toEqual(['aws-account']);
        expect(checks({}, { accountId: '' })).toEqual(['aws-account']);
    });
    it('honors allowedAccountIds', () => {
        expect(checks({}, { accountId: '111', allowedAccountIds: ['111'] })).toEqual([]);
    });
    it('does not print the account id', () => {
        const [v] = checkLaneSafety(clean, { accountId: '531314149529' });
        expect(v?.message).not.toContain('531314149529');
    });
});

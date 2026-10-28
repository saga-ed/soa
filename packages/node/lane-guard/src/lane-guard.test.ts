import { describe, expect, it, vi } from 'vitest';
import type { EnvIdentity } from '@saga-ed/soa-env';
import { assertLaneSafe, checkLaneSafety, LaneGuardError, resolveLane } from './index.js';

const DEV = '396913734878';
const PROD = '531314149529';

const clean = {
    LANE: 'twin',
    EXEC_ENV: 'prod',
    DD_ENV: 'mirror',
    DATABASE_URL: 'postgres://u:pw@mirror-pg.dev.internal:5432/db',
    AMQP_URL: 'amqps://u:pw@mq.dev.internal:5671/twin',
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
        'amqp://u:p@mq-prod.internal/twin',
        'amqps://u:p@mq.production.internal/twin',
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

describe('MAIL_PROVIDER=capture', () => {
    it('passes on LANE=twin with capture bucket/prefix set', () => {
        const env = { ...clean, MAIL_PROVIDER: 'capture', MAIL_CAPTURE_BUCKET: 'dev-mail-capture', MAIL_CAPTURE_PREFIX: 'twin/' };
        expect(checkLaneSafety(env, { accountId: DEV })).toEqual([]);
        expect(() => assertLaneSafe(env, { accountId: DEV })).not.toThrow();
    });

    it('SES messages name the capture or stub mailer', () => {
        const [v] = checkLaneSafety({ ...clean, MAIL_PROVIDER: 'ses' }, { accountId: DEV });
        expect(v?.message).toContain('capture or stub mailer');
    });
});

describe('soa-env identity cross-check', () => {
    const identity = (lane: 'twin' | 'mirror' | 'none', id?: string): EnvIdentity => ({
        profile: 'dev',
        lane,
        telemetryEnv: lane,
        account: id ? { kind: 'dev', id } : { kind: 'local' },
        row: lane === 'none' ? 'R3-dev-overlay' : 'R2-lane',
    });

    it('agreeing identity adds no violation and supplies accountId', () => {
        expect(checkLaneSafety(clean, { identity: identity('twin', DEV) })).toEqual([]);
    });

    it('explicit accountId wins over identity.account.id', () => {
        expect(checks({}, { accountId: PROD, identity: identity('twin', DEV) })).toEqual(['aws-account']);
    });

    it('identity without an account id still fails closed', () => {
        expect(checks({}, { identity: identity('twin') })).toEqual(['aws-account']);
    });

    it('identity twin vs raw none yields lane-identity (no early return)', () => {
        const env = { ...clean, LANE: 'none' };
        expect(checkLaneSafety(env, { identity: identity('twin', DEV) }).map((x) => x.check)).toEqual(['lane-identity']);
        expect(() => assertLaneSafe(env, { identity: identity('twin', DEV) })).toThrow(LaneGuardError);
    });

    it('identity none vs raw twin yields lane-identity', () => {
        expect(checks({}, { accountId: DEV, identity: identity('none', DEV) })).toEqual(['lane-identity']);
    });

    it('identity mirror vs raw twin yields lane-identity naming both lanes only', () => {
        const [v] = checkLaneSafety(clean, { identity: identity('mirror', DEV) });
        expect(v?.check).toBe('lane-identity');
        expect(v?.message).toContain('mirror');
        expect(v?.message).toContain('twin');
        expect(v?.message).not.toContain(DEV);
    });

    it('both none is a no-op', () => {
        expect(() => assertLaneSafe({ LANE: 'none' }, { identity: identity('none') })).not.toThrow();
    });
});

describe('amqp vhost (twin)', () => {
    const opts = { accountId: DEV };
    const url = (tail: string) => ({ AMQP_URL: `amqps://u:secretpw@mq.dev.internal:5671${tail}` });
    const vhostViolations = (env: Record<string, string>, o: object = opts) =>
        checkLaneSafety({ ...clean, ...env }, o).filter((x) => x.check === 'amqp-vhost');

    it.each(['/twin', '/authz-twin', '/twin-authz', '/authz_twin_v2', '/TWIN', '/%2Ftwin', '/twin?heartbeat=30'])(
        'passes lane-scoped vhost %s',
        (tail) => {
            expect(vhostViolations(url(tail))).toEqual([]);
        },
    );

    it.each(['', '/', '//', '/%2F', '/dev', '/saga-dev', '/shared', '/twinkle', '/untwined', '/%2F?heartbeat=30', '/%ZZ'])(
        'fails vhost %j',
        (tail) => {
            expect(vhostViolations(url(tail))).toHaveLength(1);
        },
    );

    it('decodes URL-encoded vhost before matching', () => {
        expect(vhostViolations(url('/authz%2Dtwin'))).toEqual([]);
        expect(vhostViolations(url('/tw%69n-x'))).toEqual([]);
    });

    it('checks amqp:// and amqps:// alike, in any env var', () => {
        expect(vhostViolations({ RABBITMQ_URL: 'amqp://u:p@mq.dev.internal:5672/dev' })).toHaveLength(1);
        expect(vhostViolations({ X: 'amqp://u:p@mq.dev.internal:5672/twin' })).toEqual([]);
    });

    it('passes when no AMQP URL is configured', () => {
        const { AMQP_URL: _omit, ...noMq } = clean;
        expect(checkLaneSafety(noMq, opts)).toEqual([]);
    });

    it('fails once per offending URL', () => {
        expect(vhostViolations({ ...url('/'), RABBITMQ_URL: 'amqp://u:p@mq.dev.internal/dev' })).toHaveLength(2);
    });

    it('does not apply to LANE=mirror', () => {
        expect(checkLaneSafety({ ...clean, LANE: 'mirror', ...url('/') }, opts)).toEqual([]);
    });

    it('honours an explicit amqpVhostPattern override only', () => {
        const amqpVhostPattern = /^\/?lane-a$/;
        expect(vhostViolations(url('/lane-a'), { ...opts, amqpVhostPattern })).toEqual([]);
        expect(vhostViolations(url('/twin'), { ...opts, amqpVhostPattern })).toHaveLength(1);
        expect(vhostViolations(url('/'), { ...opts, amqpVhostPattern: /.*/ })).toHaveLength(1);
        expect(vhostViolations({ ...url('/dev'), LANE_AMQP_VHOST_PATTERN: '.*' })).toHaveLength(1);
    });

    it('never prints credentials or the URL', () => {
        let msg = '';
        try {
            assertLaneSafe({ ...clean, ...url('/dev') }, opts);
        } catch (e) {
            msg = (e as Error).message;
        }
        expect(msg).toContain('[amqp-vhost] AMQP_URL');
        expect(msg).not.toContain('secretpw');
        expect(msg).not.toContain('mq.dev.internal');
    });
});

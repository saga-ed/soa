import { describe, expect, it, vi } from 'vitest';
import type { EnvIdentity } from '@saga-ed/soa-env';
import {
    assertLaneSafe,
    checkLaneSafety,
    DEFAULT_ALLOWED_HOST_SUFFIXES,
    DEFAULT_NON_EGRESS_VAR_PATTERNS,
    DEFAULT_PROD_PUBLIC_APEXES,
    LaneGuardError,
    resolveLane,
} from './index.js';

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

describe('prod public hosts', () => {
    const opts = { accountId: DEV };
    const hostViolations = (env: Record<string, string>, o: object = opts) =>
        checkLaneSafety({ ...clean, ...env }, o)
            .filter((x) => x.check === 'prod-public-host')
            .map((x) => x.message);

    it('exposes the defaults', () => {
        expect(DEFAULT_PROD_PUBLIC_APEXES).toEqual(['saga.org', 'sagaops.org']);
        expect(DEFAULT_ALLOWED_HOST_SUFFIXES).toEqual(['internal.saga.org', 'dbs.internal']);
        expect(DEFAULT_NON_EGRESS_VAR_PATTERNS.length).toBeGreaterThan(0);
    });

    it.each([
        ['IAM_API_URL', 'https://iam.saga.org'],
        ['PUBLIC_API_URL', 'https://connectv3-api.saga.org'],
        ['AUTH_JWKSURL', 'https://iam.saga.org/.well-known/jwks.json'],
        ['STAFFGATE_JWKSURL', 'https://gate.sagaops.org/.well-known/jwks.json'],
        ['RTSM_API_URL', 'https://core-a.rtsm.saga.org'],
        ['RECORDER_URL_TEMPLATE', 'https://recorder-{node}.fleek.saga.org'],
        ['SOME_WS', 'wss://chi-1.fleek.saga.org'],
        ['SOME_APEX', 'https://saga.org'],
        ['PORTED', 'http://iam.saga.org:8443/x'],
        ['UPPER', 'HTTPS://IAM.SAGA.ORG'],
        ['TRAILING_DOT', 'https://iam.saga.org./x'],
        ['AMQP_PROD', 'amqps://u:pw@mq.saga.org:5671'],
    ])('rejects %s=%s', (name, value) => {
        const msgs = hostViolations({ [name]: value });
        expect(msgs).toHaveLength(1);
        expect(msgs[0]).toContain(`${name} references prod public host`);
    });

    it('rejects a bare host in a HOST/HOSTNAME/DOMAIN/ENDPOINT var', () => {
        for (const name of ['JANUS_LOGIN_HOST', 'API_HOSTNAME', 'FLEEK_DOMAIN', 'S3_ENDPOINT']) {
            expect(hostViolations({ [name]: 'login.saga.org' })).toHaveLength(1);
        }
        expect(hostViolations({ S3_ENDPOINT: 'iam.saga.org:443/path' })).toHaveLength(1);
        expect(hostViolations({ UPSTREAM_HOST: 'ok.wootdev.com, iam.saga.org' })).toHaveLength(1);
        expect(hostViolations({ UPSTREAM_HOST: 'ok.wootdev.com iam.saga.org' })).toHaveLength(1);
        expect(hostViolations({ UPSTREAM_HOST: 'ok.wootdev.com' })).toEqual([]);
    });

    it('ignores a bare prod host in a var whose name is not host-like', () => {
        expect(hostViolations({ SOME_LABEL: 'login.saga.org' })).toEqual([]);
    });

    it('finds a prod host in the second entry of a comma-separated URL list', () => {
        const msgs = hostViolations({ UPSTREAMS: 'https://a.wootdev.com,https://iam.saga.org' });
        expect(msgs).toEqual(['UPSTREAMS references prod public host "iam.saga.org"']);
    });

    it('finds a prod host in a comma-separated authority and in a space-separated list', () => {
        expect(hostViolations({ U: 'https://a.wootdev.com,iam.saga.org/x' })).toHaveLength(1);
        expect(hostViolations({ U: 'https://a.wootdev.com https://iam.saga.org' })).toHaveLength(1);
    });

    it('finds hosts inside a JSON value', () => {
        const topology = '{"domain":"fleek.wootdev.com","cityMap":{"_default":"wss://chi-1.fleek.saga.org"}}';
        expect(hostViolations({ FLEEK_TOPOLOGY_JSON: topology })).toEqual([
            'FLEEK_TOPOLOGY_JSON references prod public host "chi-1.fleek.saga.org"',
        ]);
    });

    it('reports every offending var, and each host once per var', () => {
        const msgs = hostViolations({
            IAM_API_URL: 'https://iam.saga.org',
            SESSIONS_API_URL: 'https://sessions-api.saga.org',
            TWICE: 'https://iam.saga.org/a https://iam.saga.org/b',
        });
        expect(msgs).toHaveLength(3);
        expect(msgs.join('\n')).toMatch(/IAM_API_URL[\s\S]*SESSIONS_API_URL[\s\S]*TWICE/);
    });

    it.each([
        'https://authz-api.internal.saga.org',
        'https://authz-api.internal.saga.org/health/ready',
        'https://internal.saga.org',
        'http://openfga.dbs.internal:8080',
        'https://iam.wootdev.com',
        'https://fleek.wootdev.com',
        'https://core-a.rtsm.wootdev.com',
        'https://iam.saga-training.org',
        'https://evilsaga.org',
        'https://saga.org.example.com',
        'https://xinternal.saga.org.example.com',
        'http://localhost:3000',
    ])('allows %s', (url) => {
        expect(hostViolations({ SOME_URL: url })).toEqual([]);
    });

    it('does not let a lookalike of an allowed suffix through', () => {
        expect(hostViolations({ SOME_URL: 'https://xinternal.saga.org' })).toHaveLength(1);
        expect(hostViolations({ SOME_URL: 'https://internal.saga.org.evil.saga.org' })).toHaveLength(1);
    });

    it('does not treat an email address as a host', () => {
        expect(hostViolations({ MAIL_FROM_ADDRESS: 'noreply@saga.org' })).toEqual([]);
        expect(hostViolations({ MAIL_DOMAIN: 'noreply@saga.org' })).toEqual([]);
    });

    it('exempts CORS / allowed-origin vars, issuers and the SAML entity id', () => {
        const env = {
            DISTRICT_ADMIN_ALLOWEDORIGINS: 'https://dash.saga.org,https://blue.dash.saga.org',
            ALLOWED_ORIGINS: 'https://connectv3.saga.org',
            CORS_ORIGINS: 'https://dash.saga.org',
            STAR_UPLOAD_CORS_ORIGIN: 'https://staff-admin.sagaops.org',
            JWT_ISSUER: 'https://iam.saga.org',
            IAM_AUTH_USERTOKENISSUER: 'https://iam.saga.org',
            SAML_SP_ENTITY_ID: 'https://iam.saga.org/saga_api/v1.0/saml/metadata',
        };
        expect(hostViolations(env)).toEqual([]);
        expect(() => assertLaneSafe({ ...clean, ...env }, opts)).not.toThrow();
    });

    it('rejects a laned cookie domain on a prod apex', () => {
        for (const name of ['COOKIE_DOMAIN', 'AUTH_SESSIONCOOKIEDOMAIN', 'AUTH_IMPERSONATIONDASHCOOKIEDOMAIN']) {
            expect(hostViolations({ [name]: '.saga.org' })).toEqual([`${name} references prod public host "saga.org"`]);
        }
        expect(hostViolations({ AUTH_SESSIONCOOKIEDOMAIN: '.wootdev.com' })).toEqual([]);
    });

    it('does not exempt near-miss names', () => {
        const env = {
            ISSUER_JWKS_URL: 'https://iam.saga.org/.well-known/jwks.json',
            ISSUER_URL: 'https://iam.saga.org',
            ORIGINS_PROXY_URL: 'https://iam.saga.org',
            SAML_IDP_URL: 'https://iam.saga.org',
        };
        expect(hostViolations(env)).toHaveLength(4);
    });

    it('an exempt name does not exempt the other vars', () => {
        const msgs = hostViolations({ JWT_ISSUER: 'https://iam.saga.org', IAM_API_URL: 'https://iam.saga.org' });
        expect(msgs).toEqual(['IAM_API_URL references prod public host "iam.saga.org"']);
    });

    it('prodPublicApexes replaces the default', () => {
        const env = { A: 'https://x.example.test', B: 'https://iam.saga.org' };
        expect(hostViolations(env, { ...opts, prodPublicApexes: ['example.test'] })).toEqual([
            'A references prod public host "x.example.test"',
        ]);
        expect(hostViolations(env, { ...opts, prodPublicApexes: ['.EXAMPLE.test.'] })).toHaveLength(1);
        expect(hostViolations(env, { ...opts, prodPublicApexes: [...DEFAULT_PROD_PUBLIC_APEXES, 'example.test'] })).toHaveLength(2);
    });

    it('allowedHostSuffixes replaces the default', () => {
        const env = { A: 'https://authz-api.internal.saga.org', B: 'https://x.lane.saga.org' };
        expect(hostViolations(env, { ...opts, allowedHostSuffixes: ['lane.saga.org'] })).toEqual([
            'A references prod public host "authz-api.internal.saga.org"',
        ]);
        expect(hostViolations(env, { ...opts, allowedHostSuffixes: [...DEFAULT_ALLOWED_HOST_SUFFIXES, 'lane.saga.org'] })).toEqual([]);
    });

    it('nonEgressVarPatterns replaces the default', () => {
        const env = { JWT_ISSUER: 'https://iam.saga.org', MY_ORIGIN: 'https://iam.saga.org' };
        expect(hostViolations(env, { ...opts, nonEgressVarPatterns: [/^MY_ORIGIN$/] })).toEqual([
            'JWT_ISSUER references prod public host "iam.saga.org"',
        ]);
        expect(hostViolations(env, { ...opts, nonEgressVarPatterns: [...DEFAULT_NON_EGRESS_VAR_PATTERNS, /^MY_ORIGIN$/] })).toEqual([]);
        expect(hostViolations(env, { ...opts, nonEgressVarPatterns: [/ISSUER$/g, /ISSUER$/g] })).toEqual([
            'MY_ORIGIN references prod public host "iam.saga.org"',
        ]);
    });

    it('applies to both lanes', () => {
        for (const LANE of ['twin', 'mirror']) {
            expect(hostViolations({ LANE, IAM_API_URL: 'https://iam.saga.org' })).toHaveLength(1);
        }
    });

    it('throws one LaneGuardError listing var names and hosts only, never values', () => {
        const env = {
            ...clean,
            IAM_API_URL: 'https://svc:SECRETPW@iam.saga.org:8443/path?token=SECRETTOKEN',
            SESSIONS_API_URL: 'https://sessions-api.saga.org/x#SECRETFRAG',
            UPSTREAM_HOST: 'login.saga.org',
        };
        let err: unknown;
        try {
            assertLaneSafe(env, { accountId: DEV });
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(LaneGuardError);
        const msg = (err as LaneGuardError).message;
        expect(msg).toContain('[prod-public-host] IAM_API_URL references prod public host "iam.saga.org"');
        expect(msg).toContain('[prod-public-host] SESSIONS_API_URL references prod public host "sessions-api.saga.org"');
        expect(msg).toContain('[prod-public-host] UPSTREAM_HOST references prod public host "login.saga.org"');
        expect(msg).toContain('(3 violations)');
        for (const secret of ['SECRETPW', 'SECRETTOKEN', 'SECRETFRAG', '8443', '/path', 'svc:']) {
            expect(msg).not.toContain(secret);
        }
    });

    it.each([undefined, '', '  ', 'none', 'NONE'])('is a strict no-op when LANE=%j, with prod hosts present', (LANE) => {
        const env = {
            LANE,
            EXEC_ENV: 'prod',
            IAM_API_URL: 'https://iam.saga.org',
            JANUS_LOGIN_HOST: 'login.saga.org',
            STAFFGATE_JWKSURL: 'https://gate.sagaops.org/.well-known/jwks.json',
        };
        expect(checkLaneSafety(env)).toEqual([]);
        expect(() => assertLaneSafe(env)).not.toThrow();
    });

    it('reports only prod-public-host for a prod https URL, nothing for clean values', () => {
        expect(checks({ IAM_API_URL: 'https://iam.wootdev.com', REDIS_URL: 'redis://cache.dev.internal:6379' })).toEqual([]);
        expect(checks({ IAM_API_URL: 'https://iam.saga.org' })).toEqual(['prod-public-host']);
    });
});

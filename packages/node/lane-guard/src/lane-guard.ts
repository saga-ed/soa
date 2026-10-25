import type { EnvIdentity } from '@saga-ed/soa-env';

export type Env = Record<string, string | undefined>;

export interface LaneViolation {
    check:
        | 'lane-identity'
        | 'dd-env'
        | 'prod-secret-path'
        | 'prod-host'
        | 'prod-public-host'
        | 'ses'
        | 'partner-egress'
        | 'aws-account';
    message: string;
}

export interface LaneGuardOptions {
    /** Host patterns treated as prod. Replaces the default. */
    prodHostPatterns?: RegExp[];
    /** Caller-resolved account id (ECS task metadata or STS). Omitted on a lane = fail closed. */
    accountId?: string;
    /** Accounts a lane may run in. Default: dev only. */
    allowedAccountIds?: string[];
    /** soa-env's resolved identity; cross-checked against the raw env, never trusted over it. */
    identity?: EnvIdentity;
    /** Prod public apex domains; a host equal to or under one is rejected. Replaces the default. */
    prodPublicApexes?: string[];
    /** Domain suffixes exempt from `prodPublicApexes` (dev-VPC private zones). Replaces the default. */
    allowedHostSuffixes?: string[];
    /** Env var names whose values are inbound or identity strings, not egress. Replaces the default. */
    nonEgressVarPatterns?: RegExp[];
}

export const DEV_ACCOUNT_ID = '396913734878';

export const DEFAULT_PROD_HOST_PATTERNS: RegExp[] = [/(^|[.\-_])(prod|production)([.\-_]|$)/i];

/** Prod-only public apexes. Dev uses wootdev.com / wootops.org. */
export const DEFAULT_PROD_PUBLIC_APEXES: string[] = ['saga.org', 'sagaops.org'];

/** Dev-VPC private zones a lane uses to reach twins (twin-lane-contract rules 5-6). */
export const DEFAULT_ALLOWED_HOST_SUFFIXES: string[] = ['internal.saga.org', 'dbs.internal'];

/** Names of vars that hold CORS origins, token issuers or a SAML entity id: compared or emitted, never dialled. */
export const DEFAULT_NON_EGRESS_VAR_PATTERNS: RegExp[] = [
    /CORS_?ORIGINS?$/i,
    /ALLOWED_?ORIGINS?$/i,
    /ISSUER$/i,
    /^SAML_SP_ENTITY_?ID$/i,
];

export type Lane = 'twin' | 'mirror' | 'none';

const PROD_SSM_PATH_RE = /(?:^|parameter|[\s,;=:])\/(?:shared\/infra\/)?prod\//;
const OTEL_ENV_RE = /(?:^|,)\s*deployment\.environment(?:\.name)?\s*=\s*([^,]*)/gi;
const URL_RE = /\b(amqps?|rediss?|mongodb(?:\+srv)?|postgres(?:ql)?):\/\/([^\s/?#]*)/gi;
const HOST_VAR_RE = /^(PGHOST|(POSTGRES|PG|REDIS|MONGO|MONGODB|RABBITMQ|AMQP)_?[A-Z0-9_]*HOST)$/i;
// Any scheme. The authority ends at the next URL, so comma-separated URL lists split cleanly; `{}` stays so templated hosts match.
const ANY_URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/((?:(?![a-z][a-z0-9+.-]*:\/\/)[^\s/?#"'`<>\\])*)/gi;
const BARE_HOST_VAR_RE = /(HOST|HOSTNAME|DOMAIN|ENDPOINT)$/i;
const PARTNER_VAR_RES = [/^CLEVER_/i, /PARTNER.*WEBHOOK|WEBHOOK.*URL/i];

const isSet = (v: string | undefined): v is string => v !== undefined && v.trim() !== '';

function hostsOfAuthority(authority: string): string[] {
    const hostPart = authority.slice(authority.lastIndexOf('@') + 1);
    return hostPart
        .split(',')
        .map((h) => h.trim().replace(/^\[|\]$/g, '').replace(/:\d*$/, ''))
        .filter(Boolean);
}

function normalizeHost(piece: string): string {
    return piece
        .slice(piece.lastIndexOf('@') + 1)
        .trim()
        .replace(/^\[|\]$/g, '')
        .replace(/:\d*$/, '')
        .replace(/^(\*?\.)+/, '')
        .replace(/\.+$/, '')
        .toLowerCase();
}

/** Hosts of every URL in the value (any scheme), plus the value itself when the var name marks it as a bare host. */
function egressHosts(name: string, value: string): string[] {
    const hosts: string[] = [];
    for (const m of value.matchAll(ANY_URL_RE)) {
        for (const piece of (m[1] ?? '').split(',')) hosts.push(normalizeHost(piece));
    }
    if (!value.includes('://') && BARE_HOST_VAR_RE.test(name)) {
        for (const token of value.split(/[\s,;]+/)) {
            if (token.includes('@')) continue;
            hosts.push(normalizeHost(token.split('/')[0] ?? ''));
        }
    }
    return hosts.filter(Boolean);
}

const normalizeDomains = (list: string[]): string[] => list.map((d) => d.trim().replace(/^\.+|\.+$/g, '').toLowerCase()).filter(Boolean);
const underDomain = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

export interface LaneResolution {
    /** `invalid` = LANE set to an unknown value, or contradicting EXEC_ENV. */
    lane: Lane | 'invalid';
    /** Lane inferred from the deprecated EXEC_ENV=mirror alias. */
    viaDeprecatedAlias: boolean;
    reason?: string;
}

/** LANE (infra-set) is authoritative. EXEC_ENV=mirror is honoured only when LANE is unset (removal pending). */
export function resolveLane(env: Env): LaneResolution {
    // eslint-disable-next-line @saga-ed/soa-env/no-env-identity -- independent raw-env cross-check of soa-env (DESIGN §3)
    const raw = env.LANE?.trim().toLowerCase();
    // eslint-disable-next-line @saga-ed/soa-env/no-env-identity -- independent raw-env cross-check of soa-env (DESIGN §3)
    const execMirror = env.EXEC_ENV?.trim().toLowerCase() === 'mirror';
    if (!raw) {
        return execMirror ? { lane: 'mirror', viaDeprecatedAlias: true } : { lane: 'none', viaDeprecatedAlias: false };
    }
    // eslint-disable-next-line @saga-ed/soa-env/no-env-identity -- independent raw-env cross-check of soa-env (DESIGN §3)
    if (raw !== 'twin' && raw !== 'mirror' && raw !== 'none') {
        return { lane: 'invalid', viaDeprecatedAlias: false, reason: 'LANE is not one of twin|mirror|none' };
    }
    if (raw === 'none' && execMirror) {
        return { lane: 'invalid', viaDeprecatedAlias: false, reason: 'LANE=none contradicts EXEC_ENV=mirror' };
    }
    return { lane: raw, viaDeprecatedAlias: false };
}

function telemetryEnvViolations(env: Env, lane: Lane): LaneViolation[] {
    const v: LaneViolation[] = [];
    const isProd = (x: string) => x === 'prod' || x === 'production';
    // eslint-disable-next-line @saga-ed/soa-env/no-env-identity -- independent raw-env cross-check of soa-env (DESIGN §3)
    const dd = env.DD_ENV?.trim().toLowerCase();
    if (!dd) {
        v.push({ check: 'dd-env', message: `DD_ENV is unset/empty; LANE=${lane} requires a non-prod value (e.g. "${lane}")` });
    } else if (isProd(dd)) {
        v.push({ check: 'dd-env', message: `DD_ENV is a prod value; LANE=${lane} requires a non-prod value (e.g. "${lane}")` });
    }
    for (const name of ['OTEL_RESOURCE_ATTRIBUTES', 'OTEL_DEPLOYMENT_ENVIRONMENT']) {
        const value = env[name];
        if (!isSet(value)) continue;
        const candidates =
            name === 'OTEL_RESOURCE_ATTRIBUTES' ? [...value.matchAll(OTEL_ENV_RE)].map((m) => m[1] ?? '') : [value];
        if (candidates.some((c) => isProd(c.trim().toLowerCase()))) {
            v.push({ check: 'dd-env', message: `${name} sets deployment.environment to a prod value; LANE=${lane} requires a non-prod value` });
        }
    }
    return v;
}

function identityMismatch(raw: Lane, identity: EnvIdentity | undefined): LaneViolation | undefined {
    if (!identity || identity.lane === raw) return undefined;
    return { check: 'lane-identity', message: `soa-env lane "${identity.lane}" disagrees with raw env lane "${raw}"` };
}

/** Returns [] when LANE is none/unset and any identity agrees. Otherwise runs every lane check. */
export function checkLaneSafety(env: Env, opts: LaneGuardOptions = {}): LaneViolation[] {
    const { lane, reason } = resolveLane(env);
    if (lane === 'invalid') return [{ check: 'lane-identity', message: reason ?? 'invalid lane identity' }];
    const mismatch = identityMismatch(lane, opts.identity);
    if (lane === 'none') return mismatch ? [mismatch] : [];

    const v: LaneViolation[] = mismatch ? [mismatch] : [];
    const accountId = opts.accountId ?? opts.identity?.account.id;
    const allowed = opts.allowedAccountIds ?? [DEV_ACCOUNT_ID];
    const accountOk = accountId !== undefined && allowed.includes(accountId);
    const patterns = opts.prodHostPatterns ?? DEFAULT_PROD_HOST_PATTERNS;
    const isProdHost = (host: string): boolean =>
        patterns.some((p) => {
            p.lastIndex = 0;
            return p.test(host);
        });

    const apexes = normalizeDomains(opts.prodPublicApexes ?? DEFAULT_PROD_PUBLIC_APEXES);
    const allowedSuffixes = normalizeDomains(opts.allowedHostSuffixes ?? DEFAULT_ALLOWED_HOST_SUFFIXES);
    const nonEgress = opts.nonEgressVarPatterns ?? DEFAULT_NON_EGRESS_VAR_PATTERNS;
    const isNonEgressVar = (name: string): boolean =>
        nonEgress.some((p) => {
            p.lastIndex = 0;
            return p.test(name);
        });
    const isProdPublicHost = (host: string): boolean =>
        apexes.some((a) => underDomain(host, a)) && !allowedSuffixes.some((a) => underDomain(host, a));

    v.push(...telemetryEnvViolations(env, lane));

    for (const [name, value] of Object.entries(env)) {
        if (!isSet(value)) continue;

        if (!accountOk && PROD_SSM_PATH_RE.test(value)) {
            v.push({ check: 'prod-secret-path', message: `${name} references a prod-named SSM path and the account is not a verified dev account` });
        }

        for (const m of value.matchAll(URL_RE)) {
            for (const host of hostsOfAuthority(m[2] ?? '')) {
                if (isProdHost(host)) {
                    v.push({ check: 'prod-host', message: `${name} has a ${m[1]!.toLowerCase()}:// URL with prod-matching host "${host}"` });
                }
            }
        }

        if (HOST_VAR_RE.test(name) && !value.includes('://') && isProdHost(value.trim())) {
            v.push({ check: 'prod-host', message: `${name} has prod-matching host "${value.trim()}"` });
        }

        if (!isNonEgressVar(name)) {
            for (const host of new Set(egressHosts(name, value))) {
                if (isProdPublicHost(host)) {
                    v.push({ check: 'prod-public-host', message: `${name} references prod public host "${host}"` });
                }
            }
        }

        if (name.toUpperCase().startsWith('MAIL_SES_')) {
            v.push({ check: 'ses', message: `${name} is set; LANE=${lane} uses the capture or stub mailer, not SES` });
        }

        if (PARTNER_VAR_RES.some((re) => re.test(name))) {
            v.push({ check: 'partner-egress', message: `${name} is set; partner/webhook config must be absent on LANE=${lane}` });
        }
    }

    if (env.MAIL_PROVIDER?.trim().toLowerCase() === 'ses') {
        v.push({ check: 'ses', message: `MAIL_PROVIDER=ses; LANE=${lane} uses the capture or stub mailer, not SES` });
    }

    if (accountId === undefined) {
        v.push({ check: 'aws-account', message: `AWS account id was not resolved; LANE=${lane} fails closed` });
    } else if (!accountOk) {
        v.push({ check: 'aws-account', message: `AWS account id is not in the allowed set for LANE=${lane}` });
    }

    return v;
}

export class LaneGuardError extends Error {
    constructor(
        readonly violations: LaneViolation[],
        lane: string = 'unresolved',
    ) {
        super(
            `Lane guard: refusing to start on LANE=${lane} (${violations.length} violation${violations.length === 1 ? '' : 's'}):\n` +
                violations.map((x) => `  - [${x.check}] ${x.message}`).join('\n'),
        );
        this.name = 'LaneGuardError';
    }
}

let aliasWarned = false;

/** No-op unless LANE is twin|mirror (or the deprecated EXEC_ENV=mirror alias). Throws on unknown LANE. Call before creating any client. */
export function assertLaneSafe(env: Env = process.env, opts: LaneGuardOptions = {}): void {
    const res = resolveLane(env);
    if (res.lane === 'none' && (!opts.identity || opts.identity.lane === 'none')) return;
    if (res.viaDeprecatedAlias && !aliasWarned) {
        aliasWarned = true;
        process.emitWarning('soa-lane-guard: EXEC_ENV=mirror as a lane trigger is deprecated; set LANE=mirror (removal pending)', 'DeprecationWarning');
    }
    const violations = checkLaneSafety(env, opts);
    if (violations.length > 0) throw new LaneGuardError(violations, res.lane);
}

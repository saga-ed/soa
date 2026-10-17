export type Env = Record<string, string | undefined>;

export interface LaneViolation {
    check: 'dd-env' | 'prod-secret-path' | 'prod-host' | 'ses' | 'partner-egress' | 'aws-account';
    message: string;
}

export interface LaneGuardOptions {
    /** Host patterns treated as prod. Replaces the default. */
    prodHostPatterns?: RegExp[];
    /** Caller-resolved (STS) account id. Omitted = account check skipped. */
    accountId?: string;
    /** Accounts the mirror lane may run in. Default: dev only. */
    allowedAccountIds?: string[];
}

export const DEV_ACCOUNT_ID = '396913734878';

export const DEFAULT_PROD_HOST_PATTERNS: RegExp[] = [/(^|[.\-_])(prod|production)([.\-_]|$)/i];

const PROD_SECRET_PATH = '/shared/infra/prod/';
const URL_RE = /\b(amqps?|rediss?|mongodb(?:\+srv)?|postgres(?:ql)?):\/\/([^\s/?#]*)/gi;
const HOST_VAR_RE = /^(PGHOST|(POSTGRES|PG|REDIS|MONGO|MONGODB|RABBITMQ|AMQP)_?[A-Z0-9_]*HOST)$/i;
const PARTNER_VAR_RES = [/^CLEVER_/i, /PARTNER.*WEBHOOK|WEBHOOK.*URL/i];

const isSet = (v: string | undefined): v is string => v !== undefined && v.trim() !== '';

function hostsOfAuthority(authority: string): string[] {
    const hostPart = authority.slice(authority.lastIndexOf('@') + 1);
    return hostPart
        .split(',')
        .map((h) => h.trim().replace(/^\[|\]$/g, '').replace(/:\d*$/, ''))
        .filter(Boolean);
}

export function checkLaneSafety(env: Env, opts: LaneGuardOptions = {}): LaneViolation[] {
    const v: LaneViolation[] = [];
    const patterns = opts.prodHostPatterns ?? DEFAULT_PROD_HOST_PATTERNS;
    const isProdHost = (host: string): boolean =>
        patterns.some((p) => {
            p.lastIndex = 0;
            return p.test(host);
        });

    const dd = env.DD_ENV?.trim().toLowerCase();
    if (!dd) {
        v.push({ check: 'dd-env', message: 'DD_ENV is unset/empty; mirror requires a non-prod value (e.g. "mirror")' });
    } else if (dd === 'prod' || dd === 'production') {
        v.push({ check: 'dd-env', message: 'DD_ENV is a prod value; mirror requires a non-prod value (e.g. "mirror")' });
    }

    for (const [name, value] of Object.entries(env)) {
        if (!isSet(value)) continue;

        if (value.includes(PROD_SECRET_PATH)) {
            v.push({ check: 'prod-secret-path', message: `${name} references a ${PROD_SECRET_PATH} path` });
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

        if (name.toUpperCase().startsWith('MAIL_SES_')) {
            v.push({ check: 'ses', message: `${name} is set; mirror uses the stub mailer, not SES` });
        }

        if (PARTNER_VAR_RES.some((re) => re.test(name))) {
            v.push({ check: 'partner-egress', message: `${name} is set; partner/webhook config must be absent in mirror` });
        }
    }

    if (env.MAIL_PROVIDER?.trim().toLowerCase() === 'ses') {
        v.push({ check: 'ses', message: 'MAIL_PROVIDER=ses; mirror uses the stub mailer, not SES' });
    }

    if (opts.accountId !== undefined) {
        const allowed = opts.allowedAccountIds ?? [DEV_ACCOUNT_ID];
        if (!allowed.includes(opts.accountId)) {
            v.push({ check: 'aws-account', message: 'AWS account id is not in the allowed set for mirror' });
        }
    }

    return v;
}

export class LaneGuardError extends Error {
    constructor(readonly violations: LaneViolation[]) {
        super(
            `Lane guard: refusing to start in EXEC_ENV=mirror (${violations.length} violation${violations.length === 1 ? '' : 's'}):\n` +
                violations.map((x) => `  - [${x.check}] ${x.message}`).join('\n'),
        );
        this.name = 'LaneGuardError';
    }
}

/** No-op unless EXEC_ENV=mirror. Call before creating any client. Pass `accountId` from STS to enable the account check. */
export function assertLaneSafe(env: Env = process.env, opts: LaneGuardOptions = {}): void {
    if (env.EXEC_ENV !== 'mirror') return;
    const violations = checkLaneSafety(env, opts);
    if (violations.length > 0) throw new LaneGuardError(violations);
}

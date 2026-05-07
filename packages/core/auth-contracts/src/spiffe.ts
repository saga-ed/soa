import { z } from 'zod';

/**
 * SPIFFE ID format: spiffe://saga.<env>/<service>[/<component>]
 *
 * See ADR 0006. We restrict the trust domain to the `saga.*` family
 * so a workload identifier can only ever come from a Saga environment.
 */

export const SAGA_ENVS = ['dev', 'staging', 'prod'] as const;
export type SagaEnv = (typeof SAGA_ENVS)[number];

const SAGA_TRUST_DOMAIN_RE = /^saga\.(dev|staging|prod)$/;
const SERVICE_NAME_RE = /^[a-z][a-z0-9-]*[a-z0-9]$/;
// Components may be UUIDs (user IDs) so they can start with a digit.
const COMPONENT_NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export interface ParsedSpiffeId {
    readonly trustDomain: `saga.${SagaEnv}`;
    readonly env: SagaEnv;
    readonly service: string;
    readonly component: string | null;
    readonly raw: string;
}

export interface ParsedSpiffeUserId extends ParsedSpiffeId {
    readonly service: 'user';
    readonly component: string;
    readonly userUuid: string;
}

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse a SPIFFE ID string. Returns null if invalid; throwing variants
 * are exposed via parseSpiffeIdOrThrow.
 *
 * Valid examples:
 *   spiffe://saga.dev/iam-api
 *   spiffe://saga.prod/programs-api/outbox-relay
 *   spiffe://saga.prod/user/00000000-0000-4000-8000-000000000001
 */
export function parseSpiffeId(input: string): ParsedSpiffeId | null {
    if (typeof input !== 'string' || !input.startsWith('spiffe://')) {
        return null;
    }
    let url: URL;
    try {
        url = new URL(input);
    } catch {
        return null;
    }
    if (url.protocol !== 'spiffe:' || url.search !== '' || url.hash !== '') {
        return null;
    }
    const trustDomain = url.host;
    const match = trustDomain.match(SAGA_TRUST_DOMAIN_RE);
    if (!match) return null;
    const env = match[1] as SagaEnv;

    const path = url.pathname.replace(/^\//, '');
    if (path.length === 0) return null;
    const segments = path.split('/');
    if (segments.length < 1 || segments.length > 2) return null;
    const service = segments[0];
    const component = segments[1] ?? null;
    if (service === undefined || !SERVICE_NAME_RE.test(service)) return null;
    if (component !== null && !COMPONENT_NAME_RE.test(component)) return null;

    return {
        trustDomain: `saga.${env}` as const,
        env,
        service,
        component,
        raw: input,
    };
}

export function parseSpiffeIdOrThrow(input: string): ParsedSpiffeId {
    const parsed = parseSpiffeId(input);
    if (!parsed) {
        throw new Error(`Invalid SPIFFE ID: ${JSON.stringify(input)}`);
    }
    return parsed;
}

/**
 * Build a service workload SPIFFE ID. Validates inputs.
 */
export function buildServiceSpiffeId(args: {
    env: SagaEnv;
    service: string;
    component?: string;
}): string {
    if (!SERVICE_NAME_RE.test(args.service)) {
        throw new Error(`Invalid service name: ${JSON.stringify(args.service)}`);
    }
    if (args.component !== undefined && !COMPONENT_NAME_RE.test(args.component)) {
        throw new Error(
            `Invalid component name: ${JSON.stringify(args.component)}`,
        );
    }
    const tail =
        args.component === undefined ? args.service : `${args.service}/${args.component}`;
    return `spiffe://saga.${args.env}/${tail}`;
}

/**
 * Build a user SPIFFE ID. The user UUID becomes the component segment
 * under the reserved service name `user`.
 */
export function buildUserSpiffeId(args: {
    env: SagaEnv;
    userUuid: string;
}): string {
    if (!UUID_RE.test(args.userUuid)) {
        throw new Error(
            `Invalid user UUID: ${JSON.stringify(args.userUuid)}`,
        );
    }
    return `spiffe://saga.${args.env}/user/${args.userUuid}`;
}

/**
 * Refine a parsed SPIFFE ID into a user identifier, or null if it is not
 * a user (service !== 'user' or component is not a UUID).
 */
export function asUserSpiffeId(
    id: ParsedSpiffeId,
): ParsedSpiffeUserId | null {
    if (id.service !== 'user') return null;
    if (id.component === null) return null;
    if (!UUID_RE.test(id.component)) return null;
    return {
        ...id,
        service: 'user',
        component: id.component,
        userUuid: id.component,
    };
}

/**
 * Zod schema for use inside larger objects (e.g., the `sub` field of a JWT
 * claim schema). Validates structure but does not check trust-domain match
 * against an active environment — that is a runtime concern, not a parse
 * concern.
 */
export const SpiffeIdSchema = z
    .string()
    .refine((s) => parseSpiffeId(s) !== null, {
        message:
            'Invalid SPIFFE ID (expected spiffe://saga.<env>/<service>[/<component>])',
    });

/**
 * Stricter schema bound to a known environment. Use at trust boundaries
 * where you know which env you are running in.
 */
export function spiffeIdForEnv(env: SagaEnv) {
    return z.string().refine(
        (s) => {
            const p = parseSpiffeId(s);
            return p !== null && p.env === env;
        },
        { message: `SPIFFE ID must be in trust domain saga.${env}` },
    );
}

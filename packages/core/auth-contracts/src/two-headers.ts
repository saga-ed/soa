import { z } from 'zod';
import { SpiffeIdSchema, parseSpiffeId } from './spiffe.js';

/**
 * Two-headers invariant per ADR 0002.
 *
 * Every internal call carries:
 *   - X-Saga-Caller        — the workload identity (SPIFFE ID).
 *   - Authorization        — the subject identity (Bearer JWT).
 *
 * This file owns the canonical header names and the structural parsers.
 * It does NOT verify cryptographic claims — that's the job of the runtime
 * verifier package (lands later).
 */

export const HEADER_SAGA_CALLER = 'X-Saga-Caller' as const;
export const HEADER_AUTHORIZATION = 'Authorization' as const;

/**
 * Lowercase variants for use against headers normalized by Node http (which
 * lowercases all header names).
 */
export const HEADER_SAGA_CALLER_LOWER = 'x-saga-caller' as const;
export const HEADER_AUTHORIZATION_LOWER = 'authorization' as const;

export const SagaCallerHeaderSchema = SpiffeIdSchema;

/**
 * Result of structural parsing. Each side independently can be present,
 * absent, or malformed. A request with only one side present is
 * structurally incomplete and triggers the shadow-mode metric.
 */
export type TwoHeadersParseStatus =
    | 'ok'
    | 'caller_missing'
    | 'caller_malformed'
    | 'subject_missing'
    | 'subject_malformed';

export interface TwoHeadersParseResult {
    readonly status: TwoHeadersParseStatus;
    readonly callerSpiffeId: string | null;
    /**
     * Bearer token raw string (the JWT). Present only when the header was
     * present and well-formed at the bearer-scheme level. Claim-level
     * validation is the verifier's job, not ours.
     */
    readonly bearerToken: string | null;
    readonly issues: ReadonlyArray<string>;
}

const HEADER_GET = (
    headers: HeadersLike,
    name: string,
): string | null => {
    if (typeof (headers as Headers).get === 'function') {
        return (headers as Headers).get(name);
    }
    const record = headers as Record<string, string | string[] | undefined>;
    const exact = record[name];
    if (exact !== undefined) return Array.isArray(exact) ? exact[0] ?? null : exact;
    const lower = record[name.toLowerCase()];
    if (lower !== undefined) return Array.isArray(lower) ? lower[0] ?? null : lower;
    return null;
};

/**
 * Header source — accepts the Web `Headers` interface or a plain record
 * (Node `IncomingMessage.headers` shape).
 */
export type HeadersLike =
    | Headers
    | Record<string, string | string[] | undefined>;

/**
 * Structural parse of the two headers from a request. Cryptographic
 * verification is out of scope.
 *
 * Behavior:
 *   - Both present and well-formed                → status 'ok'
 *   - X-Saga-Caller missing                       → 'caller_missing'
 *   - X-Saga-Caller present but not a SPIFFE ID   → 'caller_malformed'
 *   - Authorization missing                       → 'subject_missing'
 *   - Authorization not 'Bearer <token>' shape    → 'subject_malformed'
 *
 * If both sides have problems, the first detected issue is the status;
 * `issues` carries the full list.
 */
export function parseTwoHeaders(headers: HeadersLike): TwoHeadersParseResult {
    const issues: string[] = [];

    const callerRaw = HEADER_GET(headers, HEADER_SAGA_CALLER);
    let callerSpiffeId: string | null = null;
    let callerStatus: TwoHeadersParseStatus | null = null;
    if (callerRaw === null || callerRaw.trim() === '') {
        issues.push(`${HEADER_SAGA_CALLER} header missing`);
        callerStatus = 'caller_missing';
    } else if (parseSpiffeId(callerRaw.trim()) === null) {
        issues.push(`${HEADER_SAGA_CALLER} header is not a valid SPIFFE ID`);
        callerStatus = 'caller_malformed';
    } else {
        callerSpiffeId = callerRaw.trim();
    }

    const authRaw = HEADER_GET(headers, HEADER_AUTHORIZATION);
    let bearerToken: string | null = null;
    let subjectStatus: TwoHeadersParseStatus | null = null;
    if (authRaw === null || authRaw.trim() === '') {
        issues.push(`${HEADER_AUTHORIZATION} header missing`);
        subjectStatus = 'subject_missing';
    } else {
        const trimmed = authRaw.trim();
        if (!/^Bearer\s+\S+$/i.test(trimmed)) {
            issues.push(
                `${HEADER_AUTHORIZATION} header is not a Bearer token`,
            );
            subjectStatus = 'subject_malformed';
        } else {
            bearerToken = trimmed.replace(/^Bearer\s+/i, '');
        }
    }

    const status: TwoHeadersParseStatus =
        callerStatus ?? subjectStatus ?? 'ok';

    return {
        status,
        callerSpiffeId,
        bearerToken,
        issues,
    };
}

/**
 * Mode flag for the shadow→enforce migration described in ADR 0002.
 */
export type TwoHeadersMode = 'off' | 'shadow' | 'enforce';

export const TwoHeadersModeSchema = z.enum(['off', 'shadow', 'enforce']);

/**
 * Convenience predicate. The structural parse result is "complete" when
 * status is 'ok'.
 */
export function isComplete(result: TwoHeadersParseResult): boolean {
    return result.status === 'ok';
}

/**
 * Outcome of `decideTwoHeaders`.
 *
 * - action 'allow' : headers are complete; let the request through.
 * - action 'log'   : structural problem detected, but mode is shadow;
 *                    let the request through and emit a metric.
 * - action 'reject': structural problem detected and mode is enforce;
 *                    the caller should reject with UNAUTHORIZED.
 *
 * `metric` is populated for both 'log' and 'reject' so the caller can
 * always emit the same `saga_two_headers_missing_total{service, reason}`
 * counter without branching.
 */
export type TwoHeadersAction = 'allow' | 'log' | 'reject';

export interface TwoHeadersDecision {
    readonly action: TwoHeadersAction;
    readonly mode: TwoHeadersMode;
    readonly parse: TwoHeadersParseResult;
    /**
     * Stable label for metric emission. `undefined` when action is 'allow'.
     * Values are the parse statuses other than 'ok'.
     */
    readonly metricReason:
        | Exclude<TwoHeadersParseStatus, 'ok'>
        | undefined;
}

/**
 * Combine `parseTwoHeaders` + the configured mode to produce a single
 * decision. This is the function services call from their tRPC / HTTP
 * middleware.
 *
 * The decision is *pure* — it does not log, emit metrics, or throw.
 * The caller wires the metric and the rejection. This keeps the helper
 * runtime-agnostic (browser, Node, edge) and trivially testable.
 *
 * @example
 *   const decision = decideTwoHeaders(req.headers, 'shadow');
 *   if (decision.metricReason) {
 *     metrics.increment('saga_two_headers_missing_total', {
 *       service: 'programs-api',
 *       reason: decision.metricReason,
 *     });
 *   }
 *   if (decision.action === 'reject') {
 *     throw new TRPCError({ code: 'UNAUTHORIZED', ... });
 *   }
 */
export function decideTwoHeaders(
    headers: HeadersLike,
    mode: TwoHeadersMode,
): TwoHeadersDecision {
    const parse = parseTwoHeaders(headers);

    if (mode === 'off') {
        return {
            action: 'allow',
            mode,
            parse,
            metricReason: undefined,
        };
    }

    if (parse.status === 'ok') {
        return {
            action: 'allow',
            mode,
            parse,
            metricReason: undefined,
        };
    }

    return {
        action: mode === 'enforce' ? 'reject' : 'log',
        mode,
        parse,
        metricReason: parse.status,
    };
}

/**
 * Canonical metric name for the shadow→enforce migration. Centralized
 * here so every service emits the same label name.
 *
 * Recommended labels: { service, reason }
 *   - service: emitting service's SPIFFE ID or short name
 *   - reason : decision.metricReason (one of the parse statuses)
 */
export const TWO_HEADERS_METRIC = 'saga_two_headers_missing_total' as const;

import { z } from 'zod';
import { SpiffeIdSchema } from './spiffe.js';
import { TenantIdSchema } from './jwt-claims.js';

/**
 * `audit.decision.v1` — canonical fleet audit event shape per ADR 0004.
 *
 * Every service emits this shape on authn / authz / mutation / admin events.
 * The writer (a logger today, a hash-chained Postgres later) consumes the
 * shape; callers depend on this schema, not the writer.
 */

export const AUDIT_SCHEMA_VERSION = 'v1' as const;

export const AuditEventTypeSchema = z.enum([
    'authn.login',
    'authn.logout',
    'authn.refresh',
    'authn.token_exchange',
    'authz.check',
    'authz.deny',
    'mutation.create',
    'mutation.update',
    'mutation.delete',
    'admin.role_grant',
    'admin.role_revoke',
    'admin.config_change',
]);

export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

/**
 * Caller workload identity. Null only for direct end-user calls (e.g., a
 * browser hitting the auth-api directly during login).
 */
export const AuditCallerSchema = z
    .object({
        spiffeId: SpiffeIdSchema,
    })
    .strip();
export type AuditCaller = z.infer<typeof AuditCallerSchema>;

/**
 * Subject identity. Null only for unauthenticated events (e.g., a failed
 * login before the user is identified).
 */
export const AuditSubjectSchema = z
    .object({
        sub: SpiffeIdSchema,
        tenantId: TenantIdSchema.nullable(),
        sessionJti: z.string().min(1).nullable(),
        tokenJti: z.string().min(1),
    })
    .strip();
export type AuditSubject = z.infer<typeof AuditSubjectSchema>;

/**
 * Resource being acted upon. Null for events that have no target resource
 * (e.g., `authn.login`).
 */
export const AuditResourceSchema = z
    .object({
        type: z.string().min(1),
        id: z.string().min(1),
        tenantId: TenantIdSchema.nullable(),
    })
    .strip();
export type AuditResource = z.infer<typeof AuditResourceSchema>;

/**
 * OpenFGA check trace. Captured for `authz.*` events; `consultedTuples` is
 * optional because high-volume paths may omit it for cost.
 */
export const AuditFgaCheckSchema = z
    .object({
        relation: z.string().min(1),
        object: z.string().min(1),
        consultedTuples: z.array(z.string().min(1)).optional(),
    })
    .strip();
export type AuditFgaCheck = z.infer<typeof AuditFgaCheckSchema>;

/**
 * Reason codes. Free-form strings, but lint encourages structured values.
 * Common codes:
 *   - "no_tuple"          — FGA returned deny because no relation path exists
 *   - "expired_token"
 *   - "tenant_mismatch"   — requested tenant not in user's membership set
 *   - "missing_session"
 *   - "missing_caller"    — two-headers caller missing
 *   - "signature_invalid" — for event-signature rejections
 */
export const AuditReasonSchema = z.string().min(1).nullable();

export const AuditDecisionSchema = z.enum(['allow', 'deny']);

export const AuditEnvSchema = z.enum(['dev', 'staging', 'prod']);
export type AuditEnv = z.infer<typeof AuditEnvSchema>;

export const AuditDecisionEventSchema = z
    .object({
        schemaVersion: z.literal(AUDIT_SCHEMA_VERSION),
        eventType: AuditEventTypeSchema,
        caller: AuditCallerSchema.nullable(),
        subject: AuditSubjectSchema.nullable(),
        resource: AuditResourceSchema.nullable(),
        action: z.string().min(1),
        decision: AuditDecisionSchema,
        reason: AuditReasonSchema,
        fgaCheck: AuditFgaCheckSchema.nullable(),
        occurredAt: z.string().datetime({ offset: true }),
        correlationId: z.string().min(1),
        causationId: z.string().min(1).nullable(),
        service: SpiffeIdSchema,
        env: AuditEnvSchema,
    })
    .strip();

export type AuditDecisionEvent = z.infer<typeof AuditDecisionEventSchema>;

/**
 * Field name allowlist used by the runtime audit emitter to fail fast if
 * a caller passes a field that resembles a forbidden value (token, password,
 * full PII). The emitter rejects keys whose normalized name matches any
 * of these substrings — this is a soft guard, not a substitute for
 * disciplined emission sites.
 *
 * See ADR 0004 § "What MUST NOT appear in audit events".
 */
export const AUDIT_FORBIDDEN_FIELD_SUBSTRINGS: ReadonlyArray<string> = [
    'password',
    'secret',
    'access_token',
    'refresh_token',
    'bearer',
    'authorization',
    'cookie',
    'mfa_code',
    'otp',
    'credit_card',
    'ssn',
];

/**
 * Returns the substrings matched by a candidate key name. An emitter that
 * sees a non-empty result should drop the key (and log the drop).
 */
export function detectForbiddenField(key: string): ReadonlyArray<string> {
    const lower = key.toLowerCase();
    return AUDIT_FORBIDDEN_FIELD_SUBSTRINGS.filter((sub) => lower.includes(sub));
}

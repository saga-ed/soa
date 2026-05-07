import { describe, expect, it } from 'vitest';
import {
    AUDIT_FORBIDDEN_FIELD_SUBSTRINGS,
    AUDIT_SCHEMA_VERSION,
    AuditDecisionEventSchema,
    detectForbiddenField,
} from '../audit-event.js';

const validUserUuid = '00000000-0000-4000-8000-000000000001';

const validEvent = {
    schemaVersion: 'v1' as const,
    eventType: 'authz.check' as const,
    caller: { spiffeId: 'spiffe://saga.dev/programs-api' },
    subject: {
        sub: `spiffe://saga.dev/user/${validUserUuid}`,
        tenantId: 'district:42',
        sessionJti: 'session-1',
        tokenJti: 'token-1',
    },
    resource: {
        type: 'program',
        id: '7',
        tenantId: 'district:42',
    },
    action: 'view',
    decision: 'allow' as const,
    reason: null,
    fgaCheck: {
        relation: 'viewer',
        object: 'program:7',
    },
    occurredAt: '2026-05-07T12:00:00.000Z',
    correlationId: 'trace-abc',
    causationId: null,
    service: 'spiffe://saga.dev/programs-api',
    env: 'dev' as const,
};

describe('AuditDecisionEventSchema', () => {
    it('exports a stable schema version', () => {
        expect(AUDIT_SCHEMA_VERSION).toBe('v1');
    });

    it('accepts a fully populated event', () => {
        const result = AuditDecisionEventSchema.safeParse(validEvent);
        expect(result.success).toBe(true);
    });

    it('accepts events with null caller (direct end-user call)', () => {
        const event = { ...validEvent, caller: null };
        expect(AuditDecisionEventSchema.safeParse(event).success).toBe(true);
    });

    it('accepts events with null subject (failed login)', () => {
        const event = {
            ...validEvent,
            eventType: 'authn.login' as const,
            subject: null,
            resource: null,
            decision: 'deny' as const,
            reason: 'invalid_credentials',
            fgaCheck: null,
        };
        expect(AuditDecisionEventSchema.safeParse(event).success).toBe(true);
    });

    it('rejects unknown eventType', () => {
        const bad = { ...validEvent, eventType: 'authn.fancy_new' };
        expect(AuditDecisionEventSchema.safeParse(bad).success).toBe(false);
    });

    it('rejects unknown decision', () => {
        const bad = { ...validEvent, decision: 'maybe' };
        expect(AuditDecisionEventSchema.safeParse(bad).success).toBe(false);
    });

    it('rejects unknown env', () => {
        const bad = { ...validEvent, env: 'qa' };
        expect(AuditDecisionEventSchema.safeParse(bad).success).toBe(false);
    });

    it('rejects malformed SPIFFE in subject.sub', () => {
        const bad = {
            ...validEvent,
            subject: { ...validEvent.subject, sub: 'not-spiffe' },
        };
        expect(AuditDecisionEventSchema.safeParse(bad).success).toBe(false);
    });

    it('rejects malformed tenant id', () => {
        const bad = {
            ...validEvent,
            subject: { ...validEvent.subject, tenantId: 'badformat' },
        };
        expect(AuditDecisionEventSchema.safeParse(bad).success).toBe(false);
    });

    it('rejects non-iso occurredAt', () => {
        const bad = { ...validEvent, occurredAt: 'yesterday' };
        expect(AuditDecisionEventSchema.safeParse(bad).success).toBe(false);
    });
});

describe('detectForbiddenField', () => {
    it('flags exact forbidden substrings', () => {
        for (const sub of AUDIT_FORBIDDEN_FIELD_SUBSTRINGS) {
            expect(detectForbiddenField(`some_${sub}_field`).length).toBeGreaterThan(0);
        }
    });

    it('flags case-insensitively', () => {
        expect(detectForbiddenField('Authorization').length).toBeGreaterThan(0);
        expect(detectForbiddenField('Cookie').length).toBeGreaterThan(0);
    });

    it('does not flag innocuous names', () => {
        expect(detectForbiddenField('user_id')).toEqual([]);
        expect(detectForbiddenField('action')).toEqual([]);
        expect(detectForbiddenField('decision')).toEqual([]);
    });
});

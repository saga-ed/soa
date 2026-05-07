import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILogger } from '@saga-ed/soa-logger';
import {
    AUDIT_LOG_CHANNEL,
    createAuditEmitter,
    type AuditDecisionEvent,
    type AuditEmitInput,
} from '../index.js';

const validUserUuid = '00000000-0000-4000-8000-000000000001';

const makeBaseInput = (): AuditEmitInput => ({
    eventType: 'authz.check',
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
    decision: 'allow',
    reason: null,
    fgaCheck: { relation: 'viewer', object: 'program:7' },
    occurredAt: '2026-05-07T12:00:00.000Z',
    service: 'spiffe://saga.dev/programs-api',
    env: 'dev',
});

interface StubLogger {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
}

function makeStubLogger(): StubLogger {
    return {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    };
}

describe('createAuditEmitter', () => {
    let stub: StubLogger;
    let logger: ILogger;

    beforeEach(() => {
        stub = makeStubLogger();
        logger = stub as unknown as ILogger;
    });

    it('exports the canonical channel name', () => {
        expect(AUDIT_LOG_CHANNEL).toBe('audit');
    });

    it('writes through the default logger when no writer is supplied', async () => {
        const e = createAuditEmitter(logger);
        await e.emit(makeBaseInput());
        expect(stub.info).toHaveBeenCalledOnce();
        const [msg, fields] = stub.info.mock.calls[0] as [string, unknown];
        expect(msg).toBe('audit');
        expect((fields as { channel: string }).channel).toBe('audit');
    });

    it('calls the custom writer when supplied', async () => {
        const writer = vi.fn();
        const e = createAuditEmitter(logger, writer);
        await e.emit(makeBaseInput());
        expect(writer).toHaveBeenCalledOnce();
        expect(stub.info).not.toHaveBeenCalled();
    });

    it('stamps schemaVersion v1 by default', async () => {
        const writer = vi.fn();
        await createAuditEmitter(logger, writer).emit(makeBaseInput());
        const event = writer.mock.calls[0][0] as AuditDecisionEvent;
        expect(event.schemaVersion).toBe('v1');
    });

    it('stamps a correlationId when caller did not supply one', async () => {
        const writer = vi.fn();
        await createAuditEmitter(logger, writer).emit(makeBaseInput());
        const event = writer.mock.calls[0][0] as AuditDecisionEvent;
        expect(event.correlationId).toBeTruthy();
        expect(typeof event.correlationId).toBe('string');
    });

    it('honors the caller-supplied correlationId', async () => {
        const writer = vi.fn();
        await createAuditEmitter(logger, writer).emit({
            ...makeBaseInput(),
            correlationId: 'caller-supplied-trace',
        });
        const event = writer.mock.calls[0][0] as AuditDecisionEvent;
        expect(event.correlationId).toBe('caller-supplied-trace');
    });

    it('defaults causationId to null', async () => {
        const writer = vi.fn();
        await createAuditEmitter(logger, writer).emit(makeBaseInput());
        const event = writer.mock.calls[0][0] as AuditDecisionEvent;
        expect(event.causationId).toBeNull();
    });

    it('rejects malformed events at parse time', async () => {
        const writer = vi.fn();
        const e = createAuditEmitter(logger, writer);
        const bad = {
            ...makeBaseInput(),
            decision: 'maybe',
        } as unknown as AuditEmitInput;
        await expect(e.emit(bad)).rejects.toThrow();
        expect(writer).not.toHaveBeenCalled();
    });

    it('rejects events with malformed subject sub', async () => {
        const writer = vi.fn();
        const e = createAuditEmitter(logger, writer);
        const bad = {
            ...makeBaseInput(),
            subject: {
                ...makeBaseInput().subject!,
                sub: 'not-a-spiffe-id',
            },
        };
        await expect(e.emit(bad)).rejects.toThrow();
    });

    it('accepts null caller and subject for unauthenticated events', async () => {
        const writer = vi.fn();
        await createAuditEmitter(logger, writer).emit({
            eventType: 'authn.login',
            caller: null,
            subject: null,
            resource: null,
            action: 'login',
            decision: 'deny',
            reason: 'invalid_credentials',
            fgaCheck: null,
            occurredAt: '2026-05-07T12:00:00.000Z',
            service: 'spiffe://saga.dev/iam-api',
            env: 'dev',
        });
        expect(writer).toHaveBeenCalledOnce();
    });

    it('async writers are awaited', async () => {
        let resolved = false;
        const writer = vi.fn(
            async () =>
                new Promise<void>((resolve) => {
                    setTimeout(() => {
                        resolved = true;
                        resolve();
                    }, 10);
                }),
        );
        await createAuditEmitter(logger, writer).emit(makeBaseInput());
        expect(resolved).toBe(true);
    });
});

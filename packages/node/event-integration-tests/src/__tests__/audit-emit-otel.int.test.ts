import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
    context as otelContext,
    trace as otelTrace,
    type Tracer,
} from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import {
    BasicTracerProvider,
    InMemorySpanExporter,
    SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
    createAuditEmitter,
    AUDIT_LOG_CHANNEL,
    type AuditDecisionEvent,
} from '@saga-ed/soa-audit';
import type { ILogger } from '@saga-ed/soa-logger';

/**
 * Real-OTel round-trip of the ADR 0004 audit emit seam:
 *
 *   tracer.startActiveSpan(ctx) → audit.emit(input) →
 *   schema validation → writer captures event →
 *   correlationId === active span.traceId
 *
 * Unit tests on createAuditEmitter use the OTel api in no-op mode and
 * never see a real trace. This integration test wires a BasicTracerProvider
 * + AsyncHooksContextManager so the trace context actually propagates,
 * proving the correlationId default works in production-shaped runtimes.
 */
describe('audit emit + OTel correlation (integration)', () => {
    const captured: Array<{
        message: string;
        data: Record<string, unknown> | undefined;
    }> = [];
    const captureLogger: ILogger = {
        debug: () => {},
        info: (message, data) => {
            captured.push({ message, data: data as Record<string, unknown> });
        },
        warn: () => {},
        error: () => {},
    };

    let tracer: Tracer;
    let exporter: InMemorySpanExporter;
    let provider: BasicTracerProvider;
    let contextManager: AsyncHooksContextManager;

    beforeAll(() => {
        contextManager = new AsyncHooksContextManager();
        contextManager.enable();
        otelContext.setGlobalContextManager(contextManager);

        exporter = new InMemorySpanExporter();
        provider = new BasicTracerProvider();
        provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
        provider.register();

        tracer = otelTrace.getTracer('audit-int-test');
    });

    afterEach(() => {
        captured.length = 0;
        exporter.reset();
    });

    afterAll(async () => {
        await provider.shutdown();
        contextManager.disable();
        otelContext.disable();
    });

    it('correlationId equals the active span traceId when emitted under a span', async () => {
        const emitter = createAuditEmitter(captureLogger);
        let observedTraceId: string | null = null;

        await tracer.startActiveSpan('login-handler', async (span) => {
            observedTraceId = span.spanContext().traceId;
            await emitter.emit({
                eventType: 'authn.login',
                caller: null,
                subject: {
                    sub: 'spiffe://saga.dev/user/abc-123',
                    tenantId: 'district:dist-1',
                    sessionJti: 'sess-1',
                    tokenJti: null,
                },
                resource: null,
                action: 'login',
                decision: 'allow',
                reason: null,
                fgaCheck: null,
                occurredAt: new Date().toISOString(),
                service: 'spiffe://saga.dev/iam-api',
                env: 'dev',
            });
            span.end();
        });

        expect(captured.length).toBe(1);
        const evt = captured[0]!.data!.event as AuditDecisionEvent;
        expect(captured[0]!.data!.channel).toBe(AUDIT_LOG_CHANNEL);
        expect(observedTraceId).toMatch(/^[0-9a-f]{32}$/);
        expect(evt.correlationId).toBe(observedTraceId);
        expect(evt.schemaVersion).toBe('v1');
        expect(evt.eventType).toBe('authn.login');
    });

    it('falls back to a freshly generated 16-byte hex correlationId when no span is active', async () => {
        const emitter = createAuditEmitter(captureLogger);

        await emitter.emit({
            eventType: 'authn.login',
            caller: null,
            subject: null,
            resource: null,
            action: 'login_failed',
            decision: 'deny',
            reason: 'invalid_password',
            fgaCheck: null,
            occurredAt: new Date().toISOString(),
            service: 'spiffe://saga.dev/iam-api',
            env: 'dev',
        });

        const evt = captured[0]!.data!.event as AuditDecisionEvent;
        expect(evt.correlationId).toMatch(/^[0-9a-f]{32}$/);
    });

    it('explicit correlationId on the input wins over the active span', async () => {
        const emitter = createAuditEmitter(captureLogger);
        const explicit = 'a'.repeat(32);

        await tracer.startActiveSpan('outer', async (span) => {
            await emitter.emit({
                eventType: 'authz.check',
                caller: { spiffeId: 'spiffe://saga.dev/programs-api' },
                subject: {
                    sub: 'spiffe://saga.dev/user/abc',
                    tenantId: 'district:dist-1',
                    sessionJti: 'sess-1',
                    tokenJti: 'tok-1',
                },
                resource: { type: 'program', id: 'prog-1', tenantId: 'district:dist-1' },
                action: 'view',
                decision: 'allow',
                reason: null,
                fgaCheck: { relation: 'viewer', object: 'program:prog-1' },
                occurredAt: new Date().toISOString(),
                correlationId: explicit,
                service: 'spiffe://saga.dev/programs-api',
                env: 'dev',
            });
            span.end();
        });

        const evt = captured[0]!.data!.event as AuditDecisionEvent;
        expect(evt.correlationId).toBe(explicit);
    });

    it('schema validation rejects events missing a required field', async () => {
        const emitter = createAuditEmitter(captureLogger);
        // Cast through unknown to force a runtime-only invalid input —
        // runtime validation is the contract under test here.
        const badInput = {
            eventType: 'mutation.create',
            caller: null,
            subject: null,
            resource: null,
            // action intentionally omitted
            decision: 'allow',
            reason: null,
            fgaCheck: null,
            occurredAt: new Date().toISOString(),
            service: 'spiffe://saga.dev/programs-api',
            env: 'dev',
        } as unknown as Parameters<typeof emitter.emit>[0];
        await expect(emitter.emit(badInput)).rejects.toThrow();
        expect(captured.length).toBe(0);
    });

    it('schema rejects an env value not in the allowlist', async () => {
        const emitter = createAuditEmitter(captureLogger);
        const badInput = {
            eventType: 'authn.login',
            caller: null,
            subject: null,
            resource: null,
            action: 'login',
            decision: 'allow',
            reason: null,
            fgaCheck: null,
            occurredAt: new Date().toISOString(),
            service: 'spiffe://saga.dev/iam-api',
            env: 'qa',
        } as unknown as Parameters<typeof emitter.emit>[0];
        await expect(emitter.emit(badInput)).rejects.toThrow();
    });

    it('multiple emits within the same span share the same correlationId', async () => {
        const emitter = createAuditEmitter(captureLogger);
        let traceId: string | null = null;

        await tracer.startActiveSpan('mutation-handler', async (span) => {
            traceId = span.spanContext().traceId;
            await emitter.emit({
                eventType: 'authz.check',
                caller: { spiffeId: 'spiffe://saga.dev/programs-api' },
                subject: {
                    sub: 'spiffe://saga.dev/user/abc',
                    tenantId: 'district:dist-1',
                    sessionJti: 'sess-1',
                    tokenJti: 'tok-1',
                },
                resource: { type: 'program', id: 'prog-1', tenantId: 'district:dist-1' },
                action: 'create',
                decision: 'allow',
                reason: null,
                fgaCheck: { relation: 'editor', object: 'program:prog-1' },
                occurredAt: new Date().toISOString(),
                service: 'spiffe://saga.dev/programs-api',
                env: 'dev',
            });
            await emitter.emit({
                eventType: 'mutation.create',
                caller: { spiffeId: 'spiffe://saga.dev/programs-api' },
                subject: {
                    sub: 'spiffe://saga.dev/user/abc',
                    tenantId: 'district:dist-1',
                    sessionJti: 'sess-1',
                    tokenJti: 'tok-1',
                },
                resource: { type: 'program', id: 'prog-1', tenantId: 'district:dist-1' },
                action: 'create',
                decision: 'allow',
                reason: null,
                fgaCheck: null,
                occurredAt: new Date().toISOString(),
                service: 'spiffe://saga.dev/programs-api',
                env: 'dev',
            });
            span.end();
        });

        expect(captured.length).toBe(2);
        const a = captured[0]!.data!.event as AuditDecisionEvent;
        const b = captured[1]!.data!.event as AuditDecisionEvent;
        expect(a.correlationId).toBe(traceId);
        expect(b.correlationId).toBe(traceId);
    });

    it('custom writer receives the validated event and bypasses the logger', async () => {
        const writerCalls: AuditDecisionEvent[] = [];
        const emitter = createAuditEmitter(captureLogger, (event) => {
            writerCalls.push(event);
        });

        await emitter.emit({
            eventType: 'authn.logout',
            caller: null,
            subject: {
                sub: 'spiffe://saga.dev/user/abc',
                tenantId: 'district:dist-1',
                sessionJti: 'sess-1',
                tokenJti: 'tok-1',
            },
            resource: null,
            action: 'logout',
            decision: 'allow',
            reason: null,
            fgaCheck: null,
            occurredAt: new Date().toISOString(),
            service: 'spiffe://saga.dev/iam-api',
            env: 'dev',
        });

        expect(writerCalls.length).toBe(1);
        expect(writerCalls[0]!.eventType).toBe('authn.logout');
        // Logger NOT invoked when a custom writer is supplied.
        expect(captured.length).toBe(0);
    });
});

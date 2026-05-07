import { context, trace } from '@opentelemetry/api';
import {
    AuditDecisionEventSchema,
    type AuditDecisionEvent,
} from '@saga-ed/soa-auth-contracts';
import type { ILogger } from '@saga-ed/soa-logger';

/**
 * @saga-ed/soa-audit
 *
 * Thin wrapper around the structured logger that:
 *   1. Schema-validates every emitted event against
 *      `AuditDecisionEventSchema` (audit.decision.v1).
 *   2. Stamps `correlationId` from the active OTel trace context when
 *      the caller leaves it null.
 *   3. Emits via the logger's `'audit'` log channel name (added as a
 *      structured field; downstream pipelines route by it).
 *
 * The writer is the structured logger today. The storage tomorrow is a
 * hash-chained Postgres `audit_event` table with daily KMS-signed
 * Merkle roots written to S3 with Object Lock (compliance mode),
 * 7-year retention. Callers will not change — only the writer plugged
 * into `createAuditEmitter` will.
 *
 * See ADR 0004 (audit event shape) in saga-ed/soa.
 */

export const AUDIT_LOG_CHANNEL = 'audit' as const;

/**
 * Input shape — almost the full event, with these fields optional and
 * filled in by the emitter:
 *
 * - `schemaVersion` defaults to "v1"
 * - `correlationId` defaults to the active OTel traceId (or a fresh
 *   value when no trace is active)
 * - `causationId` defaults to null
 *
 * The caller MUST still provide every other field. Schema validation
 * runs after defaults are applied.
 */
export type AuditEmitInput = Omit<
    AuditDecisionEvent,
    'schemaVersion' | 'correlationId' | 'causationId'
> &
    Partial<
        Pick<
            AuditDecisionEvent,
            'schemaVersion' | 'correlationId' | 'causationId'
        >
    >;

/**
 * Pluggable writer. Default writer wraps `ILogger.info`. Tests pass an
 * in-memory writer; the future Postgres backend will pass an
 * append-row writer.
 */
export type AuditWriter = (event: AuditDecisionEvent) => void | Promise<void>;

export interface AuditEmitter {
    emit(input: AuditEmitInput): Promise<void>;
}

/**
 * Create an emitter bound to a logger. Every emit:
 *   1. Fills defaults (schemaVersion, correlationId, causationId)
 *   2. Validates via the canonical schema
 *   3. Calls the writer
 *
 * Any validation failure throws. Callers should never catch and swallow
 * — a failure means the event the caller built is malformed and the
 * audit trail integrity is at risk.
 */
export function createAuditEmitter(
    logger: ILogger,
    writer?: AuditWriter,
): AuditEmitter {
    const defaultWriter: AuditWriter = (event) => {
        logger.info('audit', {
            channel: AUDIT_LOG_CHANNEL,
            event,
        });
    };
    const w = writer ?? defaultWriter;
    return {
        async emit(input: AuditEmitInput): Promise<void> {
            const traceId =
                trace.getSpan(context.active())?.spanContext().traceId ?? null;
            const candidate = {
                schemaVersion: 'v1' as const,
                correlationId: traceId ?? cryptoRandomTraceId(),
                causationId: null,
                ...input,
            };
            // Validate exhaustively — fail loud rather than ship a
            // malformed audit row.
            const event = AuditDecisionEventSchema.parse(candidate);
            await w(event);
        },
    };
}

/**
 * Generate a 16-byte hex string in the W3C TraceContext shape, used as
 * a correlation id when the caller did not supply one.
 *
 * Requires `globalThis.crypto.getRandomValues` (Node 19+, all modern
 * browsers, Cloudflare Workers, Deno, Bun). The audit package is
 * intentionally Node-only per `packages/node/CLAUDE.md`, but the
 * Web-Crypto-only pattern keeps it portable to edge runtimes if a
 * future caller needs it.
 */
function cryptoRandomTraceId(): string {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    let hex = '';
    for (const byte of bytes) {
        hex += byte!.toString(16).padStart(2, '0');
    }
    return hex;
}

export type { AuditDecisionEvent } from '@saga-ed/soa-auth-contracts';

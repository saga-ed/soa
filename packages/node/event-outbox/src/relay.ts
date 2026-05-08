import type { Channel } from 'amqplib';
import type { Pool } from 'pg';
import type { ILogger } from '@saga-ed/soa-logger';
import type { ConnectionManager } from '@saga-ed/soa-rabbitmq';
import type { EventEnvelope } from '@saga-ed/soa-event-envelope';
import {
    SpanKind,
    SpanStatusCode,
    context,
    propagation,
    trace,
} from '@opentelemetry/api';

export interface OutboxMetrics {
    /** Called after a row is successfully published. */
    onPublished: (eventType: string, eventVersion: number) => void;
    /** Called when publishing a row throws. */
    onPublishFailed: (eventType: string, eventVersion: number, reason: string) => void;
}

/**
 * Hook for transforming an envelope between database load and AMQP publish.
 *
 * The primary use case is signing per ADR 0003: producers wrap an HMAC
 * signer and pass it as `transformEnvelope`. The hook receives the
 * envelope already enriched with the wire trace context and returns a
 * possibly-modified envelope. Throwing aborts publication for that row;
 * it stays unpublished and is retried on the next tick.
 *
 * The hook MUST be a pure function of its input — no mutation. Returning
 * the same reference is fine when no transformation applies.
 */
export type EnvelopeTransform = (
    envelope: EventEnvelope,
) => EventEnvelope | Promise<EventEnvelope>;

export interface OutboxRelayOpts {
    /** Dedicated pg pool for the relay (separate from the service's Prisma client). */
    pool: Pool;
    /** Connection manager from @saga-ed/soa-rabbitmq for resilient AMQP. */
    connectionManager: ConnectionManager;
    /** Topic exchange to publish into (e.g., "identity.events"). */
    exchange: string;
    /** Polling cadence. Defaults to 500ms (matches ledger-api). */
    pollIntervalMs?: number;
    /** Max rows per poll. Defaults to 100. */
    batchSize?: number;
    /**
     * Max time to wait for a `'drain'` event when the AMQP channel buffer is
     * full. Without a cap, a silently-dropped TCP socket (NAT timeout, network
     * blackhole) can wedge the relay because none of `drain`/`error`/`close`
     * fires until amqplib's heartbeat eventually closes the connection.
     * Defaults to 30s.
     */
    drainTimeoutMs?: number;
    /**
     * Called when the relay encounters an unrecoverable pg error
     * (auth failure, missing role, missing database, missing table). Default
     * behavior: rethrow out of `tick()` so the parent process surfaces it via
     * `process.on('uncaughtException')` and the orchestrator restarts.
     * Override to e.g. trigger a graceful shutdown.
     */
    onFatalError?: (err: Error) => void;
    /** Optional Prometheus hooks. No-op when undefined. */
    metrics?: OutboxMetrics;
    /**
     * Optional transform applied to each envelope between database load
     * and AMQP publish. Used by producers to attach an HMAC signature
     * per ADR 0003 (signed event envelope). Defaults to identity.
     */
    transformEnvelope?: EnvelopeTransform;
    /**
     * Per-row retry budget. Rows whose `attempts` reach this value are
     * skipped on subsequent polls (still selected for forensics via
     * direct queries) — without this cap, a permanently-malformed
     * envelope or a permanently-broken `transformEnvelope` would
     * wedge the relay in a tight retry loop, hot-path the broker, and
     * stall the rest of the queue. Default 5. Operators bumping this
     * should plan for the tradeoff: more retries = more flakiness
     * tolerance but longer poison-row dwell.
     */
    maxAttempts?: number;
    logger: ILogger;
}

interface OutboxRow {
    event_id: string;
    aggregate_type: string;
    aggregate_id: string;
    event_type: string;
    event_version: number;
    payload: unknown;
    meta: Record<string, unknown> | null;
    occurred_at: Date;
    attempts: number;
}

const tracer = trace.getTracer('@saga-ed/soa-event-outbox');

/**
 * Polling outbox relay. Selects unpublished rows with FOR UPDATE SKIP LOCKED
 * (multi-relay safe), publishes each to RabbitMQ, then marks them published in
 * a single batched UPDATE before commit. Errors leave rows unpublished for the
 * next tick. Per-row retry budgets + DLQ wiring are not yet implemented.
 */
export class OutboxRelay {
    private channel: Channel | null = null;
    private timer: NodeJS.Timeout | null = null;
    private running = false;

    constructor(private readonly opts: OutboxRelayOpts) {}

    async start(): Promise<void> {
        this.channel = await this.opts.connectionManager.newChannel();
        await this.channel.assertExchange(this.opts.exchange, 'topic', { durable: true });
        // Publishes use `persistent: true` for durability but do NOT wait for
        // publisher confirms — `@saga-ed/soa-rabbitmq` exposes only a plain
        // Channel today, not a ConfirmChannel. A broker crash between
        // `channel.publish` and disk persistence could drop messages. Widen
        // soa-rabbitmq with `newConfirmChannel()` to restore strict
        // at-least-once.

        this.running = true;
        this.opts.logger.info(`[OutboxRelay] started (exchange=${this.opts.exchange})`);
        this.scheduleNext();
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.channel) {
            try {
                await this.channel.close();
            } catch {
                // Already closed by connection manager
            }
            this.channel = null;
        }
        this.opts.logger.info('[OutboxRelay] stopped');
    }

    private scheduleNext(): void {
        if (!this.running) return;
        const interval = this.opts.pollIntervalMs ?? 500;
        this.timer = setTimeout(() => {
            void this.tick();
        }, interval);
    }

    private async tick(): Promise<void> {
        try {
            await this.drainBatch();
        } catch (err) {
            const e = err instanceof Error ? err : new Error(String(err));
            if (isFatalPgError(e)) {
                // Configuration / permission errors aren't going to fix
                // themselves on the next tick — log loudly and stop the loop
                // so the orchestrator notices instead of burying 2 errors/sec
                // in Sentry forever.
                this.opts.logger.error(
                    '[OutboxRelay] fatal pg error; halting',
                    e,
                );
                this.running = false;
                if (this.opts.onFatalError) {
                    this.opts.onFatalError(e);
                } else {
                    throw e;
                }
                return;
            }
            this.opts.logger.error('[OutboxRelay] poll failed', e);
        }
        this.scheduleNext();
    }

    private async drainBatch(): Promise<void> {
        if (!this.channel) {
            throw new Error('OutboxRelay not started');
        }
        const batchSize = this.opts.batchSize ?? 100;
        const maxAttempts = this.opts.maxAttempts ?? 5;
        const client = await this.opts.pool.connect();
        let clientPoisoned = false;
        try {
            await client.query('BEGIN');
            const result = await client.query<OutboxRow>(
                `SELECT event_id, aggregate_type, aggregate_id, event_type,
                        event_version, payload, meta, occurred_at, attempts
                 FROM outbox_event
                 WHERE published_at IS NULL
                   AND attempts < $2
                 ORDER BY occurred_at
                 LIMIT $1
                 FOR UPDATE SKIP LOCKED`,
                [batchSize, maxAttempts],
            );

            if (result.rows.length === 0) {
                await client.query('COMMIT');
                return;
            }

            const publishedIds: string[] = [];
            const failedIds: string[] = [];
            const failedMessages: string[] = [];
            for (const row of result.rows) {
                try {
                    await this.publishRow(row);
                    publishedIds.push(row.event_id);
                } catch (err) {
                    // Per-row isolation: one bad row bumps its own
                    // attempts counter without blocking the rest of
                    // the batch.
                    const message =
                        err instanceof Error ? err.message : String(err);
                    failedIds.push(row.event_id);
                    failedMessages.push(message.slice(0, 1000));
                    this.opts.logger.warn(
                        `[OutboxRelay] publishRow failed for event ${row.event_id} (attempt ${row.attempts + 1}/${maxAttempts}): ${message}`,
                    );
                    this.opts.metrics?.onPublishFailed(
                        row.event_type,
                        row.event_version,
                        message,
                    );
                }
            }

            if (publishedIds.length > 0) {
                await client.query(
                    `UPDATE outbox_event SET published_at = NOW() WHERE event_id = ANY($1::uuid[])`,
                    [publishedIds],
                );
            }
            if (failedIds.length > 0) {
                await client.query(
                    `UPDATE outbox_event
                     SET attempts = attempts + 1,
                         last_error = u.err
                     FROM unnest($1::uuid[], $2::text[]) AS u(id, err)
                     WHERE outbox_event.event_id = u.id`,
                    [failedIds, failedMessages],
                );
            }

            await client.query('COMMIT');
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackErr) {
                // Mid-tx connection loss can fail both ops. The pg client is
                // in unknown state and must NOT be recycled — `release(err)`
                // tells node-postgres to destroy it.
                clientPoisoned = true;
                this.opts.logger.error(
                    '[OutboxRelay] ROLLBACK failed; destroying client',
                    rollbackErr instanceof Error ? rollbackErr : undefined,
                );
            }
            throw err;
        } finally {
            if (clientPoisoned) {
                client.release(new Error('rollback failed; client destroyed'));
            } else {
                client.release();
            }
        }
    }

    private async publishRow(row: OutboxRow): Promise<void> {
        if (!this.channel) {
            throw new Error('OutboxRelay channel missing');
        }

        // Restore the trace context the publisher captured at outbox-write
        // time so this PRODUCER span chains under the original request span,
        // and the consumer's CONSUMER span chains under this one. End-to-end
        // trace stays connected even though publish happens asynchronously.
        const parentCtx = row.meta
            ? propagation.extract(context.active(), row.meta as Record<string, string>)
            : context.active();

        await context.with(parentCtx, async () => {
            const span = tracer.startSpan(
                `publish ${row.event_type}.v${row.event_version}`,
                {
                    kind: SpanKind.PRODUCER,
                    attributes: {
                        'messaging.system': 'rabbitmq',
                        'messaging.destination': this.opts.exchange,
                        'messaging.destination_kind': 'topic',
                        'messaging.rabbitmq.routing_key': row.event_type,
                        'event.id': row.event_id,
                        'event.type': row.event_type,
                        'event.version': row.event_version,
                        'event.aggregate_type': row.aggregate_type,
                        'event.aggregate_id': row.aggregate_id,
                    },
                },
            );

            try {
                // Re-inject trace context AFTER starting the publish span so
                // the consumer's parent is THIS span (not the original
                // request span). That gives the consumer a direct parent
                // pointer to the publish hop, which is what shows up cleanly
                // in Jaeger as `request → publish → consume`.
                const wireMeta: Record<string, unknown> = { ...(row.meta ?? {}) };
                propagation.inject(
                    trace.setSpan(context.active(), span),
                    wireMeta,
                );

                const message: EventEnvelope = {
                    eventId: row.event_id,
                    eventType: row.event_type,
                    eventVersion: row.event_version,
                    aggregateType: row.aggregate_type,
                    aggregateId: row.aggregate_id,
                    occurredAt: row.occurred_at.toISOString(),
                    payload: row.payload as Record<string, unknown>,
                    ...(Object.keys(wireMeta).length > 0
                        ? { meta: wireMeta as EventEnvelope['meta'] }
                        : {}),
                };

                // ADR 0003 — apply optional transform (typically signing)
                // after the trace context is in place but before publish.
                // The transform must NOT mutate `message`; the relay
                // continues with the returned envelope.
                const transform = this.opts.transformEnvelope;
                const finalMessage = transform ? await transform(message) : message;

                const ok = this.channel!.publish(
                    this.opts.exchange,
                    row.event_type,
                    Buffer.from(JSON.stringify(finalMessage)),
                    {
                        contentType: 'application/json',
                        persistent: true,
                        messageId: row.event_id,
                    },
                );

                if (!ok) {
                    // Channel buffer full. Wait for drain, but also listen
                    // for 'error'/'close' AND a hard timeout — without all
                    // three, a silently-dropped TCP socket can wedge the
                    // relay because none of those events arrive until
                    // amqplib's heartbeat eventually closes the connection,
                    // and the row stays locked under FOR UPDATE SKIP LOCKED.
                    const ch = this.channel!;
                    const timeoutMs = this.opts.drainTimeoutMs ?? 30_000;
                    await new Promise<void>((resolve, reject) => {
                        const cleanup = (): void => {
                            clearTimeout(timer);
                            ch.removeListener('drain', onDrain);
                            ch.removeListener('error', onError);
                            ch.removeListener('close', onClose);
                        };
                        const onDrain = (): void => {
                            cleanup();
                            resolve();
                        };
                        const onError = (err: Error): void => {
                            cleanup();
                            reject(err);
                        };
                        const onClose = (): void => {
                            cleanup();
                            reject(new Error('channel closed while awaiting drain'));
                        };
                        const timer = setTimeout(() => {
                            cleanup();
                            reject(
                                new Error(
                                    `timed out after ${timeoutMs}ms awaiting channel drain`,
                                ),
                            );
                        }, timeoutMs);
                        ch.once('drain', onDrain);
                        ch.once('error', onError);
                        ch.once('close', onClose);
                    });
                }

                this.opts.metrics?.onPublished(row.event_type, row.event_version);
                span.setStatus({ code: SpanStatusCode.OK });
            } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                this.opts.metrics?.onPublishFailed(
                    row.event_type,
                    row.event_version,
                    reason,
                );
                span.recordException(err instanceof Error ? err : new Error(reason));
                span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
                throw err;
            } finally {
                span.end();
            }
        });
    }
}

/**
 * SQLSTATE codes that indicate a misconfiguration or missing object that the
 * relay cannot recover from by retrying. Any of these surfacing repeatedly
 * means manual intervention (rotate creds, grant role, run migration) — the
 * relay should fail loudly so the orchestrator can restart and alerts fire,
 * rather than burning quota with `ERROR`-level logs forever.
 *
 * - 28P01: invalid_password (auth failure)
 * - 28000: invalid_authorization_specification
 * - 42501: insufficient_privilege (role lacks SELECT/UPDATE)
 * - 3D000: invalid_catalog_name (database missing)
 * - 42P01: undefined_table (outbox_event missing — migration not run)
 */
const FATAL_PG_CODES = new Set(['28P01', '28000', '42501', '3D000', '42P01']);

function isFatalPgError(err: Error): boolean {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' && FATAL_PG_CODES.has(code);
}

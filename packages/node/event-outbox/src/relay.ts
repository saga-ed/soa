import type { Channel } from 'amqplib';
import type { Pool, PoolClient } from 'pg';
import type { ILogger } from '@saga-ed/soa-logger';
import type { ConnectionManager } from '@saga-ed/soa-rabbitmq';
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
    /** Optional Prometheus hooks. No-op when undefined. */
    metrics?: OutboxMetrics;
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
 * Polling outbox relay. On each tick:
 *   1. SELECT unpublished rows FOR UPDATE SKIP LOCKED (multi-relay safe).
 *   2. For each row: publish to RabbitMQ, mark published_at = NOW().
 *   3. COMMIT.
 *
 * On error within a row, the row stays unpublished and is retried next tick.
 * Phase 4+ will add per-row retry budgets + DLQ wiring.
 */
export class OutboxRelay {
    private channel: Channel | null = null;
    private timer: NodeJS.Timeout | null = null;
    private running = false;

    constructor(private readonly opts: OutboxRelayOpts) {}

    async start(): Promise<void> {
        this.channel = await this.opts.connectionManager.newChannel();
        await this.channel.assertExchange(this.opts.exchange, 'topic', { durable: true });
        // NOTE: Phase 1 uses `persistent: true` for durability but does not
        // wait for publisher confirms (soa-rabbitmq's `newChannel()` returns
        // a plain Channel, not a ConfirmChannel). This means a broker crash
        // between `channel.publish` and disk persistence could drop messages.
        // Phase 4+ will widen soa-rabbitmq with `newConfirmChannel()` and
        // restore strict at-least-once semantics.

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
            this.opts.logger.error(
                '[OutboxRelay] poll failed',
                err instanceof Error ? err : undefined,
            );
        }
        this.scheduleNext();
    }

    private async drainBatch(): Promise<void> {
        if (!this.channel) {
            throw new Error('OutboxRelay not started');
        }
        const batchSize = this.opts.batchSize ?? 100;
        const client = await this.opts.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await client.query<OutboxRow>(
                `SELECT event_id, aggregate_type, aggregate_id, event_type,
                        event_version, payload, meta, occurred_at, attempts
                 FROM outbox_event
                 WHERE published_at IS NULL
                 ORDER BY occurred_at
                 LIMIT $1
                 FOR UPDATE SKIP LOCKED`,
                [batchSize],
            );

            if (result.rows.length === 0) {
                await client.query('COMMIT');
                return;
            }

            for (const row of result.rows) {
                await this.publishRow(client, row);
            }

            await client.query('COMMIT');
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch {
                // Ignore rollback failures
            }
            throw err;
        } finally {
            client.release();
        }
    }

    private async publishRow(client: PoolClient, row: OutboxRow): Promise<void> {
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

                const message = {
                    eventId: row.event_id,
                    eventType: row.event_type,
                    eventVersion: row.event_version,
                    aggregateType: row.aggregate_type,
                    aggregateId: row.aggregate_id,
                    occurredAt: row.occurred_at.toISOString(),
                    payload: row.payload,
                    ...(Object.keys(wireMeta).length > 0 ? { meta: wireMeta } : {}),
                };

                const ok = this.channel!.publish(
                    this.opts.exchange,
                    row.event_type,
                    Buffer.from(JSON.stringify(message)),
                    {
                        contentType: 'application/json',
                        persistent: true,
                        messageId: row.event_id,
                    },
                );

                if (!ok) {
                    // Channel buffer full. Wait for drain, but also listen
                    // for 'error' / 'close' — without those, a connection
                    // drop while we're awaiting drain leaves the row locked
                    // under FOR UPDATE SKIP LOCKED forever and the relay
                    // hangs.
                    const ch = this.channel!;
                    await new Promise<void>((resolve, reject) => {
                        const onDrain = (): void => {
                            ch.removeListener('error', onError);
                            ch.removeListener('close', onClose);
                            resolve();
                        };
                        const onError = (err: Error): void => {
                            ch.removeListener('drain', onDrain);
                            ch.removeListener('close', onClose);
                            reject(err);
                        };
                        const onClose = (): void => {
                            ch.removeListener('drain', onDrain);
                            ch.removeListener('error', onError);
                            reject(new Error('channel closed while awaiting drain'));
                        };
                        ch.once('drain', onDrain);
                        ch.once('error', onError);
                        ch.once('close', onClose);
                    });
                }

                await client.query(
                    `UPDATE outbox_event SET published_at = NOW() WHERE event_id = $1`,
                    [row.event_id],
                );

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

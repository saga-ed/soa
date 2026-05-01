import type { Channel } from 'amqplib';
import type { Pool, PoolClient } from 'pg';
import type { ZodType } from 'zod';
import type { ILogger } from '@saga-ed/soa-logger';
import type { ConnectionManager } from '@saga-ed/soa-rabbitmq';
import {
    SpanKind,
    SpanStatusCode,
    context,
    propagation,
    trace,
} from '@opentelemetry/api';
import { EventEnvelopeSchema, type EventEnvelope } from '@saga-ed/soa-event-envelope';

export class ConsumerVersionMismatchError extends Error {
    constructor(public readonly key: string) {
        super(`No handler registered for event key "${key}"`);
        this.name = 'ConsumerVersionMismatchError';
    }
}

export interface EventHandler<T> {
    /** "<eventType>.v<eventVersion>" — must match envelope's lookup key. */
    key: string;
    payloadSchema: ZodType<T>;
    /**
     * Run the projection / side effect within the supplied tx-scoped client.
     * The consumer guarantees: (a) the consumed_events row was just inserted,
     * (b) the handler runs in the same tx, (c) errors will roll back the
     * idempotency row alongside the projection.
     */
    handle: (
        envelope: EventEnvelope,
        payload: T,
        tx: PoolClient,
    ) => Promise<void>;
}

export interface EventConsumerBinding {
    /** Topic exchange to bind from (e.g., "identity.events"). */
    exchange: string;
    /** Routing-key pattern (e.g., "identity.user.*" or "#"). */
    routingKey: string;
}

export interface DlqConfig {
    /**
     * Dead-letter exchange name. The main queue is declared with
     * `x-dead-letter-exchange = exchange` so RabbitMQ routes nacked-with-
     * noRequeue messages here automatically.
     */
    exchange: string;
    /** Durable DLQ queue name; bound to `exchange` with routing key `#`. */
    queue: string;
}

export interface ConsumerMetrics {
    /** Called after a handler successfully completes. */
    onProcessed: (eventType: string, eventVersion: number) => void;
    /** Called when handler/parsing throws. `reason` is err.message. */
    onFailed: (eventType: string, eventVersion: number, reason: string) => void;
    /** Called for events skipped as duplicates (idempotency hit). */
    onDuplicate: (eventType: string, eventVersion: number) => void;
}

export interface EventConsumerOpts {
    /** Stable identifier used for the consumed_events idempotency key. */
    consumerName: string;
    pool: Pool;
    connectionManager: ConnectionManager;
    /** Durable queue name (e.g., "admissions-svc.upstream-events"). */
    queue: string;
    /**
     * One or more `{ exchange, routingKey }` pairs to bind this queue to.
     * A consumer can fan in events from multiple upstream domains via the
     * same queue (single handlers map dispatches by `<eventType>.v<version>`).
     */
    bindings: EventConsumerBinding[];
    /** Handlers keyed by "<eventType>.v<eventVersion>". */
    handlers: Record<string, EventHandler<unknown>>;
    /** Prefetch count (default 10). */
    prefetch?: number;
    /**
     * Optional dead-letter wiring. When set, the main queue is declared
     * with `x-dead-letter-exchange` and a sibling DLQ is asserted + bound
     * to that DLX. On ANY handler error, the message is nacked WITHOUT
     * requeue, causing RabbitMQ to route it to the DLX → DLQ (fail-fast:
     * ops drain via the RabbitMQ management UI). Without this option,
     * errors nack-with-requeue.
     */
    dlq?: DlqConfig;
    /** Optional Prometheus hooks. No-op when undefined. */
    metrics?: ConsumerMetrics;
    logger: ILogger;
}

const tracer = trace.getTracer('@saga-ed/soa-event-consumer');

/**
 * RabbitMQ consumer that gives at-least-once delivery + idempotent processing.
 *
 * On each message:
 *   1. Parse envelope (Zod-validate the wire shape).
 *   2. Look up handler by "<eventType>.v<eventVersion>"; missing → throw.
 *   3. BEGIN; INSERT consumed_events ON CONFLICT DO NOTHING.
 *   4. If 0 rows inserted → already processed; COMMIT and ack.
 *   5. Else: validate payload, run handler within the tx, COMMIT, ack.
 *   6. On error: ROLLBACK, nack — to DLQ if configured, requeue otherwise.
 */
export class EventConsumer {
    private channel: Channel | null = null;
    private consumerTag: string | null = null;

    constructor(private readonly opts: EventConsumerOpts) {}

    async start(): Promise<void> {
        this.channel = await this.opts.connectionManager.newChannel();
        await this.channel.prefetch(this.opts.prefetch ?? 10);

        // Wire DLQ first if configured — must be declared before the main queue
        // so the main queue's x-dead-letter-exchange resolves.
        if (this.opts.dlq) {
            await this.channel.assertExchange(this.opts.dlq.exchange, 'topic', {
                durable: true,
            });
            await this.channel.assertQueue(this.opts.dlq.queue, { durable: true });
            await this.channel.bindQueue(
                this.opts.dlq.queue,
                this.opts.dlq.exchange,
                '#',
            );
        }

        await this.channel.assertQueue(this.opts.queue, {
            durable: true,
            ...(this.opts.dlq
                ? { arguments: { 'x-dead-letter-exchange': this.opts.dlq.exchange } }
                : {}),
        });

        for (const binding of this.opts.bindings) {
            await this.channel.assertExchange(binding.exchange, 'topic', {
                durable: true,
            });
            await this.channel.bindQueue(
                this.opts.queue,
                binding.exchange,
                binding.routingKey,
            );
        }

        const useDlq = Boolean(this.opts.dlq);
        const consumeRes = await this.channel.consume(
            this.opts.queue,
            (msg) => {
                if (!msg) return;
                void this.handleMessage(msg.content)
                    .then(() => this.channel?.ack(msg))
                    .catch((err) => {
                        this.opts.logger.error(
                            `[EventConsumer:${this.opts.consumerName}] handler error → ${useDlq ? 'DLQ' : 'requeue'}`,
                            err instanceof Error ? err : undefined,
                        );
                        // useDlq: nack-without-requeue → DLX routes to DLQ.
                        // Otherwise: nack-with-requeue (legacy behavior).
                        this.channel?.nack(msg, false, !useDlq);
                    });
            },
            { noAck: false },
        );

        this.consumerTag = consumeRes.consumerTag;
        this.opts.logger.info(
            `[EventConsumer:${this.opts.consumerName}] started (queue=${this.opts.queue})`,
        );
    }

    async stop(): Promise<void> {
        if (this.channel && this.consumerTag) {
            try {
                await this.channel.cancel(this.consumerTag);
            } catch {
                // already cancelled
            }
            this.consumerTag = null;
        }
        if (this.channel) {
            try {
                await this.channel.close();
            } catch {
                // already closed
            }
            this.channel = null;
        }
        this.opts.logger.info(`[EventConsumer:${this.opts.consumerName}] stopped`);
    }

    private async handleMessage(buffer: Buffer): Promise<void> {
        let envelope: EventEnvelope;
        try {
            const raw = JSON.parse(buffer.toString('utf8')) as unknown;
            envelope = EventEnvelopeSchema.parse(raw);
        } catch (err) {
            // Malformed envelope: surface as error so DLQ can quarantine it.
            // No metrics call here — eventType/version unknown.
            throw new Error(
                `Malformed envelope: ${err instanceof Error ? err.message : String(err)}`,
            );
        }

        const parentCtx = envelope.meta
            ? propagation.extract(
                  context.active(),
                  envelope.meta as Record<string, string>,
              )
            : context.active();

        await context.with(parentCtx, async () => {
            const span = tracer.startSpan(
                `consume ${envelope.eventType}.v${envelope.eventVersion}`,
                {
                    kind: SpanKind.CONSUMER,
                    attributes: {
                        'messaging.system': 'rabbitmq',
                        'messaging.destination': this.opts.queue,
                        'messaging.operation': 'process',
                        'event.id': envelope.eventId,
                        'event.type': envelope.eventType,
                        'event.version': envelope.eventVersion,
                        'event.aggregate_type': envelope.aggregateType,
                        'event.aggregate_id': envelope.aggregateId,
                        'consumer.name': this.opts.consumerName,
                    },
                },
            );

            try {
                await context.with(
                    trace.setSpan(context.active(), span),
                    () => this.processEnvelope(envelope),
                );
                span.setStatus({ code: SpanStatusCode.OK });
                this.opts.metrics?.onProcessed(
                    envelope.eventType,
                    envelope.eventVersion,
                );
            } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                span.recordException(err instanceof Error ? err : new Error(reason));
                span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
                this.opts.metrics?.onFailed(
                    envelope.eventType,
                    envelope.eventVersion,
                    reason,
                );
                throw err;
            } finally {
                span.end();
            }
        });
    }

    private async processEnvelope(envelope: EventEnvelope): Promise<void> {
        const key = `${envelope.eventType}.v${envelope.eventVersion}`;
        const handler = this.opts.handlers[key];
        if (!handler) {
            throw new ConsumerVersionMismatchError(key);
        }

        const payload = handler.payloadSchema.parse(envelope.payload);

        const client = await this.opts.pool.connect();
        try {
            await client.query('BEGIN');

            const insertResult = await client.query<{ event_id: string }>(
                `INSERT INTO consumed_events (consumer_name, event_id)
                 VALUES ($1, $2)
                 ON CONFLICT (consumer_name, event_id) DO NOTHING
                 RETURNING event_id`,
                [this.opts.consumerName, envelope.eventId],
            );

            if (insertResult.rowCount === 0) {
                // Duplicate delivery — already processed. Logged at debug
                // because high-throughput streams can produce these by the
                // thousand and they aren't operationally interesting beyond
                // the events_duplicate_total counter.
                await client.query('COMMIT');
                this.opts.logger.debug(
                    `[EventConsumer:${this.opts.consumerName}] skip duplicate ${envelope.eventId}`,
                );
                this.opts.metrics?.onDuplicate(
                    envelope.eventType,
                    envelope.eventVersion,
                );
                return;
            }

            await handler.handle(envelope, payload as never, client);
            await client.query('COMMIT');
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch {
                // ignore rollback failures
            }
            throw err;
        } finally {
            client.release();
        }
    }
}

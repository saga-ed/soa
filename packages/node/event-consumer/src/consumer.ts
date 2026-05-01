import type { Channel, ConsumeMessage } from 'amqplib';
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

declare const EVENT_KEY_BRAND: unique symbol;

/**
 * `<eventType>.v<eventVersion>` formed by `eventKey()`. Branded so a raw string
 * can't accidentally satisfy a handler-lookup parameter — the only way to
 * mint one is the constructor, which guarantees the format.
 */
export type EventKey = string & { readonly [EVENT_KEY_BRAND]: true };

export function eventKey(eventType: string, eventVersion: number): EventKey {
    return `${eventType}.v${eventVersion}` as EventKey;
}

export class ConsumerVersionMismatchError extends Error {
    constructor(public readonly key: EventKey) {
        super(`No handler registered for event key "${key}"`);
        this.name = 'ConsumerVersionMismatchError';
    }
}

/**
 * Thrown by `buildHandlerMap` when two handlers share the same `(eventType,
 * eventVersion)` — silent collisions used to be possible when handlers were
 * passed as a `Record<string, EventHandler>` and a typo in the key string
 * shadowed the intended handler.
 */
export class DuplicateHandlerError extends Error {
    constructor(public readonly key: EventKey) {
        super(`Duplicate handler registered for event key "${key}"`);
        this.name = 'DuplicateHandlerError';
    }
}

export interface EventHandler<T> {
    eventType: string;
    eventVersion: number;
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

export type HandlerMap = ReadonlyMap<EventKey, EventHandler<unknown>>;

/**
 * Build the handler lookup map from a flat array. Throws on duplicate
 * `(eventType, eventVersion)`. Use this instead of constructing a Map by
 * hand so the EventKey invariant is enforced at the single registration
 * point.
 */
export function buildHandlerMap(
    handlers: ReadonlyArray<EventHandler<unknown>>,
): HandlerMap {
    const map = new Map<EventKey, EventHandler<unknown>>();
    for (const h of handlers) {
        const key = eventKey(h.eventType, h.eventVersion);
        if (map.has(key)) throw new DuplicateHandlerError(key);
        map.set(key, h);
    }
    return map;
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
     * same queue (handlers map dispatches by `<eventType>.v<version>`).
     */
    bindings: EventConsumerBinding[];
    /**
     * Flat list of handlers — internally indexed by `eventKey(eventType,
     * eventVersion)`. Pass via `buildHandlerMap()` if you already have a
     * map; otherwise the consumer builds it itself and rejects duplicates.
     */
    handlers: ReadonlyArray<EventHandler<unknown>>;
    /** Prefetch count (default 10). */
    prefetch?: number;
    /**
     * Optional dead-letter wiring. When set, the main queue is declared
     * with `x-dead-letter-exchange` and a sibling DLQ is asserted + bound
     * to that DLX. On ANY handler error, the message is nacked WITHOUT
     * requeue, causing RabbitMQ to route it to the DLX → DLQ (fail-fast:
     * ops drain via the RabbitMQ management UI). Without this option,
     * handler errors nack-with-requeue (transient errors retry).
     *
     * Note: malformed envelopes and unknown-handler-key errors ALWAYS nack
     * without requeue, regardless of `dlq` — re-delivering an unparseable
     * or unrouteable message just creates a tight poison loop.
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
 *   2. Look up handler by `eventKey(eventType, eventVersion)`; missing → throw
 *      ConsumerVersionMismatchError (treated as poison, never requeued).
 *   3. BEGIN; INSERT consumed_events ON CONFLICT DO NOTHING.
 *   4. If 0 rows inserted → already processed; COMMIT and ack.
 *   5. Else: validate payload, run handler within the tx, COMMIT, ack.
 *   6. On handler error: ROLLBACK, nack — to DLQ if configured, requeue
 *      otherwise. Parse / unknown-key errors always nack without requeue.
 */
export class EventConsumer {
    private channel: Channel | null = null;
    private consumerTag: string | null = null;
    private readonly handlerMap: HandlerMap;

    constructor(private readonly opts: EventConsumerOpts) {
        this.handlerMap = buildHandlerMap(opts.handlers);
    }

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

        const consumeRes = await this.channel.consume(
            this.opts.queue,
            (msg) => {
                if (!msg) return;
                void this.dispatch(msg);
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

    private async dispatch(msg: ConsumeMessage): Promise<void> {
        try {
            await this.handleMessage(msg.content);
            this.channel?.ack(msg);
        } catch (err) {
            // Poison errors never requeue — re-delivering an unparseable or
            // unrouteable message just spins the same failure forever and
            // burns broker + log + metrics quota.
            const poison =
                err instanceof MalformedEnvelopeError ||
                err instanceof ConsumerVersionMismatchError;
            const requeue = poison ? false : !this.opts.dlq;
            const fate = poison ? 'drop' : this.opts.dlq ? 'DLQ' : 'requeue';
            this.opts.logger.error(
                `[EventConsumer:${this.opts.consumerName}] handler error → ${fate}`,
                err instanceof Error ? err : undefined,
            );
            this.channel?.nack(msg, false, requeue);
        }
    }

    private async handleMessage(buffer: Buffer): Promise<void> {
        let envelope: EventEnvelope;
        try {
            const raw = JSON.parse(buffer.toString('utf8')) as unknown;
            envelope = EventEnvelopeSchema.parse(raw);
        } catch (err) {
            // Use a typed error so `dispatch` can route this branch to a
            // bounded `reason_class` and to the never-requeue path.
            throw new MalformedEnvelopeError(
                err instanceof Error ? err.message : String(err),
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
        const key = eventKey(envelope.eventType, envelope.eventVersion);
        const handler = this.handlerMap.get(key);
        if (!handler) {
            throw new ConsumerVersionMismatchError(key);
        }

        const payload = handler.payloadSchema.parse(envelope.payload);

        const client = await this.opts.pool.connect();
        let clientPoisoned = false;
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
            } catch (rollbackErr) {
                // Mid-transaction connection loss can cause both the original
                // op and the ROLLBACK to fail. The pool client is now in an
                // unknown state and must NOT be recycled — release(err)
                // tells node-postgres to destroy it.
                clientPoisoned = true;
                this.opts.logger.error(
                    `[EventConsumer:${this.opts.consumerName}] ROLLBACK failed; destroying client`,
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
}

export class MalformedEnvelopeError extends Error {
    constructor(detail: string) {
        super(`Malformed envelope: ${detail}`);
        this.name = 'MalformedEnvelopeError';
    }
}

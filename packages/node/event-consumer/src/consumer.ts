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

/** Structural activity gate (blue/green idle colour). Inactive => consumer pauses. */
export type ActivityGate = {
    isActive(): boolean;
    on(event: 'change', cb: (active: boolean, value: string | undefined) => void): unknown;
};

export interface ConsumerStatus {
    queue: string;
    /** `paused` is a healthy state (gated inactive); never fail readiness on it. */
    state: 'active' | 'paused';
    inFlight: number;
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
    /**
     * Optional activity gate. Topology (queue, DLQ, bindings) is always
     * asserted; `basic.consume` only runs while the gate is active. A 'change'
     * event pauses (cancel consumer, drain in-flight) or resumes consumption.
     */
    gate?: ActivityGate;
    /** Max wait for in-flight handlers to settle during pause(). Default 30_000. */
    pauseDrainTimeoutMs?: number;
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
    private stopped = true;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private reconnectAttempts = 0;
    private paused = false;
    private setupInFlight = false;
    private gateWired = false;
    private readonly inFlight = new Set<Promise<void>>();
    private transition: Promise<void> = Promise.resolve();

    constructor(private readonly opts: EventConsumerOpts) {
        this.handlerMap = buildHandlerMap(opts.handlers);
    }

    async start(): Promise<void> {
        this.stopped = false;
        if (this.opts.gate) {
            this.paused = !this.opts.gate.isActive();
            this.wireGate(this.opts.gate);
        }
        try {
            await this.setupChannel();
        } catch (err) {
            // A transient broker failure at boot must not leave the consumer
            // permanently silent: callers in this fleet often log-and-continue
            // on startup errors (the durable queue buffers meanwhile), and
            // without this the backoff loop would only ever start from a
            // channel 'close'. Callers treating the rejection as fatal exit
            // anyway, making the scheduled retry moot.
            this.scheduleReconnect();
            throw err;
        }
        if (!this.stopped) {
            this.opts.logger.info(
                `[EventConsumer:${this.opts.consumerName}] started (queue=${this.opts.queue}${this.paused ? ', paused' : ''})`,
            );
        }
    }

    getStatus(): ConsumerStatus {
        return {
            queue: this.opts.queue,
            state: this.paused ? 'paused' : 'active',
            inFlight: this.inFlight.size,
        };
    }

    /**
     * Stop consuming (basic.cancel) but keep the channel, prefetch and
     * topology, then wait for in-flight handlers to settle (bounded by
     * `pauseDrainTimeoutMs`). Unacked deliveries stay on the channel and ack
     * normally; deliveries racing the cancel are dispatched, not dropped.
     */
    pause(): Promise<void> {
        this.paused = true;
        return this.serialize(() => this.applyState());
    }

    /** Re-subscribe after pause(). Routes through reconnect if the channel is gone. */
    resume(): Promise<void> {
        this.paused = false;
        return this.serialize(() => this.applyState());
    }

    private wireGate(gate: ActivityGate): void {
        if (this.gateWired) return;
        this.gateWired = true;
        gate.on('change', (active) => {
            const op = active ? this.resume() : this.pause();
            op.catch((err: unknown) => {
                this.opts.logger.warn(
                    `[EventConsumer:${this.opts.consumerName}] gate ${active ? 'resume' : 'pause'} failed: ${err instanceof Error ? err.message : String(err)}`,
                );
            });
        });
    }

    private serialize(fn: () => Promise<void>): Promise<void> {
        const run = this.transition.then(fn, fn);
        this.transition = run.catch(() => {});
        return run;
    }

    /** Reconciles the broker subscription with the *current* `paused` flag. */
    private async applyState(): Promise<void> {
        if (this.stopped) return;
        if (this.paused) {
            await this.cancelConsumer();
            if (this.paused) await this.drainInFlight();
            return;
        }
        const channel = this.channel;
        if (!channel) {
            // Channel gone (or mid-setup, whose tail reconciles): setupChannel
            // consumes once it runs.
            if (!this.setupInFlight) this.scheduleReconnect();
            return;
        }
        if (this.consumerTag) return;
        try {
            this.consumerTag = await this.consumeOn(channel);
        } catch (err) {
            this.opts.logger.warn(
                `[EventConsumer:${this.opts.consumerName}] resume consume failed; re-establishing channel: ${err instanceof Error ? err.message : String(err)}`,
            );
            this.dropChannel(channel);
            this.scheduleReconnect();
            return;
        }
        // Paused again while the consume was in flight.
        if (this.paused) await this.cancelConsumer();
    }

    private async cancelConsumer(): Promise<void> {
        const channel = this.channel;
        const tag = this.consumerTag;
        if (!channel || !tag) return;
        // Cleared first so the consume callback's null-message branch can tell
        // our own cancel from a broker-initiated one.
        this.consumerTag = null;
        try {
            await channel.cancel(tag);
        } catch (err) {
            this.opts.logger.warn(
                `[EventConsumer:${this.opts.consumerName}] cancel failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    private async drainInFlight(): Promise<void> {
        if (this.inFlight.size === 0) return;
        const timeoutMs = this.opts.pauseDrainTimeoutMs ?? 30_000;
        let timer: NodeJS.Timeout | undefined;
        const timedOut = await Promise.race([
            Promise.allSettled([...this.inFlight]).then(() => false),
            new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(true), timeoutMs);
            }),
        ]);
        clearTimeout(timer);
        if (timedOut) {
            this.opts.logger.warn(
                `[EventConsumer:${this.opts.consumerName}] pause drain timed out after ${timeoutMs}ms with ${this.inFlight.size} handler(s) in flight`,
            );
        }
    }

    private dropChannel(channel: Channel): void {
        if (this.channel === channel) {
            this.channel = null;
            this.consumerTag = null;
        }
        void Promise.resolve()
            .then(() => channel.close())
            .catch(() => {});
    }

    private async consumeOn(channel: Channel): Promise<string> {
        const res = await channel.consume(
            this.opts.queue,
            (msg) => {
                if (!msg) {
                    // Broker-initiated consumer cancel (queue deleted, HA
                    // failover) — amqplib signals it with a null message.
                    // The channel stays open, so no 'close' fires; recover
                    // explicitly or the consumer stalls silently. Ignored
                    // while paused / mid-cancel: nothing is subscribed then,
                    // and resume() re-subscribes (or reconnects) itself.
                    if (
                        this.channel === channel &&
                        !this.stopped &&
                        !this.paused &&
                        this.consumerTag !== null
                    ) {
                        this.channel = null;
                        this.consumerTag = null;
                        this.opts.logger.warn(
                            `[EventConsumer:${this.opts.consumerName}] consumer cancelled by broker; scheduling re-subscribe`,
                        );
                        void Promise.resolve()
                            .then(() => channel.close())
                            .catch(() => {});
                        this.scheduleReconnect();
                    }
                    return;
                }
                // Bind dispatch to THIS channel: delivery tags are
                // channel-scoped, so a message must never be acked/nacked on
                // a replacement channel.
                this.track(this.dispatch(channel, msg));
            },
            { noAck: false },
        );
        return res.consumerTag;
    }

    private track(p: Promise<void>): void {
        this.inFlight.add(p);
        const done = (): void => {
            this.inFlight.delete(p);
        };
        p.then(done, done);
    }

    /**
     * Open a channel, declare the topology, and begin consuming. Runs once
     * from start() and again from the reconnect path whenever the channel
     * dies: the ConnectionManager auto-reconnects the *connection* after a
     * socket drop, but channels are not resurrected with it — without the
     * re-subscribe, a consumer that lost its channel would silently stop
     * consuming while messages pile up in the queue.
     */
    private async setupChannel(): Promise<void> {
        this.setupInFlight = true;
        try {
            await this.doSetupChannel();
        } finally {
            this.setupInFlight = false;
        }
    }

    private async doSetupChannel(): Promise<void> {
        // Covers the case where the manager's own post-'close' reconnect
        // exhausted its retries — nothing else would retry the connection.
        // Older soa-rabbitmq versions predate ensureConnected(); the consumer
        // then falls through to newChannel(), which fails descriptively on a
        // dead connection and is retried by the backoff loop.
        if (typeof this.opts.connectionManager.ensureConnected === 'function') {
            await this.opts.connectionManager.ensureConnected();
        }
        const channel = await this.opts.connectionManager.newChannel();
        // 'error' must have a listener (an unhandled EventEmitter 'error'
        // crashes the process); the terminal signal is the 'close' that
        // follows, which schedules the re-subscribe.
        channel.on('error', (err: Error) => {
            this.opts.logger.warn(
                `[EventConsumer:${this.opts.consumerName}] channel error: ${err.message}`,
            );
        });
        let closed = false;
        channel.on('close', () => {
            closed = true;
            if (this.channel === channel) {
                this.channel = null;
                this.consumerTag = null;
                if (!this.stopped) {
                    this.opts.logger.warn(
                        `[EventConsumer:${this.opts.consumerName}] channel lost; scheduling re-subscribe`,
                    );
                    this.scheduleReconnect();
                }
            }
        });

        await channel.prefetch(this.opts.prefetch ?? 10);

        // Wire DLQ first if configured — must be declared before the main queue
        // so the main queue's x-dead-letter-exchange resolves.
        if (this.opts.dlq) {
            await channel.assertExchange(this.opts.dlq.exchange, 'topic', {
                durable: true,
            });
            await channel.assertQueue(this.opts.dlq.queue, { durable: true });
            await channel.bindQueue(
                this.opts.dlq.queue,
                this.opts.dlq.exchange,
                '#',
            );
        }

        await channel.assertQueue(this.opts.queue, {
            durable: true,
            ...(this.opts.dlq
                ? { arguments: { 'x-dead-letter-exchange': this.opts.dlq.exchange } }
                : {}),
        });

        for (const binding of this.opts.bindings) {
            await channel.assertExchange(binding.exchange, 'topic', {
                durable: true,
            });
            await channel.bindQueue(
                this.opts.queue,
                binding.exchange,
                binding.routingKey,
            );
        }

        const consumerTag = this.paused ? null : await this.consumeOn(channel);

        this.channel = channel;
        this.consumerTag = consumerTag;
        // Setup can race a channel death ('close' fired before the
        // assignments above, so the listener's identity guard missed it) or
        // a concurrent stop(). Either way this channel must not stay live.
        if (closed || this.stopped) {
            this.channel = null;
            this.consumerTag = null;
            void Promise.resolve()
                .then(() => channel.close())
                .catch(() => {});
            if (closed && !this.stopped) {
                throw new Error('channel closed during setup');
            }
        }
        // pause()/resume() landed while setup was in flight and saw no channel.
        if (this.channel === channel && this.paused === (this.consumerTag !== null)) {
            void this.serialize(() => this.applyState());
        }
    }

    /**
     * Exponential backoff (1s → 30s cap) around setupChannel(). Retries
     * forever until it succeeds or stop() is called — the queue and its
     * bindings are durable, so messages accumulate safely while the broker
     * is unreachable.
     */
    private scheduleReconnect(): void {
        if (this.stopped || this.reconnectTimer) return;
        const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempts);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.stopped) return;
            void this.setupChannel().then(
                () => {
                    this.reconnectAttempts = 0;
                    this.opts.logger.info(
                        `[EventConsumer:${this.opts.consumerName}] re-subscribed (queue=${this.opts.queue})`,
                    );
                },
                (err: unknown) => {
                    this.reconnectAttempts++;
                    this.opts.logger.warn(
                        `[EventConsumer:${this.opts.consumerName}] re-subscribe failed (attempt ${this.reconnectAttempts}): ${err instanceof Error ? err.message : String(err)}`,
                    );
                    this.scheduleReconnect();
                },
            );
        }, delay);
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
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

    /**
     * Direct-dispatch entry point — bypasses the broker. Used by test
     * helpers (e.g. MockPublisher patterns in downstream consumers) and
     * ad-hoc seed scripts. Goes through the same consumed_events idempotency
     * check + tx-wrapped handler invocation as the broker path, so test
     * coverage on idempotency / tx atomicity is real and not a separate
     * code path.
     *
     * Does NOT extract OTel context from envelope.meta — the broker path
     * does that in handleMessage(). Tests exercising tracing should go
     * through the broker path; tests exercising handler logic should use
     * this.
     */
    async dispatchEnvelope(envelope: EventEnvelope): Promise<void> {
        await this.processEnvelope(envelope);
    }

    private async dispatch(channel: Channel, msg: ConsumeMessage): Promise<void> {
        try {
            await this.handleMessage(msg.content);
            this.settle(() => channel.ack(msg));
        } catch (err) {
            // Poison errors never requeue — re-delivering an unparseable or
            // unrouteable message just spins the same failure forever and
            // burns broker + log + metrics quota.
            const poison =
                err instanceof MalformedEnvelopeError ||
                err instanceof ConsumerVersionMismatchError;
            const requeue = poison ? false : !this.opts.dlq;
            // A nack with requeue=false lands in the DLQ whenever one is
            // configured — poison included. Only an unrouteable nack drops.
            const fate = this.opts.dlq ? 'DLQ' : poison ? 'drop' : 'requeue';
            this.opts.logger.error(
                `[EventConsumer:${this.opts.consumerName}] handler error → ${fate}`,
                err instanceof Error ? err : undefined,
            );
            this.settle(() => channel.nack(msg, false, requeue));
        }
    }

    /**
     * Ack/nack can race a channel death (handler ran while the socket
     * dropped). Settling on a dead channel throws IllegalOperationError; the
     * broker will redeliver the unsettled message on the replacement channel
     * and the consumed_events idempotency check absorbs the duplicate, so
     * the right move is to log and move on rather than crash the dispatch.
     */
    private settle(op: () => void): void {
        try {
            op();
        } catch (err) {
            const detail = `[EventConsumer:${this.opts.consumerName}] ack/nack failed on dead channel (broker will redeliver): ${err instanceof Error ? err.message : String(err)}`;
            // Routine during graceful shutdown (stop() closes the channel
            // while a handler is in flight) — only unexpected while running.
            if (this.stopped) {
                this.opts.logger.debug(detail);
            } else {
                this.opts.logger.warn(detail);
            }
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

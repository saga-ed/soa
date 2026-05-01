import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import {
    Counter,
    Gauge,
    Registry,
    collectDefaultMetrics,
} from 'prom-client';
import type { ILogger } from '@saga-ed/soa-logger';
import type { ConsumerMetrics } from '@saga-ed/soa-event-consumer';
import type { OutboxMetrics } from '@saga-ed/soa-event-outbox';

export type { ConsumerMetrics, OutboxMetrics };

export interface Observability {
    /** prom-client registry served at GET /metrics. */
    registry: Registry;
    /**
     * Wire the logger used for gauge-collect failures and metrics-route
     * errors. Without this, gauge SQL failures are silent (a stale value
     * masks DB outages); after binding, failures surface via the logger
     * AND `gauge_collect_failures_total`.
     */
    bindLogger: (logger: ILogger) => void;
    /**
     * Register publisher counters + the outbox lag gauge. The pool feeds
     * the gauge's `collect()` callback. Returns the metrics callbacks
     * to hand to OutboxRelay opts.
     *
     * Call once per service. Calling on a consumer-only service is a
     * design error and intentionally not modeled — services that don't
     * publish simply don't call this.
     */
    addOutbox: (pool: Pool) => OutboxMetrics;
    /**
     * Register consumer counters + the consumed-events gauge. Symmetrical
     * to `addOutbox`. Returns the metrics callbacks to hand to
     * EventConsumer opts.
     */
    addConsumer: (pool: Pool, consumerName: string) => ConsumerMetrics;
}

/**
 * Build a service's Prometheus registry. Counters and gauges are added
 * lazily via `addOutbox` / `addConsumer` once the pg pool is connected
 * — that ordering is forced by the pool needing to exist for gauge
 * `collect()` callbacks.
 *
 * Compared to a flag-driven `{ hasOutbox, hasConsumer }` API, this shape
 * makes "this service has no outbox" explicit at the call site (you
 * simply don't call `addOutbox`) instead of returning no-op callbacks
 * that silently do nothing.
 */
export function createObservability(serviceName: string): Observability {
    const registry = new Registry();
    const prefix = `${serviceName.replace(/-/g, '_')}_`;
    collectDefaultMetrics({ register: registry, prefix });

    const gaugeFailures = new Counter({
        name: 'gauge_collect_failures_total',
        help: 'Times a metrics-gauge collect() callback threw — DB outage, role drift, or missing migration. Stale gauge values would otherwise hide these.',
        labelNames: ['gauge'] as const,
        registers: [registry],
    });

    let logger: ILogger | null = null;
    const reportGaugeFailure = (gauge: string, err: unknown): void => {
        gaugeFailures.inc({ gauge });
        logger?.warn(
            `[observability] ${gauge} collect() failed: ${err instanceof Error ? err.message : String(err)}`,
        );
    };

    return {
        registry,
        bindLogger: (l) => {
            logger = l;
        },
        addOutbox: (pool) => createOutboxMetrics(registry, pool, reportGaugeFailure),
        addConsumer: (pool, consumerName) =>
            createConsumerMetrics(registry, pool, consumerName, reportGaugeFailure),
    };
}

type ReportGaugeFailure = (gauge: string, err: unknown) => void;

function createOutboxMetrics(
    registry: Registry,
    pool: Pool,
    reportFailure: ReportGaugeFailure,
): OutboxMetrics {
    const eventsPublishedTotal = new Counter({
        name: 'events_published_total',
        help: 'Outbox rows published to broker since process start.',
        labelNames: ['event_type', 'event_version'] as const,
        registers: [registry],
    });

    const eventsPublishFailedTotal = new Counter({
        name: 'events_publish_failed_total',
        help: 'Outbox publish attempts that threw before persisting.',
        labelNames: ['event_type', 'event_version', 'reason'] as const,
        registers: [registry],
    });

    new Gauge({
        name: 'outbox_unpublished_count',
        help: 'Outbox rows where published_at IS NULL. Lag indicator.',
        registers: [registry],
        async collect() {
            try {
                const result = await pool.query<{ c: string }>(
                    `SELECT count(*)::text AS c FROM outbox_event WHERE published_at IS NULL`,
                );
                this.set(Number(result.rows[0]?.c ?? '0'));
            } catch (err) {
                reportFailure('outbox_unpublished_count', err);
            }
        },
    });

    return {
        onPublished: (eventType, eventVersion) => {
            eventsPublishedTotal.inc({
                event_type: eventType,
                event_version: String(eventVersion),
            });
        },
        onPublishFailed: (eventType, eventVersion, reason) => {
            eventsPublishFailedTotal.inc({
                event_type: eventType,
                event_version: String(eventVersion),
                reason: reason.slice(0, 120),
            });
        },
    };
}

function createConsumerMetrics(
    registry: Registry,
    pool: Pool,
    consumerName: string,
    reportFailure: ReportGaugeFailure,
): ConsumerMetrics {
    const eventsProcessedTotal = new Counter({
        name: 'events_processed_total',
        help: 'Events successfully consumed and projected since process start.',
        labelNames: ['event_type', 'event_version'] as const,
        registers: [registry],
    });

    const eventsFailedTotal = new Counter({
        name: 'events_failed_total',
        help: 'Events that threw during consumption (routed to DLQ via fail-fast).',
        labelNames: ['event_type', 'event_version', 'reason'] as const,
        registers: [registry],
    });

    const eventsDuplicateTotal = new Counter({
        name: 'events_duplicate_total',
        help: 'Events skipped as already-processed (idempotency hit).',
        labelNames: ['event_type', 'event_version'] as const,
        registers: [registry],
    });

    new Gauge({
        name: 'consumed_events_count',
        help: 'Total rows in consumed_events. Useful as a sanity counter.',
        registers: [registry],
        async collect() {
            try {
                const result = await pool.query<{ c: string }>(
                    `SELECT count(*)::text AS c FROM consumed_events WHERE consumer_name = $1`,
                    [consumerName],
                );
                this.set(Number(result.rows[0]?.c ?? '0'));
            } catch (err) {
                reportFailure('consumed_events_count', err);
            }
        },
    });

    return {
        onProcessed: (eventType, eventVersion) => {
            eventsProcessedTotal.inc({
                event_type: eventType,
                event_version: String(eventVersion),
            });
        },
        onFailed: (eventType, eventVersion, reason) => {
            eventsFailedTotal.inc({
                event_type: eventType,
                event_version: String(eventVersion),
                reason: reason.slice(0, 120),
            });
        },
        onDuplicate: (eventType, eventVersion) => {
            eventsDuplicateTotal.inc({
                event_type: eventType,
                event_version: String(eventVersion),
            });
        },
    };
}

/** Express handler that serves the Prometheus text exposition format. */
export function metricsRoute(registry: Registry, logger?: ILogger): RequestHandler {
    return async (_req, res, next) => {
        try {
            res.set('Content-Type', registry.contentType);
            res.send(await registry.metrics());
        } catch (err) {
            // Without a logger, this would surface only via Express's default
            // finalhandler (raw stderr), bypassing the structured Pino pipeline.
            logger?.error(
                'metrics endpoint failed to serialize registry',
                err instanceof Error ? err : new Error(String(err)),
            );
            next(err);
        }
    };
}

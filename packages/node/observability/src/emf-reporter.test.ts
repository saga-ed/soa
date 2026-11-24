import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Counter, Gauge, Registry } from 'prom-client';
import type { ILogger } from '@saga-ed/soa-logger';
import { EMF_NAMESPACE, startEmfReporter } from './emf-reporter.js';

type Line = Record<string, any>;

function fakeLogger() {
    const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    };
    const lines = (): Line[] => logger.info.mock.calls.map((c) => c[1] as Line);
    return { logger: logger as unknown as ILogger & typeof logger, lines };
}

function outboxRegistry() {
    const registry = new Registry();
    const published = new Counter({
        name: 'events_published_total',
        help: 'x',
        labelNames: ['event_type', 'event_version'] as const,
        registers: [registry],
    });
    const failed = new Counter({
        name: 'events_publish_failed_total',
        help: 'x',
        labelNames: ['event_type', 'event_version', 'reason_class'] as const,
        registers: [registry],
    });
    const collect = vi.fn(function (this: Gauge) {
        this.set(7);
    });
    new Gauge({
        name: 'outbox_unpublished_count',
        help: 'x',
        registers: [registry],
        collect,
    });
    return { registry, published, failed, collect };
}

const opts = { service: 'iam-api', environment: 'dev' };

describe('startEmfReporter', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('emits _aws at the root with namespace, dimensions and root properties', async () => {
        const { registry, published } = outboxRegistry();
        const { logger, lines } = fakeLogger();
        startEmfReporter(registry, { ...opts, logger });
        published.inc({ event_type: 'a', event_version: '1' });
        await vi.advanceTimersByTimeAsync(60_000);
        const line = lines()[0]!;
        expect(logger.info.mock.calls[0]![0]).toBe('[observability] emf metrics');
        expect(line._aws.CloudWatchMetrics[0].Namespace).toBe(EMF_NAMESPACE);
        expect(line._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Environment', 'Service']]);
        expect(line._aws.CloudWatchMetrics[0].Metrics).toContainEqual({
            Name: 'EventsPublished',
            Unit: 'Count',
        });
        expect(line.Environment).toBe('dev');
        expect(line.Service).toBe('iam-api');
        expect(line.EventsPublished).toBe(1);
    });

    it('emits per-interval deltas against a baseline captured at start', async () => {
        const { registry, published } = outboxRegistry();
        published.inc({ event_type: 'a', event_version: '1' }, 10);
        const { logger, lines } = fakeLogger();
        startEmfReporter(registry, { ...opts, logger });
        await vi.advanceTimersByTimeAsync(0);
        published.inc({ event_type: 'a', event_version: '1' }, 3);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(lines()[0]!.EventsPublished).toBe(3);
        published.inc({ event_type: 'a', event_version: '1' }, 2);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(lines()[1]!.EventsPublished).toBe(2);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(lines()[2]!.EventsPublished).toBe(0);
    });

    it('sums label sets and breaks down by event type, omitting zeros', async () => {
        const { registry, published, failed } = outboxRegistry();
        const { logger, lines } = fakeLogger();
        startEmfReporter(registry, { ...opts, logger });
        await vi.advanceTimersByTimeAsync(0);
        published.inc({ event_type: 'iam.user.created', event_version: '1' }, 3);
        published.inc({ event_type: 'iam.user.updated', event_version: '2' }, 4);
        failed.inc({ event_type: 'iam.user.created', event_version: '1', reason_class: 'timeout' });
        failed.inc({ event_type: 'iam.user.created', event_version: '1', reason_class: 'other' });
        await vi.advanceTimersByTimeAsync(60_000);
        const line = lines()[0]!;
        expect(line.EventsPublished).toBe(7);
        expect(line.EventsPublishFailed).toBe(2);
        expect(line.breakdown).toEqual({
            EventsPublished: { 'iam.user.created@1': 3, 'iam.user.updated@2': 4 },
            EventsPublishFailed: { 'iam.user.created@1': 2 },
        });
    });

    it('does not run gauge collect on the counter tick, only on the gauge tick', async () => {
        const { registry, collect } = outboxRegistry();
        const { logger, lines } = fakeLogger();
        startEmfReporter(registry, { ...opts, logger });
        await vi.advanceTimersByTimeAsync(240_000);
        expect(collect).not.toHaveBeenCalled();
        expect(lines().length).toBe(4);
        expect(lines().every((l) => l.OutboxUnpublishedCount === undefined)).toBe(true);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(collect).toHaveBeenCalledTimes(1);
        const gaugeLine = lines().find((l) => l.OutboxUnpublishedCount !== undefined)!;
        expect(gaugeLine.OutboxUnpublishedCount).toBe(7);
        expect(gaugeLine._aws.CloudWatchMetrics[0].Metrics).toEqual([
            { Name: 'OutboxUnpublishedCount', Unit: 'None' },
        ]);
    });

    it('emits ConsumedEventsCount only when opted in', async () => {
        for (const include of [false, true]) {
            const registry = new Registry();
            new Gauge({
                name: 'consumed_events_count',
                help: 'x',
                registers: [registry],
                collect() {
                    this.set(5);
                },
            });
            const { logger, lines } = fakeLogger();
            const r = startEmfReporter(registry, {
                ...opts,
                logger,
                includeConsumedEventsCount: include,
            });
            await vi.advanceTimersByTimeAsync(300_000);
            await r.stop();
            const hit = lines().some((l) => l.ConsumedEventsCount === 5);
            expect(hit).toBe(include);
        }
    });

    it('skips unregistered metrics and emits nothing for an empty registry', async () => {
        const empty = fakeLogger();
        startEmfReporter(new Registry(), { ...opts, logger: empty.logger });
        await vi.advanceTimersByTimeAsync(300_000);
        expect(empty.logger.info).not.toHaveBeenCalled();

        const { registry } = outboxRegistry();
        const { logger, lines } = fakeLogger();
        startEmfReporter(registry, { ...opts, logger });
        await vi.advanceTimersByTimeAsync(60_000);
        const names = lines()[0]!._aws.CloudWatchMetrics[0].Metrics.map((m: any) => m.Name);
        expect(names).toEqual(['EventsPublished', 'EventsPublishFailed']);
    });

    it('stop() flushes counters once and clears timers', async () => {
        const { registry, published } = outboxRegistry();
        const { logger, lines } = fakeLogger();
        const r = startEmfReporter(registry, { ...opts, logger });
        await vi.advanceTimersByTimeAsync(0);
        published.inc({ event_type: 'a', event_version: '1' }, 4);
        await r.stop();
        expect(lines().length).toBe(1);
        expect(lines()[0]!.EventsPublished).toBe(4);
        await vi.advanceTimersByTimeAsync(600_000);
        expect(lines().length).toBe(1);
    });

    it('a failing tick warns and never throws; later ticks still run', async () => {
        const { registry, published } = outboxRegistry();
        const { logger, lines } = fakeLogger();
        startEmfReporter(registry, { ...opts, logger });
        await vi.advanceTimersByTimeAsync(0);
        const metric = registry.getSingleMetric('events_published_total')!;
        const spy = vi.spyOn(metric, 'get').mockRejectedValueOnce(new Error('boom'));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(String(logger.warn.mock.calls[0]![0])).toContain('boom');
        spy.mockRestore();
        published.inc({ event_type: 'a', event_version: '1' });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(lines().at(-1)!.EventsPublished).toBe(1);
    });

    it('stop() never throws even when the logger throws', async () => {
        const { registry } = outboxRegistry();
        const { logger } = fakeLogger();
        logger.info.mockImplementation(() => {
            throw new Error('logger down');
        });
        const r = startEmfReporter(registry, { ...opts, logger });
        await expect(r.stop()).resolves.toBeUndefined();
    });
});

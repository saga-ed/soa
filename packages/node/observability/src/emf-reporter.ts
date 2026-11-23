import type { Registry } from 'prom-client';
import type { ILogger } from '@saga-ed/soa-logger';

export const EMF_NAMESPACE = 'SagaSoa/Events';

export interface EmfReporterOptions {
    /** Service dimension, e.g. 'iam-api'. */
    service: string;
    /** Telemetry env 'dev' | 'prod'. Caller's job; never NODE_ENV or a preview tag. */
    environment: string;
    logger: ILogger;
    /** Default 60_000. */
    counterIntervalMs?: number;
    /** Default 300_000. */
    gaugeIntervalMs?: number;
    /** Default false. */
    includeConsumedEventsCount?: boolean;
}

export interface EmfReporter {
    /** Clears timers and flushes counters once. Never throws. */
    stop(): Promise<void>;
}

const COUNTERS: ReadonlyArray<readonly [string, string]> = [
    ['events_published_total', 'EventsPublished'],
    ['events_publish_failed_total', 'EventsPublishFailed'],
    ['events_processed_total', 'EventsProcessed'],
    ['events_failed_total', 'EventsFailed'],
    ['events_duplicate_total', 'EventsDuplicate'],
    ['gauge_collect_failures_total', 'GaugeCollectFailures'],
];

const OUTBOX_GAUGE = ['outbox_unpublished_count', 'OutboxUnpublishedCount'] as const;
const CONSUMED_GAUGE = ['consumed_events_count', 'ConsumedEventsCount'] as const;

const DEFAULT_COUNTER_INTERVAL_MS = 60_000;
const DEFAULT_GAUGE_INTERVAL_MS = 300_000;
const LOG_MESSAGE = '[observability] emf metrics';

type Sample = { value: number; labels: Record<string, unknown> };
type Series = Map<string, number>;
type Unit = 'Count' | 'None';

function breakdownKey(labels: Record<string, unknown>): string | undefined {
    if (labels.event_type !== undefined) {
        return labels.event_version !== undefined
            ? `${String(labels.event_type)}@${String(labels.event_version)}`
            : String(labels.event_type);
    }
    if (labels.gauge !== undefined) return String(labels.gauge);
    return undefined;
}

function seriesKey(labels: Record<string, unknown>): string {
    return JSON.stringify(
        Object.keys(labels)
            .sort()
            .map((k) => [k, String(labels[k])]),
    );
}

/**
 * Emit the registry's domain metrics as CloudWatch EMF log lines on an interval.
 *
 * Counters are read per-metric via `getSingleMetric(name).get()`; never
 * `registry.metrics()` / `getMetricsAsJSON()`, which would run every gauge's
 * `count(*)` collect() on the counter tick.
 */
export function startEmfReporter(registry: Registry, opts: EmfReporterOptions): EmfReporter {
    const { logger } = opts;
    const counterIntervalMs = opts.counterIntervalMs ?? DEFAULT_COUNTER_INTERVAL_MS;
    const gaugeIntervalMs = opts.gaugeIntervalMs ?? DEFAULT_GAUGE_INTERVAL_MS;
    const gauges = opts.includeConsumedEventsCount
        ? [OUTBOX_GAUGE, CONSUMED_GAUGE]
        : [OUTBOX_GAUGE];

    const previous = new Map<string, Series>();
    let counterRunning: Promise<void> | undefined;
    let gaugeRunning: Promise<void> | undefined;
    let stopped = false;

    const read = async (promName: string): Promise<Sample[] | undefined> => {
        const metric = registry.getSingleMetric(promName);
        if (!metric) return undefined;
        const { values } = await metric.get();
        return values.map((v) => ({ value: v.value, labels: { ...v.labels } }));
    };

    const emit = (
        metrics: Array<{ name: string; unit: Unit; value: number }>,
        breakdown?: Record<string, Record<string, number>>,
    ): void => {
        const values: Record<string, number> = {};
        for (const m of metrics) values[m.name] = m.value;
        // `_aws` must sit at the JSON root (logger spreads `data` there) or CloudWatch mints nothing.
        logger.info(LOG_MESSAGE, {
            ...(breakdown && Object.keys(breakdown).length > 0 ? { breakdown } : {}),
            _aws: {
                Timestamp: Date.now(),
                CloudWatchMetrics: [
                    {
                        Namespace: EMF_NAMESPACE,
                        Dimensions: [['Environment', 'Service']],
                        Metrics: metrics.map((m) => ({ Name: m.name, Unit: m.unit })),
                    },
                ],
            },
            Environment: opts.environment,
            Service: opts.service,
            ...values,
        });
    };

    // Reads every counter; returns the per-label-set samples that exist.
    const snapshotCounters = async (): Promise<Map<string, Sample[]>> => {
        // Parallel so every get() runs synchronously at call time, before the baseline can drift.
        const all = await Promise.all(COUNTERS.map(([promName]) => read(promName)));
        const out = new Map<string, Sample[]>();
        COUNTERS.forEach(([promName], i) => {
            const samples = all[i];
            if (samples) out.set(promName, samples);
        });
        return out;
    };

    const remember = (snap: Map<string, Sample[]>): void => {
        for (const [promName, samples] of snap) {
            const series: Series = new Map();
            for (const s of samples) series.set(seriesKey(s.labels), s.value);
            previous.set(promName, series);
        }
    };

    const counterTick = async (): Promise<void> => {
        const snap = await snapshotCounters();
        const metrics: Array<{ name: string; unit: Unit; value: number }> = [];
        const breakdown: Record<string, Record<string, number>> = {};
        for (const [promName, emfName] of COUNTERS) {
            const samples = snap.get(promName);
            if (!samples) continue;
            const prev = previous.get(promName);
            let total = 0;
            for (const s of samples) {
                const key = seriesKey(s.labels);
                const delta = Math.max(0, s.value - (prev?.get(key) ?? 0));
                total += delta;
                const bk = breakdownKey(s.labels);
                if (delta > 0 && bk !== undefined) {
                    breakdown[emfName] ??= {};
                    breakdown[emfName][bk] = (breakdown[emfName][bk] ?? 0) + delta;
                }
            }
            metrics.push({ name: emfName, unit: 'Count', value: total });
        }
        remember(snap);
        if (metrics.length > 0) emit(metrics, breakdown);
    };

    const gaugeTick = async (): Promise<void> => {
        const metrics: Array<{ name: string; unit: Unit; value: number }> = [];
        for (const [promName, emfName] of gauges) {
            const samples = await read(promName);
            if (!samples || samples.length === 0) continue;
            metrics.push({
                name: emfName,
                unit: 'None',
                value: samples.reduce((sum, s) => sum + s.value, 0),
            });
        }
        if (metrics.length > 0) emit(metrics);
    };

    const guarded = (
        name: string,
        fn: () => Promise<void>,
        current: () => Promise<void> | undefined,
        set: (p: Promise<void> | undefined) => void,
    ): void => {
        if (current()) return;
        const p = fn()
            .catch((err: unknown) => {
                try {
                    logger.warn(
                        `[observability] emf ${name} tick failed: ${err instanceof Error ? err.message : String(err)}`,
                    );
                } catch {
                    // logger failure must never escape a timer callback
                }
            })
            .finally(() => set(undefined));
        set(p);
    };

    const runCounter = (): void =>
        guarded('counter', counterTick, () => counterRunning, (p) => (counterRunning = p));
    const runGauge = (): void =>
        guarded('gauge', gaugeTick, () => gaugeRunning, (p) => (gaugeRunning = p));

    // Baseline: the first emitted delta is relative to values at start, not process boot.
    const baseline: Promise<void> = snapshotCounters().then(remember, (err: unknown) => {
        try {
            logger.warn(
                `[observability] emf baseline failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        } catch {
            // ignore
        }
    });
    const afterBaseline = (fn: () => void) => () => {
        if (!stopped) void baseline.then(fn);
    };

    const counterTimer = setInterval(afterBaseline(runCounter), counterIntervalMs);
    const gaugeTimer = setInterval(afterBaseline(runGauge), gaugeIntervalMs);
    counterTimer.unref();
    gaugeTimer.unref();

    return {
        async stop(): Promise<void> {
            if (stopped) return;
            stopped = true;
            clearInterval(counterTimer);
            clearInterval(gaugeTimer);
            try {
                await baseline;
                await Promise.all([counterRunning, gaugeRunning]);
                runCounter();
                await counterRunning;
            } catch (err) {
                try {
                    logger.warn(
                        `[observability] emf stop failed: ${err instanceof Error ? err.message : String(err)}`,
                    );
                } catch {
                    // ignore
                }
            }
        },
    };
}

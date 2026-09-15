import type { Pool } from 'pg';
import type { ILogger } from '@saga-ed/soa-logger';

/**
 * OutboxRetention — periodic sweep of published outbox_event rows into
 * outbox_event_archive (see OUTBOX_EVENT_ARCHIVE_SQL in schema.ts).
 *
 * outbox_event has no retention today — published rows sit forever, growing
 * the table (and the poll query's OFFSET-free but still-live index) without
 * bound. Rows move rather than get deleted so a bad sweep or an unexpected
 * downstream gap can be replayed; see the package README's replay recipe.
 *
 * Runs on the SAME pg.Pool OutboxRelay uses, so it honors any per-tenant
 * `search_path` schema isolation already wired into that pool.
 *
 * Exposed for standalone use (its own start()/stop()), but OutboxRelay's
 * `retention` option does not call those — it drives sweepOnce() itself on
 * its own leader-gated timer, so only the elected leader ever sweeps.
 *
 * Best-effort by design: a failed sweep logs and returns 0 — it must never
 * crash the service (the table merely grows until the next successful sweep).
 */
export interface OutboxRetentionOptions {
    pool: Pool;
    logger: ILogger;
    /** Archive outbox_event rows published more than this many days ago. Must be > 0. Default: 7. */
    retentionDays?: number;
    /** Max rows moved per sweep. Default: 1000. */
    batchSize?: number;
    /** Sweep cadence for the standalone start()/stop() timer. Default: 1h. */
    intervalMs?: number;
}

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1h

export class OutboxRetention {
    private readonly pool: Pool;
    private readonly logger: ILogger;
    private readonly retentionDays: number;
    private readonly batchSize: number;
    private readonly intervalMs: number;
    private timer: NodeJS.Timeout | null = null;

    constructor(opts: OutboxRetentionOptions) {
        const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
        if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
            throw new Error(
                `OutboxRetention: retentionDays must be > 0 (got ${retentionDays}); ` +
                    'a 0/negative TTL would archive rows the relay may not have finished publishing.',
            );
        }
        this.pool = opts.pool;
        this.logger = opts.logger;
        this.retentionDays = retentionDays;
        this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
        this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    }

    /**
     * Move up to `batchSize` published rows older than the TTL into
     * outbox_event_archive. Returns the number archived. The sweep only
     * touches `published_at IS NOT NULL` rows, disjoint from the relay's own
     * `published_at IS NULL` poll, so it never contends with the relay for
     * row locks.
     *
     * Best-effort: errors are logged and swallowed (returns 0).
     */
    async sweepOnce(): Promise<number> {
        try {
            const result = await this.pool.query(
                `WITH moved AS (
                    DELETE FROM outbox_event
                    WHERE event_id IN (
                        SELECT event_id FROM outbox_event
                        WHERE published_at IS NOT NULL
                          AND published_at < now() - make_interval(days => $1)
                        ORDER BY published_at
                        LIMIT $2
                    )
                    RETURNING *
                )
                INSERT INTO outbox_event_archive
                SELECT * FROM moved`,
                [this.retentionDays, this.batchSize],
            );
            const archived = result.rowCount ?? 0;
            if (archived > 0) {
                this.logger.info(
                    `[outbox-retention] archived ${archived} row(s) published more than ${this.retentionDays}d ago`,
                );
            }
            return archived;
        } catch (err) {
            this.logger.error(
                '[outbox-retention] sweep failed (best-effort; will retry next interval)',
                err instanceof Error ? err : undefined,
            );
            return 0;
        }
    }

    /** Sweep immediately, then every `intervalMs`. Idempotent. */
    start(): void {
        if (this.timer) return;
        void this.sweepOnce();
        this.timer = setInterval(() => {
            void this.sweepOnce();
        }, this.intervalMs);
        this.timer.unref?.();
        this.logger.info(
            `[outbox-retention] started — TTL ${this.retentionDays}d, batch ${this.batchSize}, every ${Math.round(this.intervalMs / 1000)}s`,
        );
    }

    /** Stop the interval. Safe to call when not started. */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
